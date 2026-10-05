import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
    HarnessFailure,
    HarnessService,
    SessionEvent,
    SessionEventContext,
    SessionRequest,
} from "../../src/harness/ports.ts";

/** One scripted harness reply; the last reply repeats once the script ends. */
export type ScriptedReply =
    | {
          readonly value: unknown;
          readonly text?: string;
          readonly harnessSessionID?: string;
      }
    | { readonly failure: HarnessFailure };

export type ServiceFixtures = {
    readonly name: string;
    /** Build a service whose `implementer` role answers with `script`. */
    readonly make: (script: readonly ScriptedReply[]) => {
        readonly service: HarnessService;
        /** Events and contexts delivered to the progress listener. */
        readonly events: () => readonly {
            readonly event: SessionEvent;
            readonly context: SessionEventContext;
        }[];
        /** `resumeSessionID` of every harness invocation, in order. */
        readonly resumeIds: () => readonly (string | undefined)[];
    };
};

const request: SessionRequest = {
    role: "implementer",
    harness: "scripted",
    prompt: "Implement the issue",
    directory: "/work/repo",
    access: "safe",
    timeoutMs: 60_000,
    title: "Issue #7",
};

const resultSchema = z.object({
    status: z.enum(["done", "hand_off"]),
    summary: z.string(),
});

/**
 * Behavior every `HarnessService` must have, whether it is the real service
 * over an adapter or the fake harness used by workflow tests.
 */
export const harnessServiceContract = (fixtures: ServiceFixtures): void => {
    describe(`${fixtures.name} harness service contract`, () => {
        test("returns the validated value, the text and the resumable session id", async () => {
            const { service } = fixtures.make([
                {
                    value: { status: "done", summary: "All good" },
                    text: "final message",
                    harnessSessionID: "harness-1",
                },
            ]);
            const outcome = await service.run({ ...request, resultSchema });
            expect(outcome).toEqual({
                ok: true,
                harnessSessionID: "harness-1",
                text: "final message",
                value: { status: "done", summary: "All good" },
            });
        });

        test("returns the final text without a value when no schema is given", async () => {
            const { service } = fixtures.make([
                { value: undefined, text: "just prose", harnessSessionID: "h" },
            ]);
            const outcome = await service.run(request);
            expect(outcome).toMatchObject({ ok: true, text: "just prose" });
            expect(outcome.ok && outcome.value).toBeUndefined();
        });

        test("surfaces a harness failure as a typed failure", async () => {
            const failure: HarnessFailure = {
                kind: "timeout",
                message: "took too long",
            };
            const { service } = fixtures.make([{ failure }]);
            const outcome = await service.run({ ...request, resultSchema });
            expect(outcome).toEqual({ ok: false, failure });
        });

        test("fails closed when the result never matches the schema", async () => {
            const { service } = fixtures.make([
                { value: { status: "finished" }, harnessSessionID: "h" },
            ]);
            const outcome = await service.run({ ...request, resultSchema });
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.failure.kind).toBe("invalid_result");
            expect(outcome.failure.message).toContain("status");
        });

        test("brackets the session with started and finished events", async () => {
            const { service, events } = fixtures.make([
                { value: { status: "done", summary: "ok" } },
            ]);
            await service.run({ ...request, resultSchema });
            const delivered = events();
            expect(delivered[0]?.event).toEqual({ type: "session_started" });
            expect(delivered.at(-1)?.event).toEqual({
                type: "session_finished",
            });
            const contexts = new Set(
                delivered.map(({ context }) => context.sessionID),
            );
            expect(contexts.size).toBe(1);
            expect(delivered[0]?.context).toMatchObject({
                directory: "/work/repo",
                harness: "scripted",
                title: "Issue #7",
            });
        });

        test("reports a failure as an error event before finishing", async () => {
            const { service, events } = fixtures.make([
                { failure: { kind: "harness", message: "it broke" } },
            ]);
            await service.run({ ...request, resultSchema });
            const delivered = events().map(({ event }) => event);
            expect(delivered).toContainEqual({
                type: "error",
                message: "it broke",
            });
            expect(delivered.at(-1)).toEqual({ type: "session_finished" });
        });

        test("hands the resume id to the harness", async () => {
            const { service, resumeIds } = fixtures.make([
                { value: { status: "done", summary: "ok" } },
            ]);
            await service.run({
                ...request,
                resultSchema,
                resumeSessionID: "earlier",
            });
            expect(resumeIds()[0]).toBe("earlier");
        });
    });
};