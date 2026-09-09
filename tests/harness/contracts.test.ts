import { describe, expect, test } from "bun:test";

import {
    HARNESS_KINDS,
    type HarnessDriver,
    type HarnessFactory,
    type HarnessSession,
} from "../../src/harness/index.ts";

const makeFakeDriver = (): HarnessDriver => {
    const session: HarnessSession = {
        kind: "codex",
        sessionID: "fake-session",
        sendTurn: async () => ({ text: "done" }),
        interrupt: async () => undefined,
        close: async () => undefined,
    };

    return {
        kind: "codex",
        capabilities: {
            resume: true,
            "structured-output": true,
            "model-catalog": false,
            variants: false,
            events: false,
            permissions: false,
        },
        probe: async () => ({
            kind: "codex",
            available: true,
            authenticated: true,
        }),
        validateSelection: async () => undefined,
        createSession: async () => session,
        resumeSession: async () => session,
    };
};

describe("harness contract", () => {
    test("publishes the six supported harness kinds", () => {
        expect(HARNESS_KINDS).toEqual([
            "opencode",
            "codex",
            "claude-code",
            "cursor",
            "grok-build",
            "google-antigravity",
        ]);
    });

    test("supports a fake driver and promise-based factory", async () => {
        const driver = makeFakeDriver();
        const factory: HarnessFactory = {
            create: async ({ kind }) => {
                expect(kind).toBe("codex");
                return driver;
            },
        };
        const created = await factory.create({ kind: "codex" });
        const session = await created.createSession({ directory: "/tmp" });

        expect(await session.sendTurn({ prompt: "hello" })).toEqual({
            text: "done",
        });
        await session.interrupt();
        await session.close();
    });
});