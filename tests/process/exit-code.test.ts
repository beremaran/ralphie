import { describe, expect, test } from "bun:test";

import {
    exitCodeForError,
    exitCodeForFailure,
    NeedsAttentionStop,
    RalphieExitCode,
} from "../../src/process/exit-code.ts";

describe("process exit codes", () => {
    test("defines the exact public process outcomes", () => {
        expect(RalphieExitCode.Success).toBe(0);
        expect(RalphieExitCode.Failure).toBe(1);
        expect(RalphieExitCode.NeedsAttention).toBe(2);
        expect(RalphieExitCode.Cancelled).toBe(130);
    });

    test("maps a handled needs-attention stop separately from failures", () => {
        expect(
            exitCodeForError(
                new NeedsAttentionStop({
                    issueNumber: 42,
                    summary: "missing prerequisite",
                }),
                new AbortController().signal,
            ),
        ).toBe(RalphieExitCode.NeedsAttention);
    });

    test("maps ordinary errors and failure outcomes to exit 1", () => {
        const signal = new AbortController().signal;
        expect(exitCodeForFailure(signal)).toBe(RalphieExitCode.Failure);
        expect(exitCodeForError(new Error("ordinary failure"), signal)).toBe(
            RalphieExitCode.Failure,
        );
    });

    test("cancellation takes precedence and maps every error to exit 130", () => {
        const controller = new AbortController();
        controller.abort();
        const stop = new NeedsAttentionStop({
            issueNumber: 42,
            summary: "missing prerequisite",
        });
        expect(exitCodeForFailure(controller.signal)).toBe(
            RalphieExitCode.Cancelled,
        );
        expect(exitCodeForError(new Error("ordinary"), controller.signal)).toBe(
            RalphieExitCode.Cancelled,
        );
        expect(exitCodeForError(stop, controller.signal)).toBe(
            RalphieExitCode.Cancelled,
        );
    });
});