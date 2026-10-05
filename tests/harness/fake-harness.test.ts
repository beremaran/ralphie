import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
    SessionEvent,
    SessionEventContext,
    SessionRequest,
} from "../../src/harness/ports.ts";
import { harnessServiceContract } from "../contracts/harness-service.contract.ts";
import { makeFakeHarness } from "../shared/fake-harness.ts";

harnessServiceContract({
    name: "fake",
    make: (script) => {
        const delivered: {
            event: SessionEvent;
            context: SessionEventContext;
        }[] = [];
        const fake = makeFakeHarness({
            roles: {
                implementer: script.map((reply) =>
                    "failure" in reply
                        ? { failure: reply.failure }
                        : {
                              value: reply.value,
                              ...(reply.text === undefined
                                  ? {}
                                  : { text: reply.text }),
                              ...(reply.harnessSessionID === undefined
                                  ? {}
                                  : {
                                        harnessSessionID:
                                            reply.harnessSessionID,
                                    }),
                          },
                ),
            },
            listener: (event, context) => delivered.push({ event, context }),
        });
        return {
            service: fake.service,
            events: () => delivered,
            resumeIds: () =>
                fake.requests.map((request) => request.resumeSessionID),
        };
    },
});

const base: SessionRequest = {
    role: "implementer",
    harness: "claude",
    prompt: "p",
    directory: "/work/repo",
    access: "safe",
    timeoutMs: 1,
};

describe("fake harness scripting", () => {
    test("answers each role from its own script and records the requests", async () => {
        const fake = makeFakeHarness({
            roles: {
                implementer: { value: { n: 1 } },
                "spec-reviewer": { value: { n: 2 } },
            },
        });
        const schema = z.object({ n: z.number() });
        const first = await fake.service.run({ ...base, resultSchema: schema });
        const second = await fake.service.run({
            ...base,
            role: "spec-reviewer",
            resultSchema: schema,
        });

        expect(first.ok && first.value).toEqual({ n: 1 });
        expect(second.ok && second.value).toEqual({ n: 2 });
        expect(fake.requestsFor("spec-reviewer")).toHaveLength(1);
        expect(fake.requests.map((request) => request.role)).toEqual([
            "implementer",
            "spec-reviewer",
        ]);
    });

    test("plays a role's list in order and repeats the last entry", async () => {
        const fake = makeFakeHarness({
            roles: {
                implementer: [{ text: "first" }, { text: "second" }],
            },
        });
        const texts: string[] = [];
        for (let call = 0; call < 3; call += 1) {
            const outcome = await fake.service.run(base);
            if (outcome.ok) texts.push(outcome.text);
        }
        expect(texts).toEqual(["first", "second", "second"]);
    });

    test("lets a function choose the outcome from the request", async () => {
        const fake = makeFakeHarness({
            roles: {
                implementer: (request, callIndex) => ({
                    text: `${request.prompt}#${callIndex}`,
                }),
            },
        });
        const outcome = await fake.service.run({ ...base, prompt: "hello" });
        expect(outcome.ok && outcome.text).toBe("hello#0");
    });

    test("streams scripted events between started and finished", async () => {
        const seen: string[] = [];
        const fake = makeFakeHarness({
            roles: {
                implementer: {
                    events: [
                        {
                            type: "assistant_text",
                            kind: "text",
                            text: "thinking aloud",
                            done: true,
                        },
                    ],
                },
            },
            listener: (event) => seen.push(event.type),
        });
        await fake.service.run(base);
        expect(seen).toEqual([
            "session_started",
            "assistant_text",
            "session_finished",
        ]);
    });

    test("throws when a role has no scripted response", async () => {
        const fake = makeFakeHarness({ roles: {} });
        await expect(fake.service.run(base)).rejects.toThrow(
            'no response scripted for role "implementer"',
        );
    });
});