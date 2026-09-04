import { describe, expect, test } from "bun:test";

import { TRUNCATION_MARKER_KEY } from "../../src/github/evidence-budget.ts";
import { MAX_RAW_EVIDENCE } from "../../src/github/pipeline-diagnostics-contracts.ts";
import { classifyDiagnosticError } from "../../src/github/pipeline-diagnostics-errors.ts";
import type { PipelineSourceError } from "../../src/github/pipeline-snapshot.ts";

/**
 * Build an Octokit RequestError-shaped failure: an Error carrying `status`
 * and a `response` envelope with optional rate-limit headers.
 */
const transportError = (
    status: number | undefined,
    headers: Record<string, string> | undefined,
    message = "GitHub request failed.",
): unknown =>
    Object.assign(new Error(message), {
        ...(status === undefined ? {} : { status }),
        response: {
            ...(status === undefined ? {} : { status }),
            ...(headers === undefined ? {} : { headers }),
            data: { message },
        },
    });

describe("pipeline diagnostics error classification", () => {
    test("missing endpoint classifies as unavailable with source and message", () => {
        const error = classifyDiagnosticError({
            source: "github.jobs",
            disposition: "unavailable",
            message: "github.jobs endpoint is not callable.",
        });
        expect(error.disposition).toBe("unavailable");
        expect(error.source).toBe("github.jobs");
        expect(error.message).toBe("github.jobs endpoint is not callable.");
        expect(error.rateLimit).toBeUndefined();
        expect(JSON.stringify(error.rawValues).length).toBeLessThanOrEqual(
            MAX_RAW_EVIDENCE,
        );
    });

    test("malformed payload classifies as malformed and keeps partial evidence", () => {
        const error = classifyDiagnosticError({
            source: "github.jobs",
            disposition: "malformed",
            message:
                "github.jobs response did not contain the expected jobs array.",
            evidence: [{ id: 1, name: "build" }],
        });
        expect(error.disposition).toBe("malformed");
        expect(error.message).toBe(
            "github.jobs response did not contain the expected jobs array.",
        );
        expect(error.rawValues).toEqual([{ id: 1, name: "build" }]);
        expect(error.rateLimit).toBeUndefined();
    });

    test("Octokit 403 with rate-limit headers classifies as rate-limited with metadata", () => {
        const cause = transportError(
            403,
            {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1700000000",
                "retry-after": "60",
            },
            "API rate limit exceeded",
        );
        const error = classifyDiagnosticError({ source: "github.jobs", cause });
        expect(error.disposition).toBe("rate-limited");
        expect(error.source).toBe("github.jobs");
        expect(error.message).toBe("API rate limit exceeded");
        expect(error.rateLimit).toEqual({
            retryAfterMs: 60_000,
            resetAtMs: 1_700_000_000_000,
            remaining: 0,
        });
    });

    test("errors recognized by rateLimitFromUnknown classify as rate-limited", () => {
        const cause = transportError(undefined, { "retry-after": "30" });
        const error = classifyDiagnosticError({
            source: "github.check-runs",
            cause,
        });
        expect(error.disposition).toBe("rate-limited");
        expect(error.rateLimit).toEqual({ retryAfterMs: 30_000 });
    });

    test("5xx server errors classify as unavailable while preserving partial evidence", () => {
        const cause = transportError(
            503,
            undefined,
            "GitHub is having a problem",
        );
        const error = classifyDiagnosticError({
            source: "github.steps",
            cause,
            evidence: [{ number: 1, name: "checkout" }],
        });
        expect(error.disposition).toBe("unavailable");
        expect(error.disposition).not.toBe("ok");
        expect(error.source).toBe("github.steps");
        expect(error.message).toBe("GitHub is having a problem");
        expect(error.rawValues).toEqual([{ number: 1, name: "checkout" }]);
        expect(error.rateLimit).toBeUndefined();
    });

    test("evidence over the shared budget classifies as truncated with bounded rawValues", () => {
        const verbose = { log: "x".repeat(MAX_RAW_EVIDENCE * 2) };
        const error = classifyDiagnosticError({
            source: "github.annotations",
            cause: undefined,
            evidence: verbose,
        });
        expect(error.disposition).toBe("truncated");
        expect(error.rawValues).toEqual({
            log: { [TRUNCATION_MARKER_KEY]: 1 },
        });
        expect(JSON.stringify(error.rawValues).length).toBeLessThanOrEqual(
            MAX_RAW_EVIDENCE,
        );
        // The unbounded original payload is never embedded.
        expect(JSON.stringify(error.rawValues)).not.toContain("x".repeat(64));
        expect(error.source).toBe("github.annotations");
    });

    test("an explicitly truncated outcome bounds the collected prefix", () => {
        const error = classifyDiagnosticError({
            source: "github.jobs",
            disposition: "truncated",
            message: "github.jobs collection stopped at the jobs-per-run cap.",
            evidence: Array.from({ length: 20 }, (_, index) => ({
                id: index + 1,
            })),
        });
        expect(error.disposition).toBe("truncated");
        expect(error.message).toContain("jobs-per-run cap");
        expect(error.rawValues).toEqual(
            Array.from({ length: 20 }, (_, index) => ({ id: index + 1 })),
        );
    });

    test("failures with nothing to introspect default to unavailable with a message", () => {
        for (const cause of [undefined, new Error("connection reset")]) {
            const error = classifyDiagnosticError({
                source: "github.jobs",
                cause,
            });
            expect(error.disposition).toBe("unavailable");
            expect(error.message).toBe(
                cause instanceof Error
                    ? "connection reset"
                    : "Source is unavailable.",
            );
            expect(error.rateLimit).toBeUndefined();
        }
    });

    test("emitted values stay assignable to the PipelineSourceError shape", () => {
        const error = classifyDiagnosticError({
            source: "github.workflow-run",
            cause: transportError(403, { "x-ratelimit-remaining": "0" }),
            evidence: { status: "completed", conclusion: "failure" },
        });
        const sourceError: PipelineSourceError = error;
        expect(sourceError.source).toBe("github.workflow-run");
        expect(sourceError.message).toBe("GitHub request failed.");
        expect(sourceError.rawValues).toEqual({
            status: "completed",
            conclusion: "failure",
        });
        expect(sourceError.rateLimit).toEqual({ remaining: 0 });
    });
});