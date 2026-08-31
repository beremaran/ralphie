import { describe, expect, test } from "bun:test";

import {
    makeMultiIssueRuntimeHarness,
    multiIssueRuntimeOracle,
    type CommandRuntimeRunCapture,
} from "./command-runtime-harness.ts";
import type { DisplayState } from "../../src/progress/display-state.ts";
import { redactSensitiveValue } from "../../src/shared/redaction.ts";

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

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonLines = (text: string): JsonRecord[] => {
    const records: JsonRecord[] = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const value: unknown = JSON.parse(line);
        if (!isJsonRecord(value)) {
            throw new Error("JSON Lines output contained a non-object record.");
        }
        records.push(value);
    }
    return records;
};

const scenarioTimestamp = "2026-01-02T03:04:05.000Z";

const expectedProgressRecords = (runId: string): JsonRecord[] =>
    multiIssueRuntimeOracle.progressEvents.map((event) => ({
        ...(redactSensitiveValue(event) as JsonRecord),
        runId,
        timestamp: scenarioTimestamp,
    }));

const expectedPiRecord = (
    event: (typeof multiIssueRuntimeOracle.piEvents)[number],
): JsonRecord => ({
    type: "pi_event",
    sessionID: event.context.sessionID,
    directory: event.context.directory,
    ...(event.context.title === undefined
        ? {}
        : { title: event.context.title }),
    event: redactSensitiveValue(event.event),
});

const expectedJsonRecords = (runId: string): JsonRecord[] =>
    multiIssueRuntimeOracle.emissions.map((emission) =>
        emission.kind === "progress"
            ? {
                  ...(redactSensitiveValue(emission.event) as JsonRecord),
                  runId,
                  timestamp: scenarioTimestamp,
              }
            : expectedPiRecord(emission),
    );

const expectJsonOutputContract = (capture: CommandRuntimeRunCapture): void => {
    const stdout = capture.stdout.join("");
    const stderr = capture.stderr.join("");
    expect(stdout).toEndWith("\n");
    expect(capture.stderr).toEqual([]);
    expect(stderr).toBe("");
    expectSecretAbsentFromStreams(capture);

    const records = parseJsonLines(stdout);
    const progressRecords = records.filter(
        (record) => record.type === undefined,
    );
    const piRecords = records.filter((record) => record.type === "pi_event");
    const invalidRecords = records.filter(
        (record) => record.type !== undefined && record.type !== "pi_event",
    );
    expect(invalidRecords).toEqual([]);

    const runId = progressRecords[0]?.runId;
    if (typeof runId !== "string") {
        throw new Error("JSON Lines output did not contain a progress run ID.");
    }
    expect(progressRecords).toEqual(expectedProgressRecords(runId));
    expect(piRecords).toEqual(
        multiIssueRuntimeOracle.piEvents.map(expectedPiRecord),
    );
    expect(records).toEqual(expectedJsonRecords(runId));
};

const expectEventLogContract = (log: string): JsonRecord[] => {
    expect(log).toEndWith("\n");
    const records = parseJsonLines(log);
    const runId = records[0]?.runId;
    if (typeof runId !== "string") {
        throw new Error("Durable event log did not contain a run ID.");
    }
    expect(records).toEqual(expectedProgressRecords(runId));
    return records;
};

const normalizeDurableEvents = (
    records: ReadonlyArray<JsonRecord>,
): JsonRecord[] =>
    records.map(({ runId: _runId, timestamp: _timestamp, ...event }) => event);

const expectNamedDisplayTransitions = (
    capture: CommandRuntimeRunCapture,
): void => {
    const oracle = multiIssueRuntimeOracle;
    const stateAfter = (
        predicate: (emission: (typeof oracle.emissions)[number]) => boolean,
    ): DisplayState => {
        const emissionIndex = oracle.emissions.findIndex(predicate);
        if (emissionIndex < 0) {
            throw new Error("Scenario is missing a named display transition.");
        }
        const state = capture.displayStates[emissionIndex + 1];
        expect(state).toEqual(oracle.expectedDisplayStates[emissionIndex + 1]);
        if (state === undefined) {
            throw new Error("Display state capture ended before the scenario.");
        }
        return state;
    };

    const parentQueue = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.stage === "issue-queue" &&
            emission.event.issue?.number === 101,
    );
    expect(parentQueue).toMatchObject({
        repository: "owner/repository",
        issue: { current: 1, total: 2, number: 101 },
        parentIssue: 100,
        activeLeaf: 101,
        stage: "issue-queue",
        status: "started",
    });

    const thinking = stateAfter(
        (emission) =>
            emission.kind === "pi" &&
            emission.event.type === "message_update" &&
            emission.event.assistantMessageEvent.type === "thinking_start",
    );
    expect(thinking).toMatchObject({
        parentIssue: 100,
        activeLeaf: 101,
        activity: "thinking",
        activityLabel: "Thinking",
    });

    const tool = stateAfter(
        (emission) =>
            emission.kind === "pi" &&
            emission.event.type === "tool_execution_start",
    );
    expect(tool).toMatchObject({
        parentIssue: 100,
        activeLeaf: 101,
        activity: "tool",
        activityLabel: "Using read",
    });

    const returnedToWorkflow = stateAfter(
        (emission) =>
            emission.kind === "pi" && emission.event.type === "agent_settled",
    );
    expect(returnedToWorkflow).toMatchObject({
        parentIssue: 100,
        activeLeaf: 101,
        activity: "waiting",
        activityLabel: "Waiting",
    });

    const firstReview = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.stage === "review" &&
            emission.event.status === "started" &&
            emission.event.attempt === 1,
    );
    expect(firstReview).toMatchObject({
        parentIssue: 100,
        activeLeaf: 101,
        stage: "review",
        status: "started",
        reviewAttempt: { current: 1, total: 2 },
    });

    const retryReview = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.stage === "review" &&
            emission.event.status === "started" &&
            emission.event.attempt === 2,
    );
    expect(retryReview).toMatchObject({
        reviewAttempt: { current: 2, total: 2 },
        stage: "review",
        status: "started",
    });

    const successfulReview = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.stage === "review" &&
            emission.event.status === "succeeded",
    );
    expect(successfulReview).toMatchObject({
        stage: "review",
        status: "succeeded",
        reviewAttempt: { current: 2, total: 2 },
    });

    const returnedToParent = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.stage === "issue-closure" &&
            emission.event.status === "succeeded",
    );
    expect(returnedToParent).toMatchObject({
        parentIssue: 100,
        stage: "issue-closure",
        status: "succeeded",
    });
    expect(returnedToParent.activeLeaf).toBeUndefined();
    expect(returnedToParent.reviewAttempt).toBeUndefined();

    const secondIssueFailure = stateAfter(
        (emission) =>
            emission.kind === "progress" &&
            emission.event.issue?.number === 102 &&
            emission.event.status === "failed",
    );
    expect(secondIssueFailure).toMatchObject({
        issue: { current: 2, total: 2, number: 102 },
        parentIssue: 100,
        activeLeaf: 102,
        stage: "implementation",
        status: "failed",
    });
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
            const durableEvents: JsonRecord[][] = [];
            for (const capture of harness.runCaptures) {
                expect(capture.displayStates).toEqual([
                    ...multiIssueRuntimeOracle.expectedDisplayStates,
                ]);
                expectNamedDisplayTransitions(capture);
                expect(capture.piEvents).toEqual([
                    ...multiIssueRuntimeOracle.piEvents,
                ]);
                expectSecretAbsentFromStreams(capture);
                expect(capture.eventLogPath).toBeString();
                expect(
                    await Bun.file(capture.eventLogPath ?? "").exists(),
                ).toBe(true);
                const log = await harness.readEventLog(capture.eventLogPath);
                durableEvents.push(expectEventLogContract(log));
                expect(log).not.toContain(multiIssueRuntimeOracle.secret);
            }

            // Run identity and timestamps are per invocation; every persisted
            // source event must otherwise be byte-for-byte equivalent in order.
            const normalizedDurableEvents = durableEvents.map(
                normalizeDurableEvents,
            );
            const normalizedOracleEvents = normalizeDurableEvents(
                expectedProgressRecords("normalized-run-id"),
            );
            expect(normalizedDurableEvents).toEqual(
                durableEvents.map(() => normalizedOracleEvents),
            );
            const firstNormalizedEvents = normalizedDurableEvents[0];
            if (firstNormalizedEvents === undefined) {
                throw new Error("No durable event logs were captured.");
            }
            expect(normalizedDurableEvents).toEqual(
                durableEvents.map(() => firstNormalizedEvents),
            );

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
            expectJsonOutputContract(json!);
        } finally {
            await harness.cleanup();
        }

        for (const path of harness.eventLogPaths) {
            expect(await Bun.file(path).exists()).toBe(false);
        }
    });
});
