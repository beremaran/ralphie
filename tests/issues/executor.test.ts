import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    IssueArtifactKind,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import type { ComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    IssueResolutionStatus,
    NeedsAttentionReason,
} from "../../src/issues/decisions.ts";
import type { DecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import type { GroundingAssessmentService } from "../../src/issues/grounding.ts";
import type { ImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { DecompositionDepthLimitError } from "../../src/github/decomposition-markdown.ts";
import { NeedsAttentionPolicy } from "../../src/options.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const context = (number: number): IssueExecutionContext =>
    ({
        issue: {
            number,
            title: `Issue ${number}`,
            url: `issue/${number}`,
            body: "Test issue.",
            labels: [],
            updatedAt: "2026-08-28T00:00:00.000Z",
            commentCount: 0,
        },
    }) as unknown as IssueExecutionContext;

const actionableGrounding = {
    assess: async () => ({
        sessionID: "grounding-session",
        decision: { disposition: GroundingDisposition.Actionable },
    }),
} satisfies GroundingAssessmentService;

const unusedResolutionVerification = {
    verify: async () => {
        throw new Error("resolution verification must not run");
    },
};

describe("IssueExecutor", () => {
    test("reuses matching grounding across a durable resumed run", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-grounding-"));
        try {
            let groundingCalls = 0;
            const events: ProgressUpdate[] = [];
            const grounding = {
                assess: async () => {
                    groundingCalls += 1;
                    return {
                        sessionID: `grounding-${groundingCalls}`,
                        decision: {
                            disposition: GroundingDisposition.NeedsAttention,
                            reason: NeedsAttentionReason.MissingInformation,
                            summary: "The issue needs clarification.",
                            evidence: ["The target is unspecified."],
                            questions: ["Which target should be supported?"],
                        },
                    };
                },
            };
            const makeExecutor = () =>
                makeIssueExecutorService(
                    makeIssueArtifactStoreService(),
                    {
                        assess: async () => {
                            throw new Error("unused");
                        },
                    },
                    {
                        execute: async () => {
                            throw new Error("unused");
                        },
                    },
                    {
                        execute: async () => {
                            throw new Error("unused");
                        },
                    },
                    grounding,
                    unusedResolutionVerification,
                    makeProgressRecorder(events),
                );
            const input = {
                ...context(42),
                issue: {
                    number: 42,
                    title: "Needs clarification",
                    url: "issue/42",
                    body: "Clarify the target.",
                    labels: [],
                    updatedAt: "2026-08-28T00:00:00.000Z",
                    commentCount: 1,
                },
                repository: "owner/repo",
                workspace,
                runId: "resume-run",
            } as IssueExecutionContext;

            const first = await makeExecutor().execute(input);
            const resumed = await makeExecutor().execute(input);

            expect(resumed).toEqual(first);
            expect(groundingCalls).toBe(1);
            expect(resumed).toMatchObject({
                kind: IssueExecutionOutcomeKind.NeedsAttention,
                reason: NeedsAttentionReason.MissingInformation,
                summary: "The issue needs clarification.",
                evidence: ["The target is unspecified."],
                questions: ["Which target should be supported?"],
            });
            expect(events).toContainEqual(
                expect.objectContaining({
                    stage: "grounding",
                    status: "skipped",
                    details: { agentWorkSkipped: true },
                }),
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test.each([
        ["updatedAt", { updatedAt: "2026-08-29T00:00:00.000Z" }],
        ["commentCount", { commentCount: 2 }],
        ["commentVersion", { commentVersion: "2026-08-29T00:00:00.000Z" }],
    ] as const)("regrounds when %s changes", async (_field, change) => {
        let groundingCalls = 0;
        const stores = makeIssueArtifactStoreService();
        const executor = makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    throw new Error("unused");
                },
            },
            {
                execute: async () => {
                    throw new Error("unused");
                },
            },
            {
                execute: async () => {
                    throw new Error("unused");
                },
            },
            {
                assess: async () => {
                    groundingCalls += 1;
                    return {
                        sessionID: `grounding-${groundingCalls}`,
                        decision: {
                            disposition: GroundingDisposition.NeedsAttention,
                            reason: NeedsAttentionReason.MissingInformation,
                            summary: `Grounding ${groundingCalls}`,
                            evidence: ["The target is unspecified."],
                            questions: ["Which target should be supported?"],
                        },
                    };
                },
            },
            unusedResolutionVerification,
        );
        const base = {
            ...context(42),
            issue: {
                number: 42,
                title: "Needs clarification",
                url: "issue/42",
                body: "Clarify the target.",
                labels: [],
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 1,
                commentVersion: "2026-08-28T00:00:00.000Z",
            },
            repository: "owner/repo",
            workspace: `/tmp/ralphie-grounding-${crypto.randomUUID()}`,
            runId: "run-1",
        } as IssueExecutionContext;

        await executor.execute(base);
        const reused = await executor.execute(base);
        expect(groundingCalls).toBe(1);
        expect(reused).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            summary: "Grounding 1",
        });

        const result = await executor.execute({
            ...base,
            issue: { ...base.issue, ...change },
        });

        expect(groundingCalls).toBe(2);
        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            summary: "Grounding 2",
        });
    });

    test("defers a dependency-blocked issue before complexity or implementation", async () => {
        let routed = false;
        const workspace = `/tmp/ralphie-${crypto.randomUUID()}`;
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
            unusedResolutionVerification,
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
            workspace,
            runId: "run-1",
        });

        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "Issue #41 must be completed first.",
        });
        expect(routed).toBe(false);
        const artifact = await stores.forIssue(42, {
            workspace,
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
                actionableGrounding,
                unusedResolutionVerification,
            );
            const result = await executor.execute(context(complexity + 1));
            const artifacts = await stores.forIssue(complexity + 1);
            const decision = await artifacts.read(
                IssueArtifactKind.ComplexityDecision,
            );

            expect(decision.decision.complexity).toBe(complexity);
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
        let groundingCalls = 0;
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
            {
                assess: async () => {
                    groundingCalls += 1;
                    return {
                        sessionID: `grounding-${groundingCalls}`,
                        decision: {
                            disposition: GroundingDisposition.Actionable,
                        },
                    };
                },
            },
            unusedResolutionVerification,
        );
        await executor.execute(context(42));
        await executor.execute(context(42));
        expect(assessmentCalls).toBe(1);
        expect(groundingCalls).toBe(2);
        expect(implementationCalls).toBe(2);
    });

    test.each([
        { updatedAt: "2026-08-29T00:00:00.000Z" },
        { commentCount: 1 },
        { commentVersion: "2026-08-29T00:00:00.000Z" },
    ])("reassesses complexity when freshness changes: %o", async (change) => {
        let assessmentCalls = 0;
        const executor = makeIssueExecutorService(
            makeIssueArtifactStoreService(),
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: `Assessment ${++assessmentCalls}.`,
                    },
                    sessionID: `complexity-${assessmentCalls}`,
                }),
            },
            {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Skipped,
                    reason: "test",
                }),
            },
            {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Decomposed,
                    childIssueNumbers: [],
                }),
            },
            actionableGrounding,
            unusedResolutionVerification,
        );
        const initial = context(42);

        await executor.execute(initial);
        await executor.execute({
            ...initial,
            issue: { ...initial.issue, ...change },
        });

        expect(assessmentCalls).toBe(2);
    });

    test("migrates an unfingerprinted complexity decision before assessing fresh work", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-legacy-"));
        try {
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "legacy-run",
                "issues",
                "42",
                "artifacts.json",
            );
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(
                path,
                JSON.stringify({
                    version: 2,
                    issueNumber: 42,
                    repository: "owner/repo",
                    artifacts: {
                        [IssueArtifactKind.ComplexityDecision]: {
                            complexity: ComplexityLevel.Level5,
                            rationale: "Legacy unfingerprinted decision.",
                        },
                    },
                }),
            );
            let assessmentCalls = 0;
            let implementationCalls = 0;
            let decompositionCalls = 0;
            const executor = makeIssueExecutorService(
                makeIssueArtifactStoreService(),
                {
                    assess: async () => ({
                        decision: {
                            complexity: ComplexityLevel.Level2,
                            rationale: `Fresh assessment ${++assessmentCalls}.`,
                        },
                        sessionID: "fresh-complexity",
                    }),
                },
                {
                    execute: async () => {
                        implementationCalls += 1;
                        return {
                            kind: IssueExecutionOutcomeKind.Skipped,
                            reason: "fresh implementation route",
                        } as const;
                    },
                },
                {
                    execute: async () => {
                        decompositionCalls += 1;
                        return {
                            kind: IssueExecutionOutcomeKind.Decomposed,
                            childIssueNumbers: [],
                        } as const;
                    },
                },
                actionableGrounding,
                unusedResolutionVerification,
            );

            await executor.execute({
                ...context(42),
                repository: "owner/repo",
                workspace,
                runId: "legacy-run",
            });

            expect(assessmentCalls).toBe(1);
            expect(implementationCalls).toBe(1);
            expect(decompositionCalls).toBe(0);
            const persisted = await Bun.file(path).json();
            expect(persisted.version).toBe(4);
            expect(
                persisted.artifacts[IssueArtifactKind.ComplexityDecision],
            ).toMatchObject({
                decision: { complexity: ComplexityLevel.Level2 },
                fingerprint: {
                    updatedAt: "2026-08-28T00:00:00.000Z",
                    commentCount: 0,
                },
            });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("routes a pending handoff before a cached complexity decision", async () => {
        const stores = makeIssueArtifactStoreService();
        const artifacts = await stores.forIssue(42);
        await artifacts.write(IssueArtifactKind.ComplexityDecision, {
            decision: {
                complexity: ComplexityLevel.Level2,
                rationale: "Cached decision.",
            },
            fingerprint: {
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
        });
        await artifacts.write(IssueArtifactKind.NeedsAttentionHandoff, {
            request: { reason: "external_dependency" },
            checkpoint: { branch: "main", sha: "abc123" },
            fingerprint: {
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
        });
        let implementationCalls = 0;
        const outcome = await makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    throw new Error("complexity must remain cached");
                },
            },
            {
                execute: async () => {
                    implementationCalls += 1;
                    throw new Error("implementation must not run");
                },
            },
            {
                execute: async () => {
                    throw new Error("decomposition must not run");
                },
            },
            actionableGrounding,
            unusedResolutionVerification,
            undefined,
            {
                route: async () => ({
                    kind: IssueExecutionOutcomeKind.NeedsAttention,
                    reason: NeedsAttentionReason.ExternalDependency,
                    summary: "Dependency unavailable.",
                    evidence: ["The generated dependency is absent."],
                    questions: ["Can the dependency be supplied?"],
                    diagnosticsPath: "/workspace/diagnostics",
                }),
            },
        ).execute({
            ...context(42),
            issue: {
                number: 42,
                title: "Pending issue",
                url: "issue/42",
                body: "Pending",
                labels: [],
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
        } as IssueExecutionContext);

        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.NeedsAttention);
        expect(implementationCalls).toBe(0);
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
            actionableGrounding,
            unusedResolutionVerification,
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
            actionableGrounding,
            unusedResolutionVerification,
        ).execute(context(42));
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: "/workspace/diagnostics",
            reason: "Review budget exhausted.",
            childIssueNumbers: [101, 102],
        });
    });

    test("preserves needs attention when review escalation cannot decompose", async () => {
        const needsAttention = {
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.DecompositionLimitReached,
            summary: "Maximum decomposition depth reached.",
            evidence: ["The next depth is unsupported."],
            questions: ["Increase the configured maximum or narrow the issue."],
            route: "needs-attention" as const,
            policy: NeedsAttentionPolicy.Continue,
        } as const;
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
            { execute: async () => needsAttention },
            actionableGrounding,
            unusedResolutionVerification,
        ).execute(context(42));

        expect(outcome).toEqual(needsAttention);
    });

    test("routes the decomposition ceiling to non-halting needs attention", async () => {
        const outcome = await makeIssueExecutorService(
            makeIssueArtifactStoreService(),
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level4,
                        rationale: "Decomposition is required.",
                    },
                    sessionID: "complexity-session",
                }),
            },
            {
                execute: async () => {
                    throw new Error("must not implement");
                },
            },
            {
                execute: async () => {
                    throw new DecompositionDepthLimitError(4, 3);
                },
            },
            actionableGrounding,
            unusedResolutionVerification,
        ).execute(context(42));

        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.DecompositionLimitReached,
            policy: NeedsAttentionPolicy.Continue,
            route: "needs-attention",
        });
    });

    test("verifies an already-resolved grounding decision before completion", async () => {
        const calls: string[] = [];
        const stores = makeIssueArtifactStoreService();
        const outcome = await makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    calls.push("complexity");
                    throw new Error("must not assess complexity");
                },
            },
            {
                execute: async () => {
                    calls.push("implementation");
                    throw new Error("must not implement");
                },
            },
            {
                execute: async () => {
                    calls.push("decomposition");
                    throw new Error("must not decompose");
                },
            },
            {
                assess: async () => {
                    calls.push("grounding");
                    return {
                        sessionID: "grounding-session",
                        decision: {
                            disposition: GroundingDisposition.AlreadyResolved,
                        },
                    };
                },
            },
            {
                verify: async () => {
                    calls.push("verification");
                    return {
                        sessionID: "verification-session",
                        decision: {
                            status: IssueResolutionStatus.Resolved,
                            summary: "The requested behavior is present.",
                            evidence: ["The focused regression test passes."],
                        },
                    };
                },
            },
        ).execute(context(42));

        expect(calls).toEqual(["grounding", "verification"]);
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "already-resolved",
            resolutionSummary: "The requested behavior is present.",
            evidence: ["The focused regression test passes."],
        });
        const artifacts = await stores.forIssue(42);
        expect(
            artifacts.has(IssueArtifactKind.IssueResolutionDecision),
        ).toBeTrue();
    });

    test("reroutes a rejected already-resolved claim into implementation", async () => {
        const calls: string[] = [];
        const inputs: Parameters<ImplementationExecutorService["execute"]>[] =
            [];
        const events: ProgressUpdate[] = [];
        const stores = makeIssueArtifactStoreService();
        const outcome = await makeIssueExecutorService(
            stores,
            {
                assess: async () => {
                    calls.push("complexity");
                    return {
                        sessionID: "complexity-session",
                        decision: {
                            complexity: ComplexityLevel.Level2,
                            rationale: "A focused implementation is required.",
                        },
                    };
                },
            },
            {
                execute: async (input) => {
                    calls.push("implementation");
                    inputs.push([input]);
                    return {
                        kind: IssueExecutionOutcomeKind.Skipped,
                        reason: "Implementation captured for the test.",
                    };
                },
            },
            {
                execute: async () => {
                    throw new Error("must not decompose");
                },
            },
            {
                assess: async () => {
                    calls.push("grounding");
                    return {
                        sessionID: "grounding-session",
                        decision: {
                            disposition: GroundingDisposition.AlreadyResolved,
                        },
                    };
                },
            },
            {
                verify: async () => {
                    calls.push("verification");
                    return {
                        sessionID: "verification-session",
                        decision: {
                            status: IssueResolutionStatus.Unresolved,
                            summary: "The bug still reproduces.",
                            evidence: ["The regression test fails."],
                        },
                    };
                },
            },
            makeProgressRecorder(events),
        ).execute(context(42));

        expect(calls).toEqual([
            "grounding",
            "verification",
            "complexity",
            "implementation",
        ]);
        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Skipped);
        expect(inputs[0]?.[0].unresolvedResolution).toEqual({
            status: IssueResolutionStatus.Unresolved,
            summary: "The bug still reproduces.",
            evidence: ["The regression test fails."],
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "grounding",
                status: "succeeded",
                message: expect.stringContaining("continuing as actionable"),
            }),
        );
        const artifacts = await stores.forIssue(42);
        expect(
            artifacts.has(IssueArtifactKind.IssueResolutionDecision),
        ).toBeFalse();
    });

    test.each([
        {
            name: "invalid",
            verify: async () => ({
                sessionID: "verification-session",
                decision: {
                    status: "uncertain",
                    summary: "No conclusion.",
                    evidence: [],
                },
            }),
        },
        {
            name: "thrown",
            verify: async () => {
                throw new Error("verifier unavailable");
            },
        },
    ])(
        "fails closed for $name already-resolved verification",
        async ({ verify }) => {
            const outcome = await makeIssueExecutorService(
                makeIssueArtifactStoreService(),
                {
                    assess: async () => {
                        throw new Error("must not assess complexity");
                    },
                },
                {
                    execute: async () => {
                        throw new Error("must not implement");
                    },
                },
                {
                    execute: async () => {
                        throw new Error("must not decompose");
                    },
                },
                {
                    assess: async () => ({
                        sessionID: "grounding-session",
                        decision: {
                            disposition: GroundingDisposition.AlreadyResolved,
                        },
                    }),
                },
                { verify } as never,
            ).execute(context(42));

            expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Failed);
        },
    );
});