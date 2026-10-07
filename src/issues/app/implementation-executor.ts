import { haltingFailure } from "../../agent/sessions.ts";
import type {
    GitIssueOperationError,
    GitIssueOperationsService,
    GitRemoteSafetyService,
    IssueCheckpoint,
} from "../../git/ports.ts";
import type { GitIssuePreparationService } from "../ports.ts";
import {
    type FixSession,
    newFixSession,
    recordFixTurn,
} from "./fix-session.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import type { HandOffRequest } from "../../agent/task-session.ts";
import type { ProgressReporterService } from "../../progress/ports.ts";
import { RalphieError, errorMessage } from "../../shared/error.ts";
import {
    IssueExecutionOutcomeKind,
    type WorkflowExecutorInput,
    type WorkflowExecutorResult,
} from "./execution-model.ts";
import { IssueArtifactKind, issueFreshnessFingerprint } from "./artifacts.ts";
import {
    type CommitMessageDecision,
    PreflightDisposition,
    type HandOffDecision,
    HandOffReason,
    type IssueResolutionDecision,
    IssueResolutionStatus,
} from "../domain/decisions.ts";
import type { IssueRecoveryService } from "./recovery.ts";
import type { IssueVerificationService } from "./verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./resolution-verification.ts";
import type { HandOffRouterService } from "./hand-off.ts";
import type { ReviewEvidenceFiles } from "./review-evidence.ts";
import {
    checkSignal,
    implementationBudget,
    issueProgress,
    readCheckpoint,
    stage,
} from "./implementation-stage.ts";
import {
    fallbackCommitMessage,
    handoffRequest,
    implementationPrompt,
    implementationResultSchema,
    retriesAfterTimeout,
    type RetryReason,
} from "./implementation-attempt.ts";
import { makeCandidateReview } from "./candidate-review.ts";

/** The implementation workflow for issues with the implementation route. */
export type ImplementationExecutorService = {
    readonly execute: (
        input: WorkflowExecutorInput,
    ) => Promise<WorkflowExecutorResult>;
};

const asRalphieError = (error: unknown): RalphieError => {
    if (error instanceof RalphieError) return error;
    return new RalphieError({
        message: errorMessage(error),
        cause: error,
    });
};

export const makeImplementationExecutorService = (
    preparation: GitIssuePreparationService,
    operations: GitIssueOperationsService,
    remoteSafety: GitRemoteSafetyService,
    recovery: IssueRecoveryService,
    progress: ProgressReporterService,
    verification: IssueVerificationService = {
        stagedTreeSha: async () => "0".repeat(40),
        verify: async () => ({
            stagedTreeSha: "0".repeat(40),
            commands: [
                { command: "test", exitCode: 0, stdout: "", stderr: "" },
            ],
        }),
    },
    resolutionVerification: ResolutionVerificationService = makeResolutionVerificationService(
        progress,
    ),
    handOffRouter?: HandOffRouterService,
    reviewEvidence?: ReviewEvidenceFiles,
): ImplementationExecutorService => {
    const routeSignal = async (
        input: WorkflowExecutorInput,
        request: HandOffRequest | undefined,
        checkpoint: IssueCheckpoint,
    ): Promise<WorkflowExecutorResult | undefined> => {
        if (request === undefined) return undefined;
        if (handOffRouter === undefined) {
            throw new RalphieError({
                message:
                    "A hand-off signal requires the verifier/router service.",
            });
        }
        return await handOffRouter.route({
            ...input,
            request,
            checkpoint,
        });
    };
    const resolutionOutcome = (
        resolution: IssueResolutionDecision,
    ): WorkflowExecutorResult =>
        resolution.status === IssueResolutionStatus.Resolved
            ? {
                  kind: IssueExecutionOutcomeKind.Completed,
                  completion: "already-resolved",
                  resolutionSummary: resolution.summary,
                  evidence: resolution.evidence,
              }
            : {
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: resolution.summary,
              };

    const recoverCommittedAttempt = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult | undefined> => {
        const { context, artifacts } = input;
        if (
            !artifacts.has(IssueArtifactKind.IssueCheckpoint) ||
            !artifacts.has(IssueArtifactKind.CreatedCommit)
        ) {
            return undefined;
        }

        const storedCheckpoint = await artifacts.read(
            IssueArtifactKind.IssueCheckpoint,
        );
        const createdCommit = await artifacts.read(
            IssueArtifactKind.CreatedCommit,
        );
        const actual = await context.repositoryInvariant.capture(
            context.repositoryPath,
            context.signal,
        );
        if (actual.head.toLowerCase() === createdCommit.sha.toLowerCase()) {
            await remoteSafety.verifyDirectPush({
                repository: context.repository,
                repositoryPath: context.repositoryPath,
                branch: context.targetBranch,
                intendedBaseSha: storedCheckpoint.sha,
                expectedCommitSha: createdCommit.sha,
                pushMode: "non-force",
            });
            await operations.push(
                context.repositoryPath,
                context.targetBranch,
                createdCommit.sha,
            );
            const savedReviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                ? await artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
            return {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
                commitSha: createdCommit.sha,
                reviewCount: savedReviews.length,
            } as const;
        }
        if (actual.head.toLowerCase() !== storedCheckpoint.sha.toLowerCase()) {
            throw new RalphieError({
                message: `Cannot recover issue #${context.issue.number}: checkout HEAD ${actual.head} matches neither checkpoint ${storedCheckpoint.sha} nor created commit ${createdCommit.sha}.`,
            });
        }
        return undefined;
    };

    const prepareAttempt = async (input: WorkflowExecutorInput) => {
        const { context, artifacts } = input;
        const checkpoint = await readCheckpoint(preparation, input);
        if (
            artifacts.has(IssueArtifactKind.ReviewAttempts) ||
            artifacts.has(IssueArtifactKind.CommitMessageDecision)
        ) {
            await artifacts.resetImplementationAttempt(context.signal);
        }
        const invariant = {
            branch: checkpoint.branch,
            head: checkpoint.sha,
        };
        await context.repositoryInvariant.verify(
            context.repositoryPath,
            invariant,
            context.signal,
        );
        await stage(
            progress,
            input,
            "remote-safety",
            "Checking repository push safety...",
            () =>
                remoteSafety.verifyDirectPush({
                    repository: context.repository,
                    repositoryPath: context.repositoryPath,
                    branch: context.targetBranch,
                    intendedBaseSha: checkpoint.sha,
                    pushMode: "non-force",
                }),
            "Repository push safety checks passed.",
        );
        return { checkpoint, invariant };
    };

    const runImplementation = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        checkpoint: IssueCheckpoint,
        attempt: number,
        fix: FixSession,
        retry?: RetryReason,
    ): Promise<WorkflowExecutorResult | CommitMessageDecision> => {
        const { context } = input;
        const prompt = implementationPrompt(input, attempt, retry);
        const result = await stage(
            progress,
            input,
            "implementation",
            `Implementing #${context.issue.number}...`,
            () =>
                requestStructuredOutput(context.agent, {
                    directory: context.repositoryPath,
                    title: `Implement issue #${context.issue.number}`,
                    role: "implementer",

                    schema: implementationResultSchema,
                    prompt,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "implementation",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Implementation session submitted; inspecting repository changes.",
            undefined,
            { attempt, maxAttempts: implementationBudget(context) },
        );
        recordFixTurn(fix, {
            sessionID: result.sessionID,
            consumedChars: prompt.length + result.output.summary.length,
            resumed: false,
        });
        const routed = await routeSignal(
            input,
            result.handOff ?? handoffRequest(result.output),
            checkpoint,
        );
        return (
            routed ??
            result.output.commitMessage ??
            fallbackCommitMessage(context.issue)
        );
    };

    const inspectNoChangeResolution = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        finalAttempt: boolean,
    ): Promise<
        WorkflowExecutorResult | { readonly unresolvedSummary: string }
    > => {
        const { context, artifacts } = input;
        const resolution = await resolutionVerification.verify(context);
        const routed = await routeSignal(input, resolution.handOff, checkpoint);
        if (routed !== undefined) return routed;
        const outcome = resolutionOutcome(resolution.decision);
        if (
            outcome.kind === IssueExecutionOutcomeKind.Failed &&
            !finalAttempt
        ) {
            return { unresolvedSummary: outcome.message };
        }
        await artifacts.write(
            IssueArtifactKind.IssueResolutionDecision,
            {
                decision: resolution.decision,
                fingerprint: issueFreshnessFingerprint(context.issue),
            },
            context.signal,
        );
        return outcome.kind === IssueExecutionOutcomeKind.Failed
            ? {
                  ...outcome,
                  message: `Issue remains unresolved after ${implementationBudget(context)} no-change implementation attempts: ${outcome.message}`,
                  exhausted: true,
              }
            : outcome;
    };
    const candidateReview = makeCandidateReview({
        operations,
        remoteSafety,
        recovery,
        progress,
        verification,
        reviewEvidence,
        routeSignal,
    });

    /** A timeout is a failed attempt: it retries while attempts remain. */
    const runImplementationOrTimeout = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        checkpoint: IssueCheckpoint,
        attempt: number,
        fix: FixSession,
        retry: RetryReason | undefined,
    ): Promise<
        WorkflowExecutorResult | CommitMessageDecision | "timed-out"
    > => {
        try {
            return await runImplementation(
                input,
                invariant,
                checkpoint,
                attempt,
                fix,
                retry,
            );
        } catch (error) {
            if (
                !retriesAfterTimeout(
                    error,
                    attempt,
                    implementationBudget(input.context),
                    input.context.signal,
                )
            ) {
                throw error;
            }
            return "timed-out";
        }
    };

    /** Stage the attempt: review staged changes, or verify a no-change result. */
    const stageAndInspect = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        invariant: { readonly branch: string; readonly head: string },
        fix: FixSession,
        commitMessage: CommitMessageDecision,
        attempt: number,
    ): Promise<
        WorkflowExecutorResult | { readonly unresolvedSummary: string }
    > => {
        const { context } = input;
        const maximumAttempts = implementationBudget(context);
        checkSignal(context.signal);
        await stage(
            progress,
            input,
            "change-staging",
            `Inspecting and staging implementation attempt ${attempt}...`,
            () => operations.stageAll(context.repositoryPath),
            `Implementation attempt ${attempt} inspected.`,
            undefined,
            { attempt, maxAttempts: maximumAttempts },
        );
        if (await operations.hasStagedChanges(context.repositoryPath)) {
            await input.artifacts.write(
                IssueArtifactKind.CommitMessageDecision,
                commitMessage,
                context.signal,
            );
            return await candidateReview.run(input, checkpoint, invariant, fix);
        }
        return await inspectNoChangeResolution(
            input,
            checkpoint,
            attempt === maximumAttempts,
        );
    };

    const runImplementationAttempts = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
        const maximumAttempts = implementationBudget(context);
        const fix = newFixSession(context.agent.roles.implementer.harness);
        let retry: RetryReason | undefined;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            const implementation = await runImplementationOrTimeout(
                input,
                invariant,
                checkpoint,
                attempt,
                fix,
                retry,
            );
            if (implementation === "timed-out") {
                retry = { kind: "timeout" };
                continue;
            }
            if ("kind" in implementation) return implementation;
            const outcome = await stageAndInspect(
                input,
                checkpoint,
                invariant,
                fix,
                implementation,
                attempt,
            );
            if ("unresolvedSummary" in outcome) {
                retry = {
                    kind: "unresolved",
                    summary: outcome.unresolvedSummary,
                };
                continue;
            }
            return outcome;
        }
        throw new RalphieError({
            message: "Implementation retry loop ended unexpectedly.",
        });
    };

    /**
     * Every terminal failure is a human's problem, whether the attempts ran
     * out, a review loop stalled or a session failed: preserve diagnostics,
     * restore the clean checkout and hand the issue off as ready-for-human so
     * it never re-enters the queue unchanged.
     */
    const handOffWhenExhausted = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        result: WorkflowExecutorResult,
    ): Promise<WorkflowExecutorResult> => {
        if (result.kind !== IssueExecutionOutcomeKind.Failed) return result;
        const { context } = input;
        const decision: HandOffDecision = {
            disposition: PreflightDisposition.HandOff,
            reason: HandOffReason.ImplementationExhausted,
            summary: `Ralphie could not finish issue #${context.issue.number}: ${result.message}`,
            evidence: [result.message],
            questions: [
                "Review the preserved diagnostics, then finish the change by hand or rewrite the issue so an agent can complete it.",
            ],
        };
        const { disposition: _disposition, ...details } = decision;
        const recovered = await recovery.handleHandOff({
            runId: context.runId,
            repository: context.repository,
            workspace: context.workspace,
            repositoryPath: context.repositoryPath,
            issue: context.issue,
            checkpoint,
            fingerprint: issueFreshnessFingerprint(context.issue),
            decision,
            repositoryInvariant: context.repositoryInvariant,
            signal: context.signal,
        });
        return {
            kind: IssueExecutionOutcomeKind.HandOff,
            ...details,
            diagnosticsPath: recovered.diagnosticsPath,
        };
    };

    /** Session and git failures become a Failed result; aborts and halting
     * (limit, outage, login) failures still throw. */
    const runAttemptsOrFail = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        try {
            return await runImplementationAttempts(
                input,
                checkpoint,
                invariant,
            );
        } catch (error) {
            if (
                input.context.signal?.aborted === true ||
                haltingFailure(error) !== undefined
            ) {
                throw error;
            }
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message: asRalphieError(error).message,
            };
        }
    };

    const executeImplementation = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        checkSignal(context.signal);
        if (artifacts.has(IssueArtifactKind.IssueResolutionDecision)) {
            const resolution = await artifacts.read(
                IssueArtifactKind.IssueResolutionDecision,
            );
            if (resolution.decision.status === IssueResolutionStatus.Resolved) {
                return resolutionOutcome(resolution.decision);
            }
            await artifacts.clearUnresolvedResolutionDecision(context.signal);
        }

        const recovered = await recoverCommittedAttempt(input);
        if (recovered !== undefined) return recovered;

        const { checkpoint, invariant } = await prepareAttempt(input);
        return await handOffWhenExhausted(
            input,
            checkpoint,
            await runAttemptsOrFail(input, checkpoint, invariant),
        );
    };

    return {
        execute: async (input) => {
            try {
                await input.artifacts.invalidateStaleIssueDecisions(
                    issueFreshnessFingerprint(input.context.issue),
                    input.context.signal,
                );
                return await executeImplementation(input);
            } catch (error) {
                throw asRalphieError(
                    error as GitIssueOperationError | RalphieError,
                );
            }
        },
    };
};