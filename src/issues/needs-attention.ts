import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { buildGroundingPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { NeedsAttentionRequest } from "../agent/task-session.ts";
import { RalphieError } from "../shared/error.ts";
import {
    IssueArtifactKind,
    issueFreshnessFingerprintSchema,
    type IssueArtifactStore,
    type IssueFreshnessFingerprint,
    type NeedsAttentionHandoffArtifact,
} from "./artifacts.ts";
import {
    GroundingDisposition,
    groundingDecisionSchema,
    type NeedsAttentionDecision,
} from "./decisions.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
    type IssueExecutionOutcome,
} from "./execution.ts";
import type { IssueRecoveryService } from "./recovery.ts";

export type NeedsAttentionRouteInput = {
    readonly context: IssueExecutionContext;
    readonly artifacts: IssueArtifactStore;
    readonly request?: NeedsAttentionRequest;
    readonly checkpoint?: IssueCheckpoint;
};

export type NeedsAttentionRouterService = {
    readonly route: (
        input: NeedsAttentionRouteInput,
    ) => Promise<IssueExecutionOutcome | undefined>;
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
        message: `Issue #${context.issue.number} does not have a valid freshness fingerprint; needs-attention verification requires updatedAt and a comment count or comment version.`,
        cause: parsed.error,
    });
};

const verificationPrompt = (
    context: IssueExecutionContext,
    request: NeedsAttentionRequest,
): string => `${buildGroundingPrompt({
    issue: context.issue,
    repositoryPath: context.repositoryPath,
    targetBranch: context.targetBranch,
})}

An earlier agent made this bounded needs-attention request:
<needs-attention-request>${JSON.stringify(request)}</needs-attention-request>
Independently verify the request. Return the grounding disposition as a fenced json block only.`;

const outcome = (
    decision: NeedsAttentionDecision,
    diagnosticsPath: string,
): IssueExecutionOutcome => {
    const { disposition: _disposition, ...details } = decision;
    return {
        kind: IssueExecutionOutcomeKind.NeedsAttention,
        ...details,
        diagnosticsPath,
    };
};

const loadHandoff = async (
    input: NeedsAttentionRouteInput,
    fingerprint: IssueFreshnessFingerprint,
): Promise<NeedsAttentionHandoffArtifact | undefined> => {
    const { artifacts, request, checkpoint } = input;
    await artifacts.invalidateStaleNeedsAttentionDecision(fingerprint);
    if (request !== undefined) {
        if (checkpoint === undefined) {
            throw new RalphieError({
                message:
                    "Needs-attention routing requires the original request and clean checkpoint.",
            });
        }
        const handoff = { request, checkpoint, fingerprint };
        await artifacts.beginNeedsAttentionHandoff(handoff);
        return handoff;
    }
    if (!artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)) {
        return undefined;
    }
    return await artifacts.read(IssueArtifactKind.NeedsAttentionHandoff);
};

const verifyHandoff = async (
    input: NeedsAttentionRouteInput,
    handoff: NeedsAttentionHandoffArtifact,
): Promise<NeedsAttentionDecision | undefined> => {
    const { context, artifacts } = input;
    if (artifacts.has(IssueArtifactKind.NeedsAttentionDecision)) {
        return (await artifacts.read(IssueArtifactKind.NeedsAttentionDecision))
            .decision;
    }
    const verified = await requestStructuredOutput(context.agent, {
        directory: context.repositoryPath,
        title: `Verify needs-attention request for issue #${context.issue.number}`,
        prompt: verificationPrompt(context, handoff.request),
        schema: groundingDecisionSchema,
        agent: context.agentSelection.agent,
        model: context.agentSelection.model,
        variant:
            context.agentStageVariants?.grounding ??
            context.agentSelection.variant,
        runId: context.runId,
        diagnostics: context.agentDiagnostics,
        repositoryInvariant: {
            branch: handoff.checkpoint.branch,
            head: handoff.checkpoint.sha,
        },
        verifyRepositoryInvariant: context.repositoryInvariant.verify,
        signal: context.signal,
    });
    if (verified.output.disposition !== GroundingDisposition.NeedsAttention) {
        await artifacts.clearNeedsAttentionHandoff();
        return undefined;
    }
    await artifacts.recordNeedsAttentionDecision({
        decision: verified.output,
        fingerprint: handoff.fingerprint,
    });
    return verified.output;
};

const recoverHandoff = async (
    input: NeedsAttentionRouteInput,
    handoff: NeedsAttentionHandoffArtifact,
    decision: NeedsAttentionDecision,
    recovery: IssueRecoveryService,
): Promise<IssueExecutionOutcome> => {
    const { context, artifacts } = input;
    const recovered = await recovery.handleNeedsAttention({
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
    await artifacts.clearNeedsAttentionHandoff();
    return outcome(decision, recovered.diagnosticsPath);
};

export const makeNeedsAttentionRouterService = (
    recovery: IssueRecoveryService,
): NeedsAttentionRouterService => ({
    route: async ({ context, artifacts, request, checkpoint }) => {
        if (
            request === undefined &&
            !artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)
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
});

export const NeedsAttentionRouterLive = makeNeedsAttentionRouterService;