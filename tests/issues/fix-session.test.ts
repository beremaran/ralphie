import { describe, expect, test } from "bun:test";

import { sessionsFor } from "../shared/agent-sessions.ts";
import { makeFakeHarness } from "../shared/fake-harness.ts";
import {
    FIX_SESSION_CONTEXT_CHARS,
    newFixSession,
    recordFixTurn,
    runFix,
} from "../../src/issues/app/fix-session.ts";

const request = (reasons: string[]) => ({
    directory: "/work/repository",
    title: "Fix",
    resumePrompt: "resume",
    freshPrompt: "fresh",
    onFreshSession: async (reason: string) => {
        reasons.push(reason);
    },
});

const recorded = (harness: string, consumedChars = 1) => {
    const fix = newFixSession(harness);
    recordFixTurn(fix, { sessionID: "s1", consumedChars, resumed: false });
    return fix;
};

describe("runFix", () => {
    test("resumes the recorded session", async () => {
        const fake = makeFakeHarness({
            roles: { fixer: { text: "done", harnessSessionID: "s2" } },
        });
        const fix = recorded("claude", 10);
        const reasons: string[] = [];
        await runFix(sessionsFor(fake.service), fix, request(reasons));
        expect(fake.requests[0]?.resumeSessionID).toBe("s1");
        expect(fake.requests[0]?.prompt).toBe("resume");
        expect(fix.sessionID).toBe("s2");
        expect(reasons).toEqual([]);
    });

    test("starts fresh when the implementer reported no session", async () => {
        const fake = makeFakeHarness({ roles: { fixer: { text: "done" } } });
        const reasons: string[] = [];
        await runFix(
            sessionsFor(fake.service),
            newFixSession("claude"),
            request(reasons),
        );
        expect(fake.requests[0]?.resumeSessionID).toBeUndefined();
        expect(fake.requests[0]?.prompt).toBe("fresh");
        expect(reasons).toEqual([]);
    });

    test("starts fresh when the session is near its context limit", async () => {
        const fake = makeFakeHarness({
            roles: { fixer: { text: "done", harnessSessionID: "s2" } },
        });
        const fix = recorded("claude", FIX_SESSION_CONTEXT_CHARS);
        const reasons: string[] = [];
        await runFix(sessionsFor(fake.service), fix, request(reasons));
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]?.resumeSessionID).toBeUndefined();
        expect(reasons[0]).toContain("context limit");
        expect(fix.sessionID).toBe("s2");
        expect(fix.consumedChars).toBeLessThan(FIX_SESSION_CONTEXT_CHARS);
    });

    test("starts fresh when the fixer runs on another harness", async () => {
        const fake = makeFakeHarness({ roles: { fixer: { text: "done" } } });
        const reasons: string[] = [];
        await runFix(
            sessionsFor(fake.service),
            recorded("codex"),
            request(reasons),
        );
        expect(fake.requests[0]?.resumeSessionID).toBeUndefined();
        expect(reasons[0]).toContain("different harness");
    });

    test("falls back when the resume fails and surfaces a fresh failure", async () => {
        const fake = makeFakeHarness({
            roles: {
                fixer: (req) =>
                    req.resumeSessionID === undefined
                        ? { failure: { kind: "timeout", message: "late" } }
                        : { failure: { kind: "harness", message: "gone" } },
            },
        });
        const reasons: string[] = [];
        await expect(
            runFix(
                sessionsFor(fake.service),
                recorded("claude"),
                request(reasons),
            ),
        ).rejects.toThrow("late");
        expect(fake.requests).toHaveLength(2);
        expect(reasons[0]).toContain("gone");
    });
});