import { describe, expect, test } from "bun:test";

import { DEFAULT_BREADCRUMB_THRESHOLD } from "../../src/progress/breadcrumb.ts";
import type {
    ProgressCoordinator,
    ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import {
    makeScenarioCoordinator,
    parsePtyScenarioArgs,
    type PtyScenarioOptions,
} from "./pty-driver-child.ts";

const ALL_OPTIONS: PtyScenarioOptions = {
    columns: 120,
    rows: 40,
    issueCurrent: 2,
    issueTotal: 5,
    issueNumber: 195,
    repository: "acme/widgets",
    attempt: 2,
    maxAttempts: 4,
    threshold: 12,
};

describe("PTY scenario CLI options", () => {
    test("parses every scenario option from the command line", () => {
        expect(
            parsePtyScenarioArgs([
                "--workspace",
                "/tmp/pty-workspace",
                "--scenario",
                "smoke",
                "--columns",
                "120",
                "--rows",
                "40",
                "--issue-current",
                "2",
                "--issue-total",
                "5",
                "--issue-number",
                "195",
                "--repository",
                "acme/widgets",
                "--attempt",
                "2",
                "--max-attempts",
                "4",
                "--threshold",
                "12",
            ]),
        ).toEqual(ALL_OPTIONS);
    });

    test("applies defaults when options are absent", () => {
        expect(
            parsePtyScenarioArgs(["--workspace", "/tmp/pty-workspace"]),
        ).toEqual({
            columns: 100,
            rows: 30,
            issueCurrent: 1,
            issueTotal: 1,
            issueNumber: 423,
            repository: "owner/repository",
            attempt: 1,
            maxAttempts: 3,
            threshold: DEFAULT_BREADCRUMB_THRESHOLD,
        } satisfies PtyScenarioOptions);
    });

    test("rejects invalid option values", () => {
        const invalidArgs = [
            ["--columns", "0"],
            ["--columns", "abc"],
            ["--rows", "1.5"],
            ["--issue-current", "-1"],
            ["--issue-total", ""],
            ["--issue-number", "42x"],
            ["--attempt", "0"],
            ["--max-attempts", "-3"],
            ["--threshold", "0"],
            ["--repository", ""],
            ["--repository", "   "],
            ["--columns"],
            ["--bogus", "1"],
        ] as const;
        for (const args of invalidArgs) {
            expect(() => parsePtyScenarioArgs([...args])).toThrow();
        }
    });

    test("makeScenarioCoordinator injects the configured rendered-line threshold", () => {
        const received: ProgressCoordinatorOptions[] = [];
        const base = (
            options: ProgressCoordinatorOptions,
        ): ProgressCoordinator => {
            received.push(options);
            return {} as ProgressCoordinator;
        };

        makeScenarioCoordinator(
            base,
            ALL_OPTIONS.threshold,
        )({
            mode: "plain",
            verbose: false,
            width: () => 80,
            colors: false,
            runId: "pty-run",
            eventLogPath: "/tmp/pty-events.jsonl",
            renderedLineThreshold: 99,
        });

        expect(received).toHaveLength(1);
        expect(received[0]?.renderedLineThreshold).toBe(ALL_OPTIONS.threshold);
        expect(received[0]?.mode).toBe("plain");
        expect(received[0]?.runId).toBe("pty-run");
    });
});