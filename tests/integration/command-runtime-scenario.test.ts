import { describe, expect, test } from "bun:test";

import {
    makeMultiIssueRuntimeHarness,
    multiIssueRuntimeOracle,
} from "./command-runtime-harness.ts";

describe("multi-issue command/runtime scenario oracle", () => {
    test("describes both source streams and the complete display-state sequence", () => {
        const oracle = multiIssueRuntimeOracle;
        const progressMessages = oracle.progressEvents.map(
            ({ message }) => message,
        );
        const progressDetails = oracle.progressEvents.flatMap(({ details }) =>
            details === undefined ? [] : [details],
        );
        const issueNumbers = oracle.progressEvents.flatMap(({ issue }) =>
            issue === undefined ? [] : [issue.number],
        );

        expect(
            progressMessages.some((message) => message.includes(oracle.secret)),
        ).toBe(true);
        expect(progressDetails).toContainEqual(
            expect.objectContaining({ secret: oracle.secret }),
        );
        expect(new Set(issueNumbers)).toEqual(new Set([101, 102]));
        expect(oracle.progressEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ status: "succeeded" }),
                expect.objectContaining({ status: "failed" }),
            ]),
        );
        expect(oracle.piEvents.length).toBeGreaterThan(8);
        expect(oracle.piEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    context: expect.objectContaining({
                        sessionID: "scenario-session-101",
                    }),
                }),
            ]),
        );
        expect(oracle.expectedDisplayStates).toHaveLength(
            oracle.emissions.length + 1,
        );
        expect(
            oracle.expectedDisplayStates.some(
                (state) => state.activity === "thinking",
            ),
        ).toBe(true);
        expect(
            oracle.expectedDisplayStates.some(
                (state) => state.activity === "responding",
            ),
        ).toBe(true);
        expect(
            oracle.expectedDisplayStates.some(
                (state) => state.activityLabel === "Using read",
            ),
        ).toBe(true);
        expect(
            oracle.expectedDisplayStates.some(
                (state) => state.activity === "retrying",
            ),
        ).toBe(true);
        expect(
            oracle.expectedDisplayStates.some(
                (state) => state.stage === "review-fix",
            ),
        ).toBe(true);
    });

    test("runs every non-interactive mode through runCommand and captures an oracle", async () => {
        const harness = makeMultiIssueRuntimeHarness();
        try {
            for (const mode of ["default", "ci", "quiet", "json"] as const) {
                await harness.runMode(mode);
            }

            expect(harness.runCaptures).toHaveLength(4);
            expect(harness.eventLogPaths).toHaveLength(4);
            for (const capture of harness.runCaptures) {
                expect(capture.displayStates).toEqual([
                    ...multiIssueRuntimeOracle.expectedDisplayStates,
                ]);
                expect(capture.piEvents).toEqual([
                    ...multiIssueRuntimeOracle.piEvents,
                ]);
                expect(capture.eventLogPath).toBeString();
                expect(
                    await Bun.file(capture.eventLogPath ?? "").exists(),
                ).toBe(true);
                const log = await harness.readEventLog(capture.eventLogPath);
                const events = log
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as Record<string, unknown>);
                expect(events).toHaveLength(
                    multiIssueRuntimeOracle.progressEvents.length,
                );
                expect(log).not.toContain(multiIssueRuntimeOracle.secret);
            }

            const [plain, ci, quiet, json] = harness.runCaptures;
            expect(plain?.stderr.join(" ")).toContain("owner/repository");
            expect(plain?.stderr.join(" ")).toContain("[1/2]");
            expect(plain?.stderr.join(" ")).toContain("[2/2]");
            expect(plain?.stderr.join(" ")).toContain("attempt 2/2");
            expect(plain?.stderr.join(" ")).toContain("Implementing changes");
            expect(plain?.stderr.join(" ")).toContain("read README.md");
            expect(
                plain?.displayStates.some(
                    (state) => state.activityLabel === "Using read",
                ),
            ).toBe(true);
            expect(ci?.stderr).toEqual(plain?.stderr);
            expect(quiet?.stdout).toEqual([]);
            expect(quiet?.stderr.join(" ")).toContain("failed");
            expect(json?.stderr).toEqual([]);
            const jsonRecords =
                json?.stdout.map((line) => JSON.parse(line)) ?? [];
            expect(jsonRecords).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: "pi_event" }),
                    expect.objectContaining({ status: "failed" }),
                ]),
            );
            expect(json?.stdout.join(" ")).not.toContain(
                multiIssueRuntimeOracle.secret,
            );
        } finally {
            await harness.cleanup();
        }

        for (const path of harness.eventLogPaths) {
            expect(await Bun.file(path).exists()).toBe(false);
        }
    });
});
