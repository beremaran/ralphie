import { type ProgressReporterService } from "../../progress/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import { DecompositionDepthLimitError } from "../domain/decomposition-markdown.ts";
import {
    IssueArtifactKind,
    issueFreshnessFingerprint,
    type IssueArtifactStoreService,
} from "./artifacts.ts";
import {
    type NeedsAttentionDecision,
    type SessionFitDecision,
    GroundingDisposition,
    type IssueResolutionDecision,
    IssueResolutionStatus,
    resolutionVerificationDecisionSchema,
} from "../domain/decisions.ts";
import type {
    IssueExecutionContext,
    IssueExecutionOutcome,
} from "./execution.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type { DecompositionExecutorService } from "./decomposition-executor.ts";
import type { ImplementationExecutorService } from "./implementation-executor.ts";
import type { PreflightAssessmentService } from "./preflight.ts";
import type { ResolutionVerificationService } from "./resolution-verification.ts";
import { type NeedsAttentionRouterService } from "./needs-attention.ts";
import { decompositionLimitOutcome } from "../domain/decomposition-limit.ts";

export type IssueExecutorService = {
    readonly execute: (
        context: IssueExecutionContext,
    ) => Promise<IssueExecutionOutcome>;
};

const alreadyResolvedOutcome = (
    decision: IssueResolutionDecision,
): IssueExecutionOutcome => ({
    kind: IssueExecutionOutcomeKind.Completed,
    completion: "already-resolved",
    resolutionSummary: decision.summary,
    evidence: decision.evidence,
});

const blockedOutcome = (
    blockedBy: ReadonlyArray<number>,
): IssueExecutionOutcome => ({
    kind: IssueExecutionOutcomeKind.Skipped,
    reason: `Blocked by open ${blockedBy.length === 1 ? "issue" : "issues"} ${blockedBy.map((number) => `#${number}`).join(", ")}.`,
});

/** Assess one issue, retain the decision, then route it to its concrete workflow. */
export const makeIssueExecutorService = (
    artifactStores: IssueArtifactStoreService,
    implementationExecutor: ImplementationExecutorService,
    decompositionExecutor: DecompositionExecutorService,
    preflightAssessment: PreflightAssessmentService,
    resolutionVerification: ResolutionVerificationService,
    progress?: ProgressReporterService,
    needsAttentionRouter?: NeedsAttentionRouterService,
): IssueExecutorService => {
    const routeResolutionDecision = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
        decision: IssueResolutionDecision,
    ): Promise<IssueExecutionOutcome> => {
        await artifacts.recordResolutionDecision(
            {
                decision,
                fingerprint: issueFreshnessFingerprint(context.issue),
            },
            context.signal,
        );
        return decision.status === IssueResolutionStatus.Resolved
            ? alreadyResolvedOutcome(decision)
            : {
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: decision.summary,
              };
    };

    const verifyAlreadyResolved = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome> => {
        try {
            const result = await resolutionVerification.verify(context);
            if (result.needsAttention !== undefined) {
                return {
                    kind: IssueExecutionOutcomeKind.Failed,
                    message:
                        "Fresh resolution verification could not establish that the issue is resolved.",
                };
            }
            const decision = resolutionVerificationDecisionSchema.parse(
                result.decision,
            );
            return await routeResolutionDecision(context, artifacts, decision);
        } catch (error) {
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message: `Fresh resolution verification failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    };

    const checkpoint = async (context: IssueExecutionContext) => {
        const captured = await context.repositoryInvariant.capture(
            context.repositoryPath,
            context.signal,
        );
        return { branch: captured.branch, sha: captured.head };
    };

    const routeSignal = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
        request: NonNullable<
            Awaited<
                ReturnType<PreflightAssessmentService["assess"]>
            >["needsAttention"]
        >,
    ) => {
        if (needsAttentionRouter === undefined) {
            throw new RalphieError({
                message:
                    "A needs-attention signal requires the verifier/router service.",
            });
        }
        return await needsAttentionRouter.route({
            context,
            artifacts,
            request,
            checkpoint: await checkpoint(context),
        });
    };

    const reuseNeedsAttention = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome> => {
        await progress?.emit({
            issue: {
                number: context.issue.number,
                title: context.issue.title,
            },
            stage: "grounding",
            status: "skipped",
            message: `Reusing the previous grounding decision for #${context.issue.number}; agent grounding was skipped.`,
            details: { agentWorkSkipped: true },
        });
        const { decision } = await artifacts.read(
            IssueArtifactKind.NeedsAttentionDecision,
        );
        const { disposition: _disposition, ...details } = decision;
        return {
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            ...details,
            artifactPath: context.runLayout.issueArtifactsPath(
                context.issue.number,
            ),
        };
    };

    const recordNeedsAttention = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
        decision: NeedsAttentionDecision,
    ): Promise<IssueExecutionOutcome> => {
        const fingerprint = issueFreshnessFingerprint(context.issue);
        await artifacts.write(
            IssueArtifactKind.NeedsAttentionDecision,
            {
                decision,
                fingerprint,
            },
            context.signal,
        );
        const { disposition: _disposition, ...details } = decision;
        return {
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            ...details,
            artifactPath: context.runLayout.issueArtifactsPath(
                context.issue.number,
            ),
        };
    };

    const runPreflight = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome | undefined> => {
        const fingerprint = issueFreshnessFingerprint(context.issue);
        if (artifacts.has(IssueArtifactKind.NeedsAttentionDecision)) {
            return await reuseNeedsAttention(context, artifacts);
        }
        const preflight = await preflightAssessment.assess(context);
        const { decision } = preflight;
        const routed =
            preflight.needsAttention === undefined
                ? undefined
                : await routeSignal(
                      context,
                      artifacts,
                      preflight.needsAttention,
                  );
        if (routed !== undefined) return routed;
        if (decision.disposition === GroundingDisposition.Actionable) {
            await artifacts.write(
                IssueArtifactKind.PreflightDecision,
                {
                    decision: { fitsOneSession: decision.fitsOneSession },
                    fingerprint,
                },
                context.signal,
            );
            return undefined;
        }
        if (decision.disposition === GroundingDisposition.Blocked) {
            return blockedOutcome(decision.blockedBy);
        }
        if (decision.disposition === GroundingDisposition.AlreadyResolved) {
            return await verifyAlreadyResolved(context, artifacts);
        }
        return await recordNeedsAttention(context, artifacts, decision);
    };

    const resumeNeedsAttention = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome | undefined> => {
        if (!artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)) {
            return undefined;
        }
        if (needsAttentionRouter === undefined) {
            throw new RalphieError({
                message:
                    "A pending needs-attention handoff requires the verifier/router service.",
            });
        }
        return await needsAttentionRouter.route({ context, artifacts });
    };

    const executeIssue = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome> => {
        await artifacts.invalidateStaleIssueDecisions(
            issueFreshnessFingerprint(context.issue),
            context.signal,
        );
        const resumed = await resumeNeedsAttention(context, artifacts);
        if (resumed !== undefined) return resumed;
        if (!artifacts.has(IssueArtifactKind.PreflightDecision)) {
            const preflightOutcome = await runPreflight(context, artifacts);
            if (preflightOutcome !== undefined) return preflightOutcome;
        }
        const { decision } = await artifacts.read(
            IssueArtifactKind.PreflightDecision,
        );
        return await executeAssessedIssue(context, artifacts, decision);
    };

    const executeAssessedIssue = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
        decision: SessionFitDecision,
    ): Promise<IssueExecutionOutcome> => {
        const input = { context, artifacts };
        if (!decision.fitsOneSession) {
            return await decompositionExecutor.execute(input);
        }

        const implementation = await implementationExecutor.execute(input);
        if (implementation.kind !== IssueExecutionOutcomeKind.Escalated) {
            return implementation;
        }

        const decomposition = await decompositionExecutor.execute(input);
        if (decomposition.kind === IssueExecutionOutcomeKind.NeedsAttention) {
            return decomposition;
        }
        if (decomposition.kind !== IssueExecutionOutcomeKind.Decomposed) {
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message: "Review escalation did not complete decomposition.",
            } as const;
        }
        return {
            ...implementation,
            childIssueNumbers: decomposition.childIssueNumbers,
        };
    };

    return {
        execute: async (context) => {
            try {
                const artifacts = await artifactStores.forIssue(
                    context.issue.number,
                    { repository: context.repository },
                    context.signal,
                );
                return await executeIssue(context, artifacts);
            } catch (error) {
                if (error instanceof DecompositionDepthLimitError) {
                    return decompositionLimitOutcome(
                        context.issue.number,
                        error,
                    );
                }
                if (error instanceof RalphieError) {
                    return {
                        kind: IssueExecutionOutcomeKind.Failed,
                        message: error.message,
                    } as const;
                }
                throw error;
            }
        },
    };
};