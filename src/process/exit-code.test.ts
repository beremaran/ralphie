import { describe, expect, test } from "bun:test";

import { exitCodeForFailure, RalphieExitCode } from "./exit-code.ts";

describe("process exit codes", () => {
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
