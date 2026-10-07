import { type IssueCheckpoint } from "../../git/ports.ts";
import { buildHandOffVerificationPrompt } from "../../agent/prompts.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import type { HandOffRequest } from "../../agent/task-session.ts";
import { RalphieError } from "../../shared/error.ts";
import {
    IssueArtifactKind,
    issueFreshnessFingerprintSchema,
    type IssueArtifactStore,
    type IssueFreshnessFingerprint,
    type PendingHandOffArtifact,
} from "./artifacts.ts";
import {
    PreflightDisposition,
    handOffVerificationSchema,
    HandOffReason,
    type HandOffDecision,
} from "../domain/decisions.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
    type IssueExecutionOutcome,
} from "./execution-model.ts";
import type { IssueRecoveryService } from "./recovery.ts";

export type HandOffRouteInput = {
    readonly context: IssueExecutionContext;
    readonly artifacts: IssueArtifactStore;
    readonly request?: HandOffRequest;
    readonly checkpoint?: IssueCheckpoint;
};

export type HandOffRouterService = {
    readonly route: (
        input: HandOffRouteInput,
    ) => Promise<IssueExecutionOutcome | undefined>;
    /**
     * Hand the issue off after an agent session failed before any hand-off
     * could be requested, preserving diagnostics at the current checkout.
     */
    readonly handOffSessionFailure: (input: {
        readonly context: IssueExecutionContext;
        readonly message: string;
    }) => Promise<IssueExecutionOutcome>;
    /**
     * Hand the issue off with a decision Ralphie itself reached (such as the
     * decomposition depth limit), preserving diagnostics at the current
     * checkout so the hand-off comment has a real location.
     */
    readonly handOffWithDecision: (input: {
        readonly context: IssueExecutionContext;
        readonly decision: HandOffDecision;
    }) => Promise<IssueExecutionOutcome>;
};

export const issueFreshnessFingerprint = (
    context: IssueExecutionContext,
): IssueFreshnessFingerprint => {
    const parsed = issueFreshnessFingerprintSchema.safeParse({
        ...(context.issue.updatedAt === undefined
            ? {}
            : { updatedAt: context.issue.updatedAt }),
        ...(context.issue.commentCount === undefined
            ? {}
            : { commentCount: context.issue.commentCount }),
        ...(context.issue.commentVersion === undefined
            ? {}
            : { commentVersion: context.issue.commentVersion }),
    });
    if (parsed.success) return parsed.data as IssueFreshnessFingerprint;
    throw new RalphieError({
        message: `Issue #${context.issue.number} does not have a valid freshness fingerprint; hand-off verification requires updatedAt and a comment count or comment version.`,
        cause: parsed.error,
    });
};

const verificationPrompt = (
    context: IssueExecutionContext,
    request: HandOffRequest,
): string => `${buildHandOffVerificationPrompt({
    issue: context.issue,
    repositoryPath: context.repositoryPath,
    targetBranch: context.targetBranch,
})}

An earlier agent made this bounded hand-off request:
<hand-off-request>${JSON.stringify(request)}</hand-off-request>
Independently verify the request and submit the pre-flight disposition with the required tool.`;

const outcome = (
    decision: HandOffDecision,
    diagnosticsPath: string,
): IssueExecutionOutcome => {
    const { disposition: _disposition, ...details } = decision;
    return {
        kind: IssueExecutionOutcomeKind.HandOff,
        ...details,
        diagnosticsPath,
    };
};

const loadHandoff = async (
    input: HandOffRouteInput,
    fingerprint: IssueFreshnessFingerprint,
): Promise<PendingHandOffArtifact | undefined> => {
    const { artifacts, request, checkpoint } = input;
    await artifacts.invalidateStaleHandOffDecision(
        fingerprint,
        input.context.signal,
    );
    if (request !== undefined) {
        if (checkpoint === undefined) {
            throw new RalphieError({
                message:
                    "Hand-off routing requires the original request and clean checkpoint.",
            });
        }
        const handoff = { request, checkpoint, fingerprint };
        await artifacts.beginPendingHandOff(handoff, input.context.signal);
        return handoff;
    }
    if (!artifacts.has(IssueArtifactKind.PendingHandOff)) {
        return undefined;
    }
    return await artifacts.read(IssueArtifactKind.PendingHandOff);
};

const verifyHandoff = async (
    input: HandOffRouteInput,
    handoff: PendingHandOffArtifact,
): Promise<HandOffDecision | undefined> => {
    const { context, artifacts } = input;
    if (artifacts.has(IssueArtifactKind.HandOffDecision)) {
        return (await artifacts.read(IssueArtifactKind.HandOffDecision))
            .decision;
    }
    const verified = await requestStructuredOutput(context.agent, {
        directory: context.repositoryPath,
        title: `Verify hand-off request for issue #${context.issue.number}`,
        prompt: verificationPrompt(context, handoff.request),
        schema: handOffVerificationSchema,
        role: "preflight",
        repositoryInvariant: {
            branch: handoff.checkpoint.branch,
            head: handoff.checkpoint.sha,
        },
        verifyRepositoryInvariant: context.repositoryInvariant.verify,
        signal: context.signal,
    });
    if (verified.output.disposition !== PreflightDisposition.HandOff) {
        await artifacts.clearPendingHandOff(context.signal);
        return undefined;
    }
    await artifacts.recordHandOffDecision(
        {
            decision: verified.output,
            fingerprint: handoff.fingerprint,
        },
        context.signal,
    );
    return verified.output;
};

const recoverHandoff = async (
    input: HandOffRouteInput,
    handoff: PendingHandOffArtifact,
    decision: HandOffDecision,
    recovery: IssueRecoveryService,
): Promise<IssueExecutionOutcome> => {
    const { context, artifacts } = input;
    const recovered = await recovery.handleHandOff({
        runId: context.runId,
        repository: context.repository,
        workspace: context.workspace,
        repositoryPath: context.repositoryPath,
        issue: context.issue,
        checkpoint: handoff.checkpoint,
        fingerprint: handoff.fingerprint,
        decision,
        request: handoff.request,
        repositoryInvariant: context.repositoryInvariant,
        signal: context.signal,
    });
    await artifacts.clearPendingHandOff(context.signal);
    return outcome(decision, recovered.diagnosticsPath);
};

export const makeHandOffRouterService = (
    recovery: IssueRecoveryService,
): HandOffRouterService => {
    const handOffWithDecision: HandOffRouterService["handOffWithDecision"] =
        async ({ context, decision }) => {
            const captured = await context.repositoryInvariant.capture(
                context.repositoryPath,
                context.signal,
            );
            const recovered = await recovery.handleHandOff({
                runId: context.runId,
                repository: context.repository,
                workspace: context.workspace,
                repositoryPath: context.repositoryPath,
                issue: context.issue,
                checkpoint: { branch: captured.branch, sha: captured.head },
                fingerprint: issueFreshnessFingerprint(context),
                decision,
                repositoryInvariant: context.repositoryInvariant,
                signal: context.signal,
            });
            return outcome(decision, recovered.diagnosticsPath);
        };
    return {
        handOffWithDecision,
        handOffSessionFailure: async ({ context, message }) =>
            handOffWithDecision({
                context,
                decision: {
                    disposition: PreflightDisposition.HandOff,
                    reason: HandOffReason.NeedsHumanJudgment,
                    summary: `An agent session failed while Ralphie was working on issue #${context.issue.number}: ${message}`,
                    evidence: [message],
                    questions: [
                        "Check the harness and model configuration and the preserved diagnostics, then relabel the issue ready-for-agent to retry or handle it by hand.",
                    ],
                },
            }),
        route: async ({ context, artifacts, request, checkpoint }) => {
            if (
                request === undefined &&
                !artifacts.has(IssueArtifactKind.PendingHandOff)
            ) {
                return undefined;
            }
            const fingerprint = issueFreshnessFingerprint(context);
            const input = { context, artifacts, request, checkpoint };
            const handoff = await loadHandoff(input, fingerprint);
            if (handoff === undefined) return undefined;
            const decision = await verifyHandoff(input, handoff);
            if (decision === undefined) return undefined;
            return await recoverHandoff(input, handoff, decision, recovery);
        },
    };
};