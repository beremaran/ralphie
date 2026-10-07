import { type ProgressReporterService } from "../../progress/ports.ts";
import { RalphieError, errorMessage } from "../../shared/error.ts";
import {
    haltingFailure,
    isAbortedSession,
    isSessionFailure,
} from "../../agent/sessions.ts";
import { DecompositionDepthLimitError } from "../domain/decomposition-markdown.ts";
import {
    IssueArtifactKind,
    issueFreshnessFingerprint,
    type IssueArtifactStoreService,
} from "./artifacts.ts";
import {
    type HandOffDecision,
    type SessionFitDecision,
    PreflightDisposition,
    type IssueResolutionDecision,
    IssueResolutionStatus,
    resolutionVerificationDecisionSchema,
} from "../domain/decisions.ts";
import type {
    IssueExecutionContext,
    IssueExecutionOutcome,
} from "./execution-model.ts";
import { IssueExecutionOutcomeKind } from "./execution-model.ts";
import type { DecompositionExecutorService } from "./decomposition-executor.ts";
import type { ImplementationExecutorService } from "./implementation-executor.ts";
import type { PreflightAssessmentService } from "./preflight.ts";
import type { ResolutionVerificationService } from "./resolution-verification.ts";
import { type HandOffRouterService } from "./hand-off.ts";
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
    handOffRouter?: HandOffRouterService,
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
            if (result.handOff !== undefined) {
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
            if (isSessionFailure(error) && context.signal?.aborted !== true) {
                throw error;
            }
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message: `Fresh resolution verification failed: ${errorMessage(error)}`,
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
            Awaited<ReturnType<PreflightAssessmentService["assess"]>>["handOff"]
        >,
    ) => {
        if (handOffRouter === undefined) {
            throw new RalphieError({
                message:
                    "A hand-off signal requires the verifier/router service.",
            });
        }
        return await handOffRouter.route({
            context,
            artifacts,
            request,
            checkpoint: await checkpoint(context),
        });
    };

    const reuseHandOff = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome> => {
        await progress?.emit({
            issue: {
                number: context.issue.number,
                title: context.issue.title,
            },
            stage: "hand-off",
            status: "skipped",
            message: `Reusing the previous hand-off decision for #${context.issue.number}; the hand-off verification session was skipped.`,
            details: { agentWorkSkipped: true },
        });
        const { decision } = await artifacts.read(
            IssueArtifactKind.HandOffDecision,
        );
        const { disposition: _disposition, ...details } = decision;
        return {
            kind: IssueExecutionOutcomeKind.HandOff,
            ...details,
            artifactPath: context.runLayout.issueArtifactsPath(
                context.issue.number,
            ),
        };
    };

    const recordHandOff = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
        decision: HandOffDecision,
    ): Promise<IssueExecutionOutcome> => {
        const fingerprint = issueFreshnessFingerprint(context.issue);
        await artifacts.write(
            IssueArtifactKind.HandOffDecision,
            {
                decision,
                fingerprint,
            },
            context.signal,
        );
        const { disposition: _disposition, ...details } = decision;
        return {
            kind: IssueExecutionOutcomeKind.HandOff,
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
        if (artifacts.has(IssueArtifactKind.HandOffDecision)) {
            return await reuseHandOff(context, artifacts);
        }
        const preflight = await preflightAssessment.assess(context);
        const { decision } = preflight;
        const routed =
            preflight.handOff === undefined
                ? undefined
                : await routeSignal(context, artifacts, preflight.handOff);
        if (routed !== undefined) return routed;
        if (decision.disposition === PreflightDisposition.Actionable) {
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
        if (decision.disposition === PreflightDisposition.Blocked) {
            return blockedOutcome(decision.blockedBy);
        }
        if (decision.disposition === PreflightDisposition.AlreadyResolved) {
            return await verifyAlreadyResolved(context, artifacts);
        }
        return await recordHandOff(context, artifacts, decision);
    };

    const resumeHandOff = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome | undefined> => {
        if (!artifacts.has(IssueArtifactKind.PendingHandOff)) {
            return undefined;
        }
        if (handOffRouter === undefined) {
            throw new RalphieError({
                message:
                    "A pending hand-off requires the verifier/router service.",
            });
        }
        return await handOffRouter.route({ context, artifacts });
    };

    const executeIssue = async (
        context: IssueExecutionContext,
        artifacts: Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>,
    ): Promise<IssueExecutionOutcome> => {
        await artifacts.invalidateStaleIssueDecisions(
            issueFreshnessFingerprint(context.issue),
            context.signal,
        );
        const resumed = await resumeHandOff(context, artifacts);
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
        if (decomposition.kind === IssueExecutionOutcomeKind.HandOff) {
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

    /**
     * A limit, outage or expired login says nothing about the issue: it is
     * deferred untouched and the run halts, so no label or comment changes.
     */
    const deferredOutcome = (
        context: IssueExecutionContext,
        error: RalphieError,
    ): IssueExecutionOutcome | undefined => {
        const failure = haltingFailure(error);
        if (failure === undefined || context.signal?.aborted === true) {
            return undefined;
        }
        return {
            kind: IssueExecutionOutcomeKind.Deferred,
            reason: error.message,
            cause: failure.kind === "auth" ? "auth" : "transient",
            ...(failure.resetHint === undefined
                ? {}
                : { resetHint: failure.resetHint }),
        };
    };

    /**
     * A failed agent session (harness error, timeout, invalid result) is a
     * human's problem and becomes a ready-for-human hand-off so the issue does
     * not re-enter the queue unchanged. Checkout and GitHub infrastructure
     * errors, and any failure after a user stop, stay Failed so the next run
     * retries.
     */
    const failOrHandOff = async (
        context: IssueExecutionContext,
        error: RalphieError,
        pendingHandOff: boolean,
    ): Promise<IssueExecutionOutcome> => {
        const failed = {
            kind: IssueExecutionOutcomeKind.Failed,
            message: error.message,
        } as const;
        if (
            handOffRouter === undefined ||
            pendingHandOff ||
            context.signal?.aborted === true ||
            !isSessionFailure(error) ||
            isAbortedSession(error)
        ) {
            return failed;
        }
        try {
            return await handOffRouter.handOffSessionFailure({
                context,
                message: error.message,
            });
        } catch {
            return failed;
        }
    };

    /** The ceiling hands off with preserved diagnostics when a router exists. */
    const handOffDepthLimit = async (
        context: IssueExecutionContext,
        error: DecompositionDepthLimitError,
    ): Promise<IssueExecutionOutcome> => {
        const limit = decompositionLimitOutcome(context.issue.number, error);
        if (
            handOffRouter === undefined ||
            limit.kind !== IssueExecutionOutcomeKind.HandOff ||
            context.signal?.aborted === true
        ) {
            return limit;
        }
        try {
            return await handOffRouter.handOffWithDecision({
                context,
                decision: {
                    disposition: PreflightDisposition.HandOff,
                    reason: limit.reason,
                    summary: limit.summary,
                    evidence: limit.evidence,
                    questions: limit.questions,
                },
            });
        } catch {
            return limit;
        }
    };

    return {
        execute: async (context) => {
            let artifacts:
                | Awaited<ReturnType<IssueArtifactStoreService["forIssue"]>>
                | undefined;
            try {
                artifacts = await artifactStores.forIssue(
                    context.issue.number,
                    { repository: context.repository },
                    context.signal,
                );
                return await executeIssue(context, artifacts);
            } catch (error) {
                if (error instanceof DecompositionDepthLimitError) {
                    return await handOffDepthLimit(context, error);
                }
                if (error instanceof RalphieError) {
                    const deferred = deferredOutcome(context, error);
                    if (deferred !== undefined) return deferred;
                    return await failOrHandOff(
                        context,
                        error,
                        artifacts?.has(IssueArtifactKind.PendingHandOff) ===
                            true,
                    );
                }
                throw error;
            }
        },
    };
};