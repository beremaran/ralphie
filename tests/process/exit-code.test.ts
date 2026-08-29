import { describe, expect, test } from "bun:test";

import {
    exitCodeForError,
    exitCodeForFailure,
    NeedsAttentionStop,
    RalphieExitCode,
} from "../../src/process/exit-code.ts";

describe("process exit codes", () => {
    test("names the needs-attention exit code", () => {
        expect(RalphieExitCode.NeedsAttention).toBe(2);
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

    test("uses the conventional general failure exit code", () => {
        expect(exitCodeForFailure(new AbortController().signal)).toBe(
            RalphieExitCode.Failure,
        );
    });

    test("uses the conventional shell cancellation exit code", () => {
        const controller = new AbortController();
        controller.abort();
        expect(exitCodeForFailure(controller.signal)).toBe(
            RalphieExitCode.Cancelled,
        );
    });
});