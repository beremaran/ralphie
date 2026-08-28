import { describe, expect, test } from "bun:test";

import {
    IssueArtifactKind,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import type { ComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    NeedsAttentionReason,
} from "../../src/issues/decisions.ts";
import type { DecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import type { ImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import { RalphieError } from "../../src/shared/error.ts";

const context = (number: number): IssueExecutionContext =>
    ({ issue: { number } }) as IssueExecutionContext;

describe("IssueExecutor", () => {
    test("defers a dependency-blocked issue before complexity or implementation", async () => {
        let routed = false;
        const stores = makeIssueArtifactStoreService();
        const executor = makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    routed = true;
                    throw new Error("must not assess complexity");
                },
            },
            {
                execute: async () => {
                    routed = true;
                    throw new Error("must not implement");
                },
            },
            {
                execute: async () => {
                    routed = true;
                    throw new Error("must not decompose");
                },
            },
            {
                assess: async () => ({
                    sessionID: "grounding-session",
                    decision: {
                        disposition: GroundingDisposition.NeedsAttention,
                        reason: NeedsAttentionReason.ExternalDependency,
                        summary: "Issue #41 must be completed first.",
                        evidence: ["The issue declares a dependency on #41."],
                        questions: [
                            "Complete issue #41, then retry this issue.",
                        ],
                    },
                }),
            },
        );
        const result = await executor.execute({
            ...context(42),
            issue: {
                number: 42,
                title: "Dependent work",
                url: "issue/42",
                body: "Depends on #41.",
                labels: [],
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
            repository: "owner/repo",
            workspace: "/tmp/ralphie",
            runId: "run-1",
        });

        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "Issue #41 must be completed first.",
        });
        expect(routed).toBe(false);
        const artifact = await stores.forIssue(42, {
            workspace: "/tmp/ralphie",
            runId: "run-1",
            repository: "owner/repo",
        });
        expect(artifact.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            true,
        );
    });

    test("executes through an explicitly supplied service", async () => {
        const outcome = await {
            execute: async (received: IssueExecutionContext) => ({
                kind: IssueExecutionOutcomeKind.Skipped,
                reason: `Issue ${received.issue.number} is not ready.`,
            }),
        }.execute(context(42));
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Skipped,
            reason: "Issue 42 is not ready.",
        });
    });

    for (const complexity of Object.values(ComplexityLevel).filter(
        (value): value is ComplexityLevel => typeof value === "number",
    )) {
        test(`stores and routes complexity ${complexity}`, async () => {
            let implementationCalls = 0;
            let decompositionCalls = 0;
            const stores = makeIssueArtifactStoreService();
            const assessment: ComplexityAssessmentService = {
                assess: async () => ({
                    decision: {
                        complexity,
                        rationale: `Complexity ${complexity} rationale`,
                    },
                    sessionID: `complexity-${complexity}`,
                }),
            };
            const implementation: ImplementationExecutorService = {
                execute: async () => {
                    implementationCalls += 1;
                    return {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "implementation-sha",
                    } as const;
                },
            };
            const decomposition: DecompositionExecutorService = {
                execute: async () => {
                    decompositionCalls += 1;
                    return {
                        kind: IssueExecutionOutcomeKind.Decomposed,
                        childIssueNumbers: [101, 102],
                    } as const;
                },
            };
            const executor = makeIssueExecutorService(
                stores,
                assessment,
                implementation,
                decomposition,
            );
            const result = await executor.execute(context(complexity + 1));
            const artifacts = await stores.forIssue(complexity + 1);
            const decision = await artifacts.read(
                IssueArtifactKind.ComplexityDecision,
            );

            expect(decision.complexity).toBe(complexity);
            if (complexity <= ComplexityLevel.Level3) {
                expect(result.kind).toBe(IssueExecutionOutcomeKind.Completed);
                expect(implementationCalls).toBe(1);
                expect(decompositionCalls).toBe(0);
            } else {
                expect(result.kind).toBe(IssueExecutionOutcomeKind.Decomposed);
                expect(implementationCalls).toBe(0);
                expect(decompositionCalls).toBe(1);
            }
        });
    }

    test("reuses a persisted complexity decision when retrying an issue", async () => {
        let assessmentCalls = 0;
        let implementationCalls = 0;
        const stores = makeIssueArtifactStoreService();
        const executor = makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    assessmentCalls += 1;
                    return {
                        decision: {
                            complexity: ComplexityLevel.Level2,
                            rationale: "Persisted routing decision.",
                        },
                        sessionID: "complexity-session",
                    };
                },
            },
            {
                execute: async () => {
                    implementationCalls += 1;
                    return {
                        kind: IssueExecutionOutcomeKind.Skipped,
                        reason: "test retry",
                    } as const;
                },
            },
            {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Decomposed,
                    childIssueNumbers: [],
                }),
            },
        );
        await executor.execute(context(42));
        await executor.execute(context(42));
        expect(assessmentCalls).toBe(1);
        expect(implementationCalls).toBe(2);
    });

    test("turns a missing complexity decision into a failed outcome", async () => {
        let workflowCalls = 0;
        const outcome = await makeIssueExecutorService(
            makeIssueArtifactStoreService(),
            {
                assess: async () => {
                    throw new RalphieError({
                        message: "Structured decision is missing.",
                    });
                },
            },
            {
                execute: async () => {
                    workflowCalls += 1;
                    throw new Error("must not run");
                },
            },
            {
                execute: async () => {
                    workflowCalls += 1;
                    throw new Error("must not run");
                },
            },
        ).execute(context(42));
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Failed,
            message: "Structured decision is missing.",
        });
        expect(workflowCalls).toBe(0);
    });

    test("hands a review escalation to decomposition", async () => {
        const outcome = await makeIssueExecutorService(
            makeIssueArtifactStoreService(),
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level3,
                        rationale: "Implementation is appropriate.",
                    },
                    sessionID: "complexity-session",
                }),
            },
            {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Escalated,
                    diagnosticsPath: "/workspace/diagnostics",
                    reason: "Review budget exhausted.",
                }),
            },
            {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Decomposed,
                    childIssueNumbers: [101, 102],
                }),
            },
        ).execute(context(42));
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: "/workspace/diagnostics",
            reason: "Review budget exhausted.",
            childIssueNumbers: [101, 102],
        });
    });
});