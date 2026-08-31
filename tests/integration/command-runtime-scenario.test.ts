import { describe, expect, test } from "bun:test";

import {
    makeMultiIssueRuntimeHarness,
    multiIssueRuntimeOracle,
    type CommandRuntimeRunCapture,
} from "./command-runtime-harness.ts";
const ANSI_CURSOR_CONTROL =
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])/;

const capturedText = (capture: CommandRuntimeRunCapture): string =>
    capture.stdout.join("") + capture.stderr.join("");

const expectPlainOutputContract = (capture: CommandRuntimeRunCapture): void => {
    const output = capturedText(capture);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toEndWith("\n");
    expect(output).not.toContain("\r");
    expect(output).not.toMatch(ANSI_CURSOR_CONTROL);
    expect(output).toContain("[owner/repository]");
    expect(output).toContain("[1/2] #101");
    expect(output).toContain("[2/2] #102");
    expect(output).toContain("Implementing changes");
    expect(output).toContain("Addressing review findings");
    expect(output).toContain("(1/2)");
    expect(output).toContain("(2/2)");
    expect(output).toContain("attempt 1/2");
    expect(output).toContain("attempt 2/2");
    expect(output).toContain("issue 1/2 · #101 · Implementing changes");
    expect(output).toContain("│  ⋯ thinking");
    expect(output).toContain("│  read README.md");
    expect(output).toContain("│  ✦ assistant");
    expect(output).toContain("retrying Pi request · attempt 2/3");
    expect(
        capture.displayStates.some(
            (state) =>
                state.issue?.number === 101 &&
                state.issue.current === 1 &&
                state.issue.total === 2 &&
                state.activityLabel === "Thinking",
        ),
    ).toBe(true);
    expect(
        capture.displayStates.some(
            (state) =>
                state.issue?.number === 101 &&
                state.issue.current === 1 &&
                state.issue.total === 2 &&
                state.activityLabel === "Using read",
        ),
    ).toBe(true);
    for (const activityLabel of [
        "Thinking",
        "Responding",
        "Using read",
        "Retrying",
    ]) {
        expect(
            capture.displayStates.some(
                (state) => state.activityLabel === activityLabel,
            ),
        ).toBe(true);
    }
    expect(
        capture.displayStates.some(
            (state) =>
                state.issue?.number === 102 &&
                state.issue.current === 2 &&
                state.issue.total === 2,
        ),
    ).toBe(true);
};

const expectSecretAbsentFromStreams = (
    capture: CommandRuntimeRunCapture,
): void => {
    for (const stream of [capture.stdout, capture.stderr]) {
        expect(stream.join("")).not.toContain(multiIssueRuntimeOracle.secret);
    }
};

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

    test("verifies plain, CI/plain, and quiet output contracts through runCommand", async () => {
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
                expectSecretAbsentFromStreams(capture);
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
            expect(plain).toBeDefined();
            expect(ci).toBeDefined();
            expect(quiet).toBeDefined();
            expectPlainOutputContract(plain!);
            expectPlainOutputContract(ci!);
            expect(ci!.stdout).toEqual(plain!.stdout);
            expect(ci!.stderr).toEqual(plain!.stderr);

            const expectedQuietOutput =
                "✗ [owner/repository] [1/2] (1/2) #101 Review found a defect involving [REDACTED]\n" +
                "✗ [owner/repository] [2/2] #102 Second queued issue failed verification.\n";
            expect(quiet!.stdout).toEqual([]);
            expect(quiet!.stderr.join("")).toBe(expectedQuietOutput);
            expect(quiet!.stderr.join("").trimEnd().split("\n")).toEqual([
                "✗ [owner/repository] [1/2] (1/2) #101 Review found a defect involving [REDACTED]",
                "✗ [owner/repository] [2/2] #102 Second queued issue failed verification.",
            ]);

            expect(json).toBeDefined();
            expect(json!.stderr).toEqual([]);
            const jsonRecords = json!.stdout.map((line) => JSON.parse(line));
            expect(jsonRecords).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: "pi_event" }),
                    expect.objectContaining({ status: "failed" }),
                ]),
            );
        } finally {
            await harness.cleanup();
        }

        for (const path of harness.eventLogPaths) {
            expect(await Bun.file(path).exists()).toBe(false);
        }
    });
});
