import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Octokit } from "octokit";
import type { PiClient } from "../../src/pi/client.ts";

import {
    IssueArtifactKind,
    makeIssueArtifactStore,
    makeIssueArtifactStoreService,
    type IssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import type { ComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    NeedsAttentionReason,
    type GroundingDecision,
} from "../../src/issues/decisions.ts";
import { NeedsAttentionPolicy } from "../../src/options.ts";
import { makeDryRunIssueExecutorService } from "../../src/issues/dry-run-executor.ts";
import type { GroundingAssessmentService } from "../../src/issues/grounding.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const context = (number: number): IssueExecutionContext => ({
    issue: {
        number,
        title: "Dry-run issue",
        url: `issue/${number}`,
        body: "Assess this issue.",
        labels: [],
        updatedAt: "2026-08-28T00:00:00.000Z",
        commentCount: 1,
    },
    repository: "owner/repository",
    repositoryPath: "/workspace/repository",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "dry-run",
    octokit: {} as Octokit,
    pi: {} as PiClient,
    piSelection: { agent: "build" },
    piDiagnostics: { record: () => undefined, list: () => [] },
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

const run = async (complexity: ComplexityLevel, events: ProgressUpdate[]) => {
    const artifacts = await makeIssueArtifactStore(42);
    const artifactStore = { forIssue: async () => artifacts };
    const assessment: ComplexityAssessmentService = {
        assess: async () => ({
            sessionID: "complexity-session",
            decision: { complexity, rationale: "dry-run test" },
        }),
    };
    const executor = makeDryRunIssueExecutorService(
        artifactStore,
        assessment,
        makeProgressRecorder(events),
    );
    const result = await executor.execute(context(42));
    return { result, artifacts };
};

const groundedContext = (number: number): IssueExecutionContext => ({
    ...context(number),
    issue: {
        ...context(number).issue,
        updatedAt: "2026-08-28T00:00:00.000Z",
        commentCount: 1,
    },
    needsAttentionPolicy: NeedsAttentionPolicy.Continue,
});

const spyStore = async (): Promise<{
    readonly store: IssueArtifactStore;
    readonly writes: () => number;
}> => {
    const store = await makeIssueArtifactStore(42);
    let writeCount = 0;
    const write = async (...args: Parameters<IssueArtifactStore["write"]>) => {
        writeCount += 1;
        await store.write(...args);
    };
    return {
        store: { ...store, write } as IssueArtifactStore,
        writes: () => writeCount,
    };
};

describe("dry-run issue executor", () => {
    test.each([ComplexityLevel.Level2, ComplexityLevel.Level4])(
        "assesses complexity %s, reports routing, and never invokes mutation executors",
        async (complexity) => {
            const events: ProgressUpdate[] = [];
            const outcome = await run(complexity, events);
            expect(outcome.result.kind).toBe(IssueExecutionOutcomeKind.Skipped);
            if (outcome.result.kind === IssueExecutionOutcomeKind.Skipped) {
                expect(outcome.result.reason).toContain(
                    `complexity ${complexity}/5`,
                );
                expect(outcome.result.route).toBe(
                    complexity <= ComplexityLevel.Level3
                        ? "implementation"
                        : "decomposition",
                );
            }
            expect(events.at(-1)?.message).toContain("Dry run would route");
            expect(
                outcome.artifacts.has(IssueArtifactKind.ComplexityDecision),
            ).toBe(false);
        },
    );

    test("does not fall back to the writable artifact loader", async () => {
        let writableLoaderCalls = 0;
        const executor = makeDryRunIssueExecutorService(
            {
                forIssue: async () => {
                    writableLoaderCalls += 1;
                    throw new Error("dry run must not use the writable loader");
                },
            },
            {
                assess: async () => ({
                    sessionID: "complexity",
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Read-only routing assessment.",
                    },
                }),
            },
            makeProgressRecorder([]),
        );

        const result = await executor.execute(context(42));

        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.Skipped,
            route: "implementation",
        });
        expect(writableLoaderCalls).toBe(0);
    });

    test.each([
        {
            name: "implementation",
            grounding: {
                disposition: GroundingDisposition.Actionable,
            },
            complexity: ComplexityLevel.Level2,
        },
        {
            name: "decomposition",
            grounding: {
                disposition: GroundingDisposition.Actionable,
            },
            complexity: ComplexityLevel.Level4,
        },
        {
            name: "already-resolved",
            grounding: {
                disposition: GroundingDisposition.AlreadyResolved,
            },
        },
        {
            name: "needs-attention",
            grounding: {
                disposition: GroundingDisposition.NeedsAttention,
                reason: NeedsAttentionReason.ExternalDependency,
                summary: "The prerequisite is still open.",
                evidence: ["Read-only issue inspection found dependency #41."],
                questions: ["When will #41 be complete?"],
            },
        },
    ])("routes $name without persisting per-issue decisions", async (input) => {
        const events: ProgressUpdate[] = [];
        const tracked = await spyStore();
        let groundingCalls = 0;
        let complexityCalls = 0;
        const grounding: GroundingAssessmentService = {
            assess: async () => {
                groundingCalls += 1;
                return {
                    decision: input.grounding as GroundingDecision,
                    sessionID: "grounding",
                };
            },
        };
        const assessment: ComplexityAssessmentService = {
            assess: async () => {
                complexityCalls += 1;
                if (input.complexity === undefined)
                    throw new Error("complexity must not be assessed");
                return {
                    decision: {
                        complexity: input.complexity,
                        rationale: "Read-only routing assessment.",
                    },
                    sessionID: "complexity",
                };
            },
        };
        const executor = makeDryRunIssueExecutorService(
            { forIssue: async () => tracked.store },
            assessment,
            makeProgressRecorder(events),
            grounding,
        );

        const result = await executor.execute(groundedContext(42));

        expect(result).toMatchObject({ route: input.name });
        expect(groundingCalls).toBe(1);
        expect(complexityCalls).toBe(input.complexity === undefined ? 0 : 1);
        expect(tracked.writes()).toBe(0);
        expect(tracked.store.has(IssueArtifactKind.ComplexityDecision)).toBe(
            false,
        );
        expect(
            events.some((event) => event.details?.route === input.name),
        ).toBe(true);
        if (input.name === "needs-attention") {
            expect(result).toMatchObject({
                kind: IssueExecutionOutcomeKind.NeedsAttention,
                reason: NeedsAttentionReason.ExternalDependency,
                policy: "continue",
            });
            expect(result).not.toHaveProperty("artifactPath");
        }
    });

    test("reads matching durable decisions without rewriting their file", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-dry-run-"));
        try {
            const scope = {
                workspace,
                runId: "dry-run",
                repository: "owner/repository",
            };
            const persisted = makeIssueArtifactStoreService();
            const writable = await persisted.forIssue(42, scope);
            await writable.write(IssueArtifactKind.ComplexityDecision, {
                decision: {
                    complexity: ComplexityLevel.Level4,
                    rationale: "Previously assessed.",
                },
                fingerprint: {
                    updatedAt: "2026-08-28T00:00:00.000Z",
                    commentCount: 1,
                },
            });
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "dry-run",
                "issues",
                "42",
                "artifacts.json",
            );
            const before = await Bun.file(path).text();
            const events: ProgressUpdate[] = [];
            const executor = makeDryRunIssueExecutorService(
                makeIssueArtifactStoreService(),
                {
                    assess: async () => {
                        throw new Error("persisted complexity must be reused");
                    },
                },
                makeProgressRecorder(events),
                {
                    assess: async () => ({
                        sessionID: "grounding",
                        decision: {
                            disposition: GroundingDisposition.Actionable,
                        },
                    }),
                },
            );

            const result = await executor.execute({
                ...groundedContext(42),
                workspace,
                runId: "dry-run",
            });

            expect(result).toMatchObject({
                kind: IssueExecutionOutcomeKind.Skipped,
                route: "decomposition",
            });
            let reassessments = 0;
            const staleResult = await makeDryRunIssueExecutorService(
                makeIssueArtifactStoreService(),
                {
                    assess: async () => {
                        reassessments += 1;
                        return {
                            sessionID: "fresh-complexity",
                            decision: {
                                complexity: ComplexityLevel.Level2,
                                rationale: "The issue changed.",
                            },
                        };
                    },
                },
                makeProgressRecorder([]),
            ).execute({
                ...groundedContext(42),
                issue: {
                    ...groundedContext(42).issue,
                    updatedAt: "2026-08-29T00:00:00.000Z",
                },
                workspace,
                runId: "dry-run",
            });
            expect(staleResult).toMatchObject({ route: "implementation" });
            expect(reassessments).toBe(1);
            expect(await Bun.file(path).text()).toBe(before);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("reuses matching grounding without fabricating a new artifact path", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-dry-run-"));
        try {
            const scope = {
                workspace,
                runId: "dry-run-grounding",
                repository: "owner/repository",
            };
            const persisted = makeIssueArtifactStoreService();
            const writable = await persisted.forIssue(42, scope);
            await writable.write(IssueArtifactKind.NeedsAttentionDecision, {
                decision: {
                    disposition: GroundingDisposition.NeedsAttention,
                    reason: NeedsAttentionReason.MissingInformation,
                    summary: "The target is unspecified.",
                    evidence: ["The issue does not name a target."],
                    questions: ["Which target should be changed?"],
                },
                fingerprint: {
                    updatedAt: "2026-08-28T00:00:00.000Z",
                    commentCount: 1,
                },
            });
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "dry-run-grounding",
                "issues",
                "42",
                "artifacts.json",
            );
            const before = await Bun.file(path).text();
            const executor = makeDryRunIssueExecutorService(
                makeIssueArtifactStoreService(),
                {
                    assess: async () => {
                        throw new Error("complexity must not be assessed");
                    },
                },
                makeProgressRecorder([]),
                {
                    assess: async () => {
                        throw new Error("matching grounding must be reused");
                    },
                },
            );

            const result = await executor.execute({
                ...groundedContext(42),
                workspace,
                runId: "dry-run-grounding",
            });

            expect(result).toMatchObject({
                kind: IssueExecutionOutcomeKind.NeedsAttention,
                route: "needs-attention",
                artifactPath: path,
            });
            expect(await Bun.file(path).text()).toBe(before);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});