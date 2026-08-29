import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "../../src/issues/execution.ts";
import { NeedsAttentionReason } from "../../src/issues/decisions.ts";
import { NeedsAttentionPolicy } from "../../src/options.ts";
import {
    RUN_STATE_VERSION,
    RunStateStatus,
    RunStateStoreLive,
    type RunState,
} from "../../src/run/state.ts";

const state: RunState = {
    version: RUN_STATE_VERSION,
    status: RunStateStatus.Active,
    runId: "run-1",
    repository: "owner/repo",
    branch: "main",
    onNeedsAttention: NeedsAttentionPolicy.Halt,
    selection: { agent: "build" },
    maxIssues: 3,
    queue: {
        pending: [
            {
                number: 2,
                title: "Next",
                url: "issue/2",
                body: null,
                labels: [],
            },
        ],
        completedIssueNumbers: [1],
        processedCount: 1,
    },
    outcomes: [
        {
            issueNumber: 1,
            outcome: {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
                commitSha: "abc123",
            },
        },
    ],
    activeIssue: { issueNumber: 2, stage: "implementation" },
    updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("run state store", () => {
    test("atomically persists and validates complete run context", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "nested", "state.json");
        try {
            await RunStateStoreLive.save(path, state);
            const loaded = await RunStateStoreLive.load(path);
            expect(loaded).toEqual(state);
            expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test.each([
        ["corrupted JSON", "not-json"],
        ["incompatible version", JSON.stringify({ ...state, version: 1 })],
        ["missing queue state", JSON.stringify({ ...state, queue: undefined })],
        [
            "missing current policy",
            JSON.stringify({ ...state, onNeedsAttention: undefined }),
        ],
    ])("rejects %s", async (_label, content) => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "state.json");
        try {
            await writeFile(path, content);
            await expect(RunStateStoreLive.load(path)).rejects.toThrow(
                "invalid or unreadable",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("migrates version 2 state while preserving completed and escalated outcomes", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-state-legacy-"),
        );
        const path = join(directory, "state.json");
        try {
            const legacy = {
                ...structuredClone(state),
                version: 2,
                outcomes: [
                    {
                        issueNumber: 1,
                        outcome: {
                            kind: IssueExecutionOutcomeKind.Completed,
                            completion: "pushed-commit",
                            commitSha: "abc123",
                        },
                    },
                    {
                        issueNumber: 3,
                        outcome: {
                            kind: IssueExecutionOutcomeKind.Escalated,
                            diagnosticsPath: "/tmp/diagnostics",
                            reason: "review budget exhausted",
                        },
                    },
                ],
            };
            await writeFile(path, JSON.stringify(legacy));
            const loaded = await RunStateStoreLive.load(path);
            expect(loaded.version).toBe(RUN_STATE_VERSION);
            expect(loaded.outcomes).toEqual([
                {
                    issueNumber: 1,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "abc123",
                    },
                },
                {
                    issueNumber: 3,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Escalated,
                        diagnosticsPath: "/tmp/diagnostics",
                        reason: "review budget exhausted",
                    },
                },
            ]);
            expect(JSON.parse(await readFile(path, "utf8")).version).toBe(
                RUN_STATE_VERSION,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("migrates version 3 state without a policy to halt", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-state-legacy-"),
        );
        const path = join(directory, "state.json");
        try {
            const legacy = { ...state, version: 3 };
            const { onNeedsAttention: _policy, ...withoutPolicy } = legacy;
            await writeFile(path, JSON.stringify(withoutPolicy));
            const loaded = await RunStateStoreLive.load(path);
            expect(loaded.onNeedsAttention).toBe(NeedsAttentionPolicy.Halt);
            expect(
                JSON.parse(await readFile(path, "utf8")).onNeedsAttention,
            ).toBe(NeedsAttentionPolicy.Halt);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("migrates version 4 state to the notification-aware state contract", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-state-legacy-"),
        );
        const path = join(directory, "state.json");
        try {
            const legacy = { ...state, version: 4 };
            await writeFile(path, JSON.stringify(legacy));
            const loaded = await RunStateStoreLive.load(path);
            expect(loaded.version).toBe(RUN_STATE_VERSION);
            expect(loaded.notificationsEnabled).toBeFalse();
            expect(JSON.parse(await readFile(path, "utf8")).version).toBe(
                RUN_STATE_VERSION,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("migrates legacy completed outcomes to pushed-commit completions", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-state-legacy-"),
        );
        const path = join(directory, "state.json");
        try {
            const legacy = structuredClone(state) as unknown as {
                outcomes: Array<{ outcome: Record<string, unknown> }>;
            };
            delete legacy.outcomes[0]?.outcome.completion;
            await writeFile(path, JSON.stringify(legacy));
            const loaded = await RunStateStoreLive.load(path);
            expect(loaded.outcomes[0]?.outcome).toMatchObject({
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
                commitSha: "abc123",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("persists every needs-attention outcome detail", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "state.json");
        try {
            const needsAttentionState: RunState = {
                ...state,
                outcomes: [
                    {
                        issueNumber: 1,
                        outcome: {
                            kind: IssueExecutionOutcomeKind.NeedsAttention,
                            reason: NeedsAttentionReason.ExternalDependency,
                            summary:
                                "The issue depends on an unavailable service.",
                            evidence: [
                                "The service endpoint is not configured.",
                            ],
                            questions: ["When will the service be available?"],
                            artifactPath: "/tmp/needs-attention/artifacts.json",
                        },
                    },
                ],
            };
            await RunStateStoreLive.save(path, needsAttentionState);
            expect(await RunStateStoreLive.load(path)).toEqual(
                needsAttentionState,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("persists a pending needs-attention notification with its label intent", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "state.json");
        try {
            const pendingState: RunState = {
                ...state,
                notificationsEnabled: true,
                needsAttentionLabel: "needs-attention",
                pendingNotification: {
                    issueNumber: 2,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.ExternalDependency,
                        summary: "The dependency is unavailable.",
                        evidence: ["The dependency service is offline."],
                        questions: ["When will it be available?"],
                        artifactPath: "/tmp/needs-attention/artifacts.json",
                    },
                    labelName: "needs-attention",
                },
            };
            await RunStateStoreLive.save(path, pendingState);
            expect(await RunStateStoreLive.load(path)).toEqual(pendingState);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects blank needs-attention outcome content", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "state.json");
        try {
            await writeFile(
                path,
                JSON.stringify({
                    ...state,
                    outcomes: [
                        {
                            issueNumber: 1,
                            outcome: {
                                kind: IssueExecutionOutcomeKind.NeedsAttention,
                                reason: NeedsAttentionReason.MissingInformation,
                                summary: "   ",
                                evidence: ["concrete evidence"],
                                questions: ["What is missing?"],
                                artifactPath:
                                    "/tmp/needs-attention/artifacts.json",
                            },
                        },
                    ],
                }),
            );
            await expect(RunStateStoreLive.load(path)).rejects.toThrow(
                "invalid or unreadable",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("does not replace good state when a new value fails validation", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
        const path = join(directory, "state.json");
        try {
            await RunStateStoreLive.save(path, state);
            await expect(
                RunStateStoreLive.save(path, { ...state, runId: "" }),
            ).rejects.toThrow("Failed to persist");
            expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});