import { describe, expect, test } from "bun:test";

import {
    classifyFailure,
    isHaltingFailure,
    kindForStatus,
    resetHint,
} from "../../src/harness/failure-classification.ts";
import { makeHarnessService } from "../../src/harness/app/harness-service.ts";
import type {
    HarnessFailureKind,
    SessionRequest,
} from "../../src/harness/ports.ts";
import { makeScriptedAdapter } from "./scripted-adapter.ts";

const classify = (message: string, kind: HarnessFailureKind = "harness") =>
    classifyFailure({ kind, message }).kind;

describe("failure classification", () => {
    const transient = [
        "You've hit your session limit · resets 3:10pm",
        "Claude AI usage limit reached",
        "429 Too Many Requests",
        '429: {"type":"rate_limit_error","message":"slow down"}',
        "exceeded retry limit, last status: 429",
        "Overloaded",
        "529: overloaded_error",
        "HTTP 503 Service Unavailable",
        "status 502 Bad Gateway",
        "request failed: ECONNRESET",
        "getaddrinfo ENOTFOUND api.anthropic.com",
        "fetch failed",
        "You exceeded your current quota",
        "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    ];
    for (const message of transient) {
        test(`transient: ${message}`, () => {
            expect(classify(message)).toBe("transient");
            expect(classify(message, "exit")).toBe("transient");
        });
    }

    const auth = [
        "Not logged in · Please run /login",
        "401 Unauthorized",
        "Invalid API key",
        "OAuth token has expired",
        "An active OpenCode Go subscription is required to use Go models.",
    ];
    for (const message of auth) {
        test(`auth: ${message}`, () => {
            expect(classify(message)).toBe("auth");
        });
    }

    const definite = [
        "schema never validated",
        "There's an issue with the selected model (x). It may not exist.",
        "Codex reported a failure.",
        "tool call was refused",
        "404 model_not_found",
    ];
    for (const message of definite) {
        test(`definite: ${message}`, () => {
            expect(classify(message)).toBe("harness");
        });
    }

    test("kinds the harness named stay as they are", () => {
        expect(classify("429 rate limit", "timeout")).toBe("timeout");
        expect(classify("rate limit", "invalid_result")).toBe("invalid_result");
        expect(classify("401 Unauthorized", "model")).toBe("model");
    });

    test("only transient and auth halt the run", () => {
        expect(isHaltingFailure({ kind: "transient" })).toBe(true);
        expect(isHaltingFailure({ kind: "auth" })).toBe(true);
        expect(isHaltingFailure({ kind: "harness" })).toBe(false);
        expect(isHaltingFailure({ kind: "timeout" })).toBe(false);
    });

    test("reads the reset time out of a limit message", () => {
        expect(resetHint("You've hit your session limit · resets 3:10pm")).toBe(
            "3:10pm",
        );
        expect(resetHint("limit reached, resets at 5am (UTC).")).toBe("5am");
        expect(resetHint("rate limited")).toBeUndefined();
        expect(
            classifyFailure({
                kind: "harness",
                message: "session limit · resets 3:10pm",
            }).resetHint,
        ).toBe("3:10pm");
    });

    test("classifies HTTP statuses", () => {
        expect(kindForStatus(429)).toBe("transient");
        expect(kindForStatus(503)).toBe("transient");
        expect(kindForStatus(401)).toBe("auth");
        expect(kindForStatus(404)).toBeUndefined();
        expect(kindForStatus(undefined)).toBeUndefined();
    });
});

describe("the harness service classifies adapter failures", () => {
    const request: SessionRequest = {
        role: "implementer",
        harness: "scripted",
        prompt: "go",
        directory: "/work/repo",
        access: "safe",
        timeoutMs: 1000,
    };

    test.each([
        ["codex", "exceeded retry limit, last status: 429 Too Many Requests"],
        ["pi", "429: rate_limit_error"],
        ["opencode", "Insufficient credits"],
    ])("a %s style limit message becomes transient", async (_name, message) => {
        const { adapter } = makeScriptedAdapter({
            nativeSchema: false,
            turns: [
                {
                    outcome: {
                        ok: false,
                        failure: { kind: "harness", message },
                    },
                },
            ],
        });
        const service = makeHarnessService({
            adapters: { scripted: adapter },
            listener: () => {},
            ids: { next: () => "s1" },
        });
        const outcome = await service.run(request);
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "transient" },
        });
    });
});