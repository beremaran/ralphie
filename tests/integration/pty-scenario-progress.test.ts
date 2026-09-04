import { describe, expect, test } from "bun:test";

import {
    reduceProgressUpdate,
    type DisplayClock,
    type DisplayState,
} from "../../src/progress/display-state.ts";
import type { ProgressUpdate } from "../../src/progress/progress.ts";
import {
    LONG_FAILURE_MESSAGE,
    scenarioProgressUpdates,
    type PtyScenarioOptions,
} from "./pty-driver-child.ts";

const FIXED_OPTIONS: PtyScenarioOptions = {
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

const ISSUE_TITLE = "PTY scenario issue";

const at =
    (value: string): DisplayClock =>
    () =>
        value;

const FIXED_CLOCK = at("2026-09-04T12:00:00.000Z");

const reduceSequence = (updates: readonly ProgressUpdate[]): DisplayState => {
    let state: DisplayState | undefined;
    for (const update of updates) {
        state = reduceProgressUpdate(state, update, FIXED_CLOCK);
    }
    if (state === undefined) {
        throw new Error("scenarioProgressUpdates returned an empty sequence");
    }
    return state;
};

describe("PTY scenario progress updates", () => {
    test("produces the smoke settlement sequence in order", () => {
        const updates = scenarioProgressUpdates(FIXED_OPTIONS);
        expect(updates.map((update) => [update.stage, update.status])).toEqual([
            ["run", "info"],
            ["grounding", "started"],
            ["implementation", "started"],
            ["implementation", "succeeded"],
            ["grounding", "succeeded"],
            ["verification", "failed"],
        ]);
        expect(updates[5]?.message).toBe(LONG_FAILURE_MESSAGE);
    });

    test("carries repository, issue, queue, and review context on every update", () => {
        for (const update of scenarioProgressUpdates(FIXED_OPTIONS)) {
            expect(update.repository).toBe(FIXED_OPTIONS.repository);
            expect(update.issue).toEqual({
                number: FIXED_OPTIONS.issueNumber,
                title: ISSUE_TITLE,
            });
            expect(update.current).toBe(FIXED_OPTIONS.issueCurrent);
            expect(update.total).toBe(FIXED_OPTIONS.issueTotal);
            expect(update.attempt).toBe(FIXED_OPTIONS.attempt);
            expect(update.maxAttempts).toBe(FIXED_OPTIONS.maxAttempts);
        }
    });

    test("is deterministic for fixed options", () => {
        expect(scenarioProgressUpdates(FIXED_OPTIONS)).toEqual(
            scenarioProgressUpdates(FIXED_OPTIONS),
        );
    });

    test("reduces to repository, issue, and a stable review attempt, with implementation current at the stream-open point", () => {
        const updates = scenarioProgressUpdates(FIXED_OPTIONS);

        // The agent stream opens after the first three updates, so the leaf
        // stage at that point is `implementation` (started beneath
        // grounding) with repository, queue, and review scope populated.
        const streamOpenPoint = reduceSequence(updates.slice(0, 3));
        expect(streamOpenPoint).toMatchObject({
            repository: FIXED_OPTIONS.repository,
            issue: {
                current: FIXED_OPTIONS.issueCurrent,
                total: FIXED_OPTIONS.issueTotal,
                number: FIXED_OPTIONS.issueNumber,
                title: ISSUE_TITLE,
            },
            reviewAttempt: {
                current: FIXED_OPTIONS.attempt,
                total: FIXED_OPTIONS.maxAttempts,
            },
            stage: "implementation",
            status: "started",
        });

        // One issue throughout the whole sequence, so the review attempt
        // never resets and the settlement keeps every scope stable.
        const settled = reduceSequence(updates);
        expect(settled).toMatchObject({
            repository: FIXED_OPTIONS.repository,
            issue: {
                current: FIXED_OPTIONS.issueCurrent,
                total: FIXED_OPTIONS.issueTotal,
                number: FIXED_OPTIONS.issueNumber,
                title: ISSUE_TITLE,
            },
            reviewAttempt: {
                current: FIXED_OPTIONS.attempt,
                total: FIXED_OPTIONS.maxAttempts,
            },
            stage: "verification",
            status: "failed",
        });
    });
});