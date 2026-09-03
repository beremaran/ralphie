import { describe, expect, test } from "bun:test";

import type { PipelineSourceError } from "../../src/github/pipeline-snapshot.ts";
import type {
    AnnotationRecord,
    CheckContext,
    CollectionResult,
    DiagnosticError,
    JobContext,
    RunIdentity,
    StepRecord,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    MAX_CHECK_ANNOTATIONS,
    MAX_CHECK_OUTPUT_CHARS,
    MAX_JOBS_PER_RUN,
    MAX_PAGINATION_PAGES,
    MAX_RAW_EVIDENCE,
    MAX_STEPS_PER_JOB,
    validateDiagnosticsLimit,
} from "../../src/github/pipeline-diagnostics-contracts.ts";

const ALL_DISPOSITIONS = [
    "ok",
    "malformed",
    "unavailable",
    "truncated",
    "rate-limited",
] as const;

describe("pipeline diagnostics contracts", () => {
    test("unknown JSON fields round-trip through the record types", () => {
        const run: RunIdentity = {
            provider: "github.workflow-run",
            commitSha: "a".repeat(40),
            runId: 918273,
            runAttempt: 2,
            workflowId: 445566,
            head_branch: "main",
            display_title: { nested: [1, null, { deep: "value" }] },
        };
        const job: JobContext = {
            provider: "github.workflow-run",
            runId: 918273,
            runAttempt: 2,
            jobId: 112233,
            rawState: { status: "completed", conclusion: "failure" },
            run_attempt: 2,
            labels: ["ubuntu-latest"],
        };
        const step: StepRecord = {
            name: "Build",
            number: 1,
            conclusion: "failure",
            startedAt: "2026-09-04T00:00:00Z",
            completedAt: "2026-09-04T00:01:00Z",
            started_at: "2026-09-04T00:00:00Z",
            "kebab-case-key": true,
        };
        const check: CheckContext = {
            checkRunId: 556677,
            provider: "github.check-run",
            name: "test",
            rawState: { status: "completed", conclusion: "failure" },
            details_url: "https://example.invalid/details",
            output: { summary: "failed" },
        };
        const annotation: AnnotationRecord = {
            level: "failure",
            message: "assertion failed",
            path: "src/main.ts",
            startLine: 10,
            startColumn: 2,
            endLine: 10,
            endColumn: 8,
            blob_href: "https://example.invalid/blob",
            raw_details: { code: 42 },
        };

        for (const payload of [run, job, step, check, annotation]) {
            const roundTripped = JSON.parse(
                JSON.stringify(payload),
            ) as typeof payload;
            expect(roundTripped).toEqual(payload);
            expect(Object.keys(roundTripped)).toEqual(Object.keys(payload));
        }
    });

    test("unknown JSON fields round-trip through CollectionResult", () => {
        const result: CollectionResult = {
            request: {
                repository: "owner/repo",
                branch: "main",
                commitSha: "b".repeat(40),
            },
            source: "workflow-run",
            records: [],
            truncated: true,
            errors: [],
            extra_top_level: { marker: [1, 2, 3] },
        };
        const roundTripped = JSON.parse(
            JSON.stringify(result),
        ) as CollectionResult;
        expect(roundTripped).toEqual(result);
    });

    test("every exported limit is a positive safe integer", () => {
        const limits = [
            MAX_JOBS_PER_RUN,
            MAX_STEPS_PER_JOB,
            MAX_CHECK_ANNOTATIONS,
            MAX_CHECK_OUTPUT_CHARS,
            MAX_RAW_EVIDENCE,
            MAX_PAGINATION_PAGES,
        ];
        for (const limit of limits) {
            expect(Number.isSafeInteger(limit)).toBe(true);
            expect(limit).toBeGreaterThan(0);
        }
        expect(MAX_PAGINATION_PAGES).toBe(10_000);
    });

    test("limits reject 0, negatives, and non-integers", () => {
        for (const invalid of [
            0,
            -1,
            -25,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() =>
                validateDiagnosticsLimit("MAX_JOBS_PER_RUN", invalid),
            ).toThrow(RangeError);
        }
        expect(validateDiagnosticsLimit("MAX_JOBS_PER_RUN", 20)).toBe(20);
    });

    test("all five dispositions are representable on DiagnosticError", () => {
        for (const disposition of ALL_DISPOSITIONS) {
            const error: DiagnosticError = {
                source: "github.check-run",
                message: "message",
                disposition,
            };
            expect(error.disposition).toBe(disposition);
        }
    });

    test("DiagnosticError is assignable to the PipelineSourceError shape", () => {
        const error: DiagnosticError = {
            source: "github.workflow-run",
            message: "check output truncated",
            disposition: "truncated",
            rawValues: { status: "completed", conclusion: "failure" },
            rateLimit: {
                resetAtMs: 1_700_000_000_000,
                retryAfterMs: 5_000,
                remaining: 0,
            },
        };
        const sourceError: PipelineSourceError = error;
        expect(sourceError.source).toBe(error.source);
        expect(sourceError.message).toBe(error.message);
        expect(sourceError.rawValues).toEqual(error.rawValues);
        expect(sourceError.rateLimit).toEqual(error.rateLimit);
    });
});