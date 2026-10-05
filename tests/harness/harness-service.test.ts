import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { makeHarnessService } from "../../src/harness/app/harness-service.ts";
import type {
    SessionEvent,
    SessionEventContext,
    SessionRequest,
    TurnOutcome,
} from "../../src/harness/ports.ts";
import {
    harnessServiceContract,
    type ScriptedReply,
} from "../contracts/harness-service.contract.ts";
import { makeScriptedAdapter, type ScriptedTurn } from "./scripted-adapter.ts";

const toTurn = (reply: ScriptedReply): ScriptedTurn => {
    if ("failure" in reply) {
        return { outcome: { ok: false, failure: reply.failure } };
    }
    return {
        outcome: {
            ok: true,
            harnessSessionID: reply.harnessSessionID,
            text: reply.text ?? "",
            ...(reply.value === undefined ? {} : { structured: reply.value }),
        },
    };
};

const makeIds = () => {
    let next = 0;
    return {
        next: () => {
            next += 1;
            return `session-${next}`;
        },
    };
};

harnessServiceContract({
    name: "native-schema adapter service",
    make: (script) => {
        const delivered: {
            event: SessionEvent;
            context: SessionEventContext;
        }[] = [];
        const { adapter, requests } = makeScriptedAdapter({
            nativeSchema: true,
            turns: script.map(toTurn),
        });
        return {
            service: makeHarnessService({
                adapters: { scripted: adapter },
                listener: (event, context) =>
                    delivered.push({ event, context }),
                ids: makeIds(),
            }),
            events: () => delivered,
            resumeIds: () => requests.map((turn) => turn.resumeSessionID),
        };
    },
});

const request: SessionRequest = {
    role: "implementer",
    harness: "scripted",
    prompt: "Implement the issue",
    directory: "/work/repo",
    access: "safe",
    timeoutMs: 60_000,
    env: { GH_TOKEN: undefined },
    model: "m",
    effort: "high",
    maxBudgetUsd: 2,
};

const resultSchema = z.object({
    status: z.enum(["done", "hand_off"]),
    summary: z.string(),
});

const reply = (text: string, harnessSessionID = "h-1"): ScriptedTurn => ({
    outcome: { ok: true, harnessSessionID, text },
});

const fenced = (value: unknown): string =>
    `All done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

const makeService = (
    adapterInput: Parameters<typeof makeScriptedAdapter>[0],
    options: { readonly maxResultCorrections?: number } = {},
) => {
    const scripted = makeScriptedAdapter(adapterInput);
    const delivered: { event: SessionEvent; context: SessionEventContext }[] =
        [];
    const service = makeHarnessService({
        adapters: { scripted: scripted.adapter },
        listener: (event, context) => delivered.push({ event, context }),
        ids: makeIds(),
        ...options,
    });
    return { service, delivered, requests: scripted.requests };
};

describe("harness service session setup", () => {
    test("passes the session settings through to the adapter turn", async () => {
        const { service, requests } = makeService({
            nativeSchema: true,
            turns: [reply("ok")],
        });
        await service.run(request);
        expect(requests[0]).toMatchObject({
            prompt: "Implement the issue",
            directory: "/work/repo",
            access: "safe",
            timeoutMs: 60_000,
            env: { GH_TOKEN: undefined },
            model: "m",
            effort: "high",
            maxBudgetUsd: 2,
        });
    });

    test("fails as unavailable when no adapter has the requested name", async () => {
        const { service, delivered } = makeService({
            nativeSchema: true,
            turns: [reply("ok")],
        });
        const outcome = await service.run({ ...request, harness: "codex" });
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "unavailable" },
        });
        expect(delivered.at(-1)?.event).toEqual({ type: "session_finished" });
    });

    test("forwards adapter events with the session context", async () => {
        const { service, delivered } = makeService({
            nativeSchema: true,
            turns: [
                {
                    ...reply("ok"),
                    events: [
                        {
                            type: "assistant_text",
                            kind: "text",
                            text: "hi",
                            done: true,
                        },
                    ],
                },
            ],
        });
        await service.run(request);
        expect(delivered.map(({ event }) => event.type)).toEqual([
            "session_started",
            "assistant_text",
            "session_finished",
        ]);
        expect(delivered[1]?.context.sessionID).toBe("session-1");
    });
});

describe("native structured results", () => {
    test("gives the adapter the JSON Schema and no format instructions", async () => {
        const { service, requests } = makeService({
            nativeSchema: true,
            turns: [
                {
                    outcome: {
                        ok: true,
                        harnessSessionID: "h",
                        text: "",
                        structured: { status: "done", summary: "s" },
                    },
                },
            ],
        });
        await service.run({ ...request, resultSchema });
        expect(requests[0]?.jsonSchema).toMatchObject({
            type: "object",
            required: ["status", "summary"],
        });
        expect(requests[0]?.prompt).toBe("Implement the issue");
    });

    test("omits the $schema keyword, which some harness validators cannot resolve", async () => {
        const { service, requests } = makeService({
            nativeSchema: true,
            turns: [reply("ok")],
        });
        await service.run({ ...request, resultSchema });
        expect(requests[0]?.jsonSchema).toBeDefined();
        expect(requests[0]?.jsonSchema).not.toHaveProperty("$schema");
    });

    test("resumes the session with the validation error when the value is invalid", async () => {
        const { service, requests } = makeService({
            nativeSchema: true,
            turns: [
                {
                    outcome: {
                        ok: true,
                        harnessSessionID: "h-1",
                        text: "",
                        structured: { status: "finished", summary: "s" },
                    },
                },
                {
                    outcome: {
                        ok: true,
                        harnessSessionID: "h-1",
                        text: "",
                        structured: { status: "done", summary: "fixed" },
                    },
                },
            ],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(outcome).toMatchObject({
            ok: true,
            value: { status: "done", summary: "fixed" },
        });
        expect(requests[1]?.resumeSessionID).toBe("h-1");
        expect(requests[1]?.prompt).toContain("status");
        expect(requests[1]?.jsonSchema).toBeDefined();
    });
});

describe("fallback structured results", () => {
    const options = { nativeSchema: false } as const;

    test("asks for a final JSON block and reads the last one", async () => {
        const { service, requests } = makeService({
            ...options,
            turns: [
                reply(
                    `${fenced({ status: "hand_off", summary: "draft" })}\nActually:\n${fenced({ status: "done", summary: "final" })}`,
                ),
            ],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(outcome).toMatchObject({
            ok: true,
            value: { status: "done", summary: "final" },
        });
        expect(requests[0]?.jsonSchema).toBeUndefined();
        expect(requests[0]?.prompt).toContain("Implement the issue");
        expect(requests[0]?.prompt).toContain("```json");
        expect(requests[0]?.prompt).toContain("hand_off");
    });

    test("resumes the same session with the validation error, then succeeds", async () => {
        const { service, requests } = makeService({
            ...options,
            turns: [
                reply(fenced({ status: "finished", summary: "s" }), "h-1"),
                reply(fenced({ status: "done", summary: "s" }), "h-1"),
            ],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(outcome).toMatchObject({ ok: true, harnessSessionID: "h-1" });
        expect(requests).toHaveLength(2);
        expect(requests[1]?.resumeSessionID).toBe("h-1");
        expect(requests[1]?.prompt).toContain("status");
        expect(requests[1]?.prompt).toContain("```json");
    });

    test("treats a missing JSON block and malformed JSON as invalid", async () => {
        const { service, requests } = makeService({
            ...options,
            turns: [
                reply("I am done, no block."),
                reply("```json\n{not json\n```"),
                reply(fenced({ status: "done", summary: "s" })),
            ],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(outcome.ok).toBe(true);
        expect(requests[1]?.prompt).toContain("JSON block");
        expect(requests[2]?.prompt).toContain("JSON");
    });

    test("fails closed after a bounded number of corrections", async () => {
        const { service, requests } = makeService(
            { ...options, turns: [reply("never any JSON")] },
            { maxResultCorrections: 2 },
        );
        const outcome = await service.run({ ...request, resultSchema });
        expect(requests).toHaveLength(3);
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "invalid_result", harnessSessionID: "h-1" },
        });
    });

    test("does not resume when the harness reported no session id", async () => {
        const turn: TurnOutcome = {
            ok: true,
            harnessSessionID: undefined,
            text: "no json",
        };
        const { service, requests } = makeService({
            ...options,
            turns: [{ outcome: turn }],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(requests).toHaveLength(1);
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "invalid_result" },
        });
    });

    test("surfaces a failure of the correction turn", async () => {
        const { service } = makeService({
            ...options,
            turns: [
                reply("no json"),
                {
                    outcome: {
                        ok: false,
                        failure: { kind: "timeout", message: "late" },
                    },
                },
            ],
        });
        const outcome = await service.run({ ...request, resultSchema });
        expect(outcome).toEqual({
            ok: false,
            failure: { kind: "timeout", message: "late" },
        });
    });

    test("keeps one started and one finished event across corrections", async () => {
        const { service, delivered } = makeService({
            ...options,
            turns: [
                reply("no json"),
                reply(fenced({ status: "done", summary: "s" })),
            ],
        });
        await service.run({ ...request, resultSchema });
        const types = delivered.map(({ event }) => event.type);
        expect(types.filter((type) => type === "session_started")).toHaveLength(
            1,
        );
        expect(
            types.filter((type) => type === "session_finished"),
        ).toHaveLength(1);
    });
});