import {
    IssueArtifactKind,
    issueFreshnessFingerprint,
    issueArtifactPath,
    makeIssueArtifactStore,
    sameIssueFreshnessFingerprint,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
    type IssueFreshnessFingerprint,
} from "./artifacts.ts";
import type { ComplexityAssessmentService } from "./complexity.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    NeedsAttentionReason,
    type ComplexityDecision,
    type GroundingDecision,
} from "./decisions.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type {
    IssueExecutionContext,
    IssueExecutionOutcome,
} from "./execution.ts";
import type { GroundingAssessmentService } from "./grounding.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import type { PiNeedsAttentionRequest } from "../agent/task-session.ts";
import type { DecompositionPlannerService } from "./decomposition-planner.ts";
import type { DecompositionOperationPlan } from "./decomposition-plan.ts";

export type DryRunIssueExecutorService = {
    readonly execute: (
        context: IssueExecutionContext,
    ) => Promise<IssueExecutionOutcome>;
};

type DryRunFactorySecondArgument =
    | ComplexityAssessmentService
    | GroundingAssessmentService;
type DryRunFactoryThirdArgument =
    | ProgressReporterService
    | ComplexityAssessmentService;
type DryRunFactoryFourthArgument =
    | ProgressReporterService
    | GroundingAssessmentService;

const isProgressReporter = (
    value: DryRunFactoryThirdArgument,
): value is ProgressReporterService =>
    "emit" in value && "stopPersisting" in value;

const issueScope = (context: IssueExecutionContext) => ({
    workspace: context.workspace,
    runId: context.runId,
    repository: context.repository,
});

type DryRunArtifactAccess = {
    readonly store: IssueArtifactStore;
    /** True only when the service explicitly loaded a durable read-only view. */
    readonly hasPersistedSource: boolean;
};

const readOnlyArtifactsFor = async (
    artifactStores: IssueArtifactStoreService,
    context: IssueExecutionContext,
): Promise<DryRunArtifactAccess> => {
    if (artifactStores.forIssueReadOnly === undefined) {
        // A writable loader may migrate or invalidate a durable record while
        // opening it. Use an explicitly memory-only store when the service
        // cannot provide a read-only loader.
        return {
            store: await makeIssueArtifactStore(context.issue.number),
            hasPersistedSource: false,
        };
    }
    return {
        store: await artifactStores.forIssueReadOnly(
            context.issue.number,
            issueScope(context),
        ),
        hasPersistedSource: true,
    };
};

const matchingPersistedGrounding = async (
    artifacts: IssueArtifactStore,
    fingerprint: IssueFreshnessFingerprint,
): Promise<GroundingDecision | undefined> => {
    if (!artifacts.has(IssueArtifactKind.NeedsAttentionDecision)) {
        return undefined;
    }
    const artifact = await artifacts.read(
        IssueArtifactKind.NeedsAttentionDecision,
    );
    return sameIssueFreshnessFingerprint(artifact.fingerprint, fingerprint)
        ? (artifact.decision as unknown as GroundingDecision)
        : undefined;
};

type DryRunGrounding = {
    readonly decision: GroundingDecision;
    readonly persisted: boolean;
};

const groundingFor = async (
    context: IssueExecutionContext,
    artifacts: IssueArtifactStore,
    hasPersistedSource: boolean,
    groundingAssessment: GroundingAssessmentService | undefined,
    progress: ProgressReporterService,
): Promise<DryRunGrounding | undefined> => {
    if (groundingAssessment === undefined) return undefined;

    const persisted = await matchingPersistedGrounding(
        artifacts,
        issueFreshnessFingerprint(context.issue),
    );
    if (persisted !== undefined) {
        await progress.emit({
            issue: {
                number: context.issue.number,
                title: context.issue.title,
            },
            stage: "grounding",
            status: "skipped",
            message: `Reusing the previous grounding decision for #${context.issue.number}; agent grounding was skipped.`,
            details: {
                dryRun: true,
                disposition: persisted.disposition,
                agentWorkSkipped: true,
            },
        });
        return { decision: persisted, persisted: hasPersistedSource };
    }

    return {
        decision: (await groundingAssessment.assess(context)).decision,
        persisted: false,
    };
};

const complexityFor = async (
    context: IssueExecutionContext,
    artifacts: IssueArtifactStore,
    assessment: ComplexityAssessmentService,
    progress: ProgressReporterService,
): Promise<ComplexityDecision> => {
    if (artifacts.has(IssueArtifactKind.ComplexityDecision)) {
        const artifact = await artifacts.read(
            IssueArtifactKind.ComplexityDecision,
        );
        if (
            sameIssueFreshnessFingerprint(
                artifact.fingerprint,
                issueFreshnessFingerprint(context.issue),
            )
        ) {
            await progress.emit({
                issue: {
                    number: context.issue.number,
                    title: context.issue.title,
                },
                stage: "complexity-assessment",
                status: "skipped",
                message: `Reusing the previous complexity decision for #${context.issue.number}; agent assessment was skipped.`,
                details: {
                    dryRun: true,
                    complexity: artifact.decision.complexity,
                    agentWorkSkipped: true,
                },
            });
            return artifact.decision;
        }
    }
    return (await assessment.assess(context)).decision;
};

const routeForComplexity = (complexity: ComplexityLevel) =>
    complexity <= ComplexityLevel.Level3
        ? ("implementation" as const)
        : ("decomposition" as const);

const routeDetails = (
    context: IssueExecutionContext,
    route:
        | "implementation"
        | "decomposition"
        | "already-resolved"
        | "needs-attention",
    grounding: GroundingDecision | undefined,
    complexity?: ComplexityLevel,
): Readonly<Record<string, unknown>> => ({
    dryRun: true,
    route,
    ...(grounding === undefined ? {} : { grounding: grounding.disposition }),
    ...(complexity === undefined ? {} : { complexity }),
    ...(context.needsAttentionPolicy === undefined
        ? {}
        : { policy: context.needsAttentionPolicy }),
});

const reportRoute = async (
    context: IssueExecutionContext,
    progress: ProgressReporterService,
    route:
        | "implementation"
        | "decomposition"
        | "already-resolved"
        | "needs-attention",
    grounding: GroundingDecision | undefined,
    complexity?: ComplexityLevel,
): Promise<void> => {
    const details = routeDetails(context, route, grounding, complexity);
    const message =
        route === "needs-attention" &&
        grounding?.disposition === "needs_attention"
            ? `Dry run would route #${context.issue.number} to needs-attention (${grounding.reason}): ${grounding.summary}`
            : `Dry run would route #${context.issue.number} to ${route}${
                  complexity === undefined
                      ? ""
                      : ` (complexity ${complexity}/5)`
              }.`;
    await progress.emit({
        issue: {
            number: context.issue.number,
            title: context.issue.title,
        },
        stage: "issue-planning",
        status: "info",
        message,
        details: {
            ...details,
            ...(grounding?.disposition === GroundingDisposition.NeedsAttention
                ? {
                      reason: grounding.reason,
                      summary: grounding.summary,
                      evidence: [...grounding.evidence],
                      questions: [...grounding.questions],
                  }
                : {}),
        },
    });
};

const needsAttentionOutcome = (
    context: IssueExecutionContext,
    decision: Extract<
        GroundingDecision,
        { disposition: GroundingDisposition.NeedsAttention }
    >,
    persisted: boolean,
): IssueExecutionOutcome => {
    const outcome = {
        kind: IssueExecutionOutcomeKind.NeedsAttention as const,
        route: "needs-attention" as const,
        reason: decision.reason,
        summary: decision.summary,
        evidence: [...decision.evidence],
        questions: [...decision.questions],
        ...(context.needsAttentionPolicy === undefined
            ? {}
            : { policy: context.needsAttentionPolicy }),
    };
    return persisted
        ? {
              ...outcome,
              artifactPath: issueArtifactPath(
                  issueScope(context),
                  context.issue.number,
              ),
          }
        : outcome;
};

const PI_REASON_TO_NEEDS_ATTENTION: Readonly<
    Record<string, NeedsAttentionReason>
> = Object.fromEntries(
    Object.values(NeedsAttentionReason).map((reason) => [reason, reason]),
);

/** Pi signal reasons and decision reasons share the same value set. */
const needsAttentionReasonFor = (reason: string): NeedsAttentionReason =>
    PI_REASON_TO_NEEDS_ATTENTION[reason] ??
    NeedsAttentionReason.MissingInformation;

/**
 * Report an unverified needs-attention signal from the read-only planning
 * session. Dry runs never invoke recovery, so the signal is reported as the
 * route a real run would take after read-only verification.
 */
const decompositionSignalOutcome = (
    context: IssueExecutionContext,
    request: PiNeedsAttentionRequest,
): IssueExecutionOutcome => {
    const summary =
        request.message ?? "The decomposition session requested attention.";
    return {
        kind: IssueExecutionOutcomeKind.NeedsAttention,
        route: "needs-attention",
        reason: needsAttentionReasonFor(request.reason),
        summary,
        evidence: [summary],
        questions: [
            "A real run would verify this signal with the read-only needs-attention verifier before routing.",
        ],
        ...(context.needsAttentionPolicy === undefined
            ? {}
            : { policy: context.needsAttentionPolicy }),
    };
};

const reportDecompositionSignal = async (
    context: IssueExecutionContext,
    progress: ProgressReporterService,
    request: PiNeedsAttentionRequest,
): Promise<void> => {
    await progress.emit({
        issue: {
            number: context.issue.number,
            title: context.issue.title,
        },
        stage: "issue-planning",
        status: "info",
        message: `Dry run: the decomposition session for #${context.issue.number} requested attention (${request.reason})${request.message === undefined ? "." : `: ${request.message}`}`,
        details: {
            dryRun: true,
            route: "needs-attention",
            reason: request.reason,
            ...(request.message === undefined
                ? {}
                : { summary: request.message }),
            ...(context.needsAttentionPolicy === undefined
                ? {}
                : { policy: context.needsAttentionPolicy }),
        },
    });
};

const plannedDecompositionDetails = (
    context: IssueExecutionContext,
    grounding: GroundingDecision | undefined,
    complexity: ComplexityLevel,
    plan: DecompositionOperationPlan,
): Readonly<Record<string, unknown>> => ({
    dryRun: true,
    route: "decomposition",
    ...(grounding === undefined ? {} : { grounding: grounding.disposition }),
    complexity,
    ...(context.needsAttentionPolicy === undefined
        ? {}
        : { policy: context.needsAttentionPolicy }),
    operations: {
        createChildren: plan.counts.create,
        reuseChildren: plan.counts.reuse,
        attachSubIssues: plan.counts.attachSubIssues,
        dependencyEdges: plan.counts.dependencies,
        parentStaysOpen: plan.parentStaysOpen,
    },
    lineage: plan.lineage,
    children: plan.children,
    dependencies: plan.dependencyEdges,
});

const reportPlannedDecomposition = async (
    context: IssueExecutionContext,
    progress: ProgressReporterService,
    grounding: GroundingDecision | undefined,
    complexity: ComplexityLevel,
    plan: DecompositionOperationPlan,
): Promise<void> => {
    const { counts } = plan;
    await progress.emit({
        issue: {
            number: context.issue.number,
            title: context.issue.title,
        },
        stage: "issue-planning",
        status: "info",
        message:
            `Dry run would decompose #${context.issue.number} into ` +
            `${counts.create} new and ${counts.reuse} reused child issues, ` +
            `attach ${counts.attachSubIssues} native sub-issues, and create ` +
            `${counts.dependencies} dependency edges; the parent would stay open.`,
        details: plannedDecompositionDetails(
            context,
            grounding,
            complexity,
            plan,
        ),
    });
};

const plannedDecompositionOutcome = async (
    context: IssueExecutionContext,
    progress: ProgressReporterService,
    planner: DecompositionPlannerService,
    grounding: GroundingDecision | undefined,
    complexity: ComplexityLevel,
): Promise<IssueExecutionOutcome> => {
    const planned = await planner.plan(context);
    if (planned.kind === "needs-attention") {
        await reportDecompositionSignal(context, progress, planned.request);
        return decompositionSignalOutcome(context, planned.request);
    }
    await reportPlannedDecomposition(
        context,
        progress,
        grounding,
        complexity,
        planned.operations,
    );
    const { counts } = planned.operations;
    return {
        kind: IssueExecutionOutcomeKind.Skipped,
        route: "decomposition",
        reason:
            `Dry run: complexity ${complexity}/5 would use the decomposition workflow ` +
            `(create ${counts.create}, reuse ${counts.reuse}, ` +
            `${counts.dependencies} dependency edges); no mutation was performed.`,
    };
};

const executeDryRun = async (
    context: IssueExecutionContext,
    artifacts: DryRunArtifactAccess,
    assessment: ComplexityAssessmentService,
    groundingAssessment: GroundingAssessmentService | undefined,
    progress: ProgressReporterService,
    planner?: DecompositionPlannerService,
): Promise<IssueExecutionOutcome> => {
    const grounding = await groundingFor(
        context,
        artifacts.store,
        artifacts.hasPersistedSource,
        groundingAssessment,
        progress,
    );
    const groundingDecision = grounding?.decision;
    if (
        groundingDecision?.disposition === GroundingDisposition.NeedsAttention
    ) {
        await reportRoute(
            context,
            progress,
            "needs-attention",
            groundingDecision,
        );
        return needsAttentionOutcome(
            context,
            groundingDecision,
            grounding?.persisted === true,
        );
    }
    if (
        groundingDecision?.disposition === GroundingDisposition.AlreadyResolved
    ) {
        await reportRoute(
            context,
            progress,
            "already-resolved",
            groundingDecision,
        );
        return {
            kind: IssueExecutionOutcomeKind.Skipped,
            route: "already-resolved",
            reason: "Dry run: the issue is already resolved and would use already-resolved handling; no mutation was performed.",
        };
    }

    const decision = await complexityFor(
        context,
        artifacts.store,
        assessment,
        progress,
    );
    const route = routeForComplexity(decision.complexity);
    if (route === "decomposition" && planner !== undefined) {
        return await plannedDecompositionOutcome(
            context,
            progress,
            planner,
            groundingDecision,
            decision.complexity,
        );
    }
    await reportRoute(
        context,
        progress,
        route,
        groundingDecision,
        decision.complexity,
    );
    return {
        kind: IssueExecutionOutcomeKind.Skipped,
        route,
        reason: `Dry run: complexity ${decision.complexity}/5 would use the ${route} workflow; no mutation was performed.`,
    };
};

export function makeDryRunIssueExecutorService(
    artifactStores: IssueArtifactStoreService,
    assessment: ComplexityAssessmentService,
    progress: ProgressReporterService,
    groundingAssessment?: GroundingAssessmentService,
    planner?: DecompositionPlannerService,
): DryRunIssueExecutorService;
export function makeDryRunIssueExecutorService(
    artifactStores: IssueArtifactStoreService,
    groundingAssessment: GroundingAssessmentService,
    assessment: ComplexityAssessmentService,
    progress: ProgressReporterService,
    planner?: DecompositionPlannerService,
): DryRunIssueExecutorService;
export function makeDryRunIssueExecutorService(
    artifactStores: IssueArtifactStoreService,
    second: DryRunFactorySecondArgument,
    third: DryRunFactoryThirdArgument,
    fourth?: DryRunFactoryFourthArgument,
    planner?: DecompositionPlannerService,
): DryRunIssueExecutorService {
    const usingCurrentOrder = fourth === undefined || isProgressReporter(third);
    const assessment = (
        usingCurrentOrder ? second : third
    ) as ComplexityAssessmentService;
    const progress = (
        usingCurrentOrder ? third : fourth
    ) as ProgressReporterService;
    const groundingAssessment = usingCurrentOrder
        ? (fourth as GroundingAssessmentService | undefined)
        : (second as GroundingAssessmentService);

    return {
        execute: async (context) => {
            const artifacts = await readOnlyArtifactsFor(
                artifactStores,
                context,
            );
            return await executeDryRun(
                context,
                artifacts,
                assessment,
                groundingAssessment,
                progress,
                planner,
            );
        },
    };
}

export const DryRunIssueExecutorLive = makeDryRunIssueExecutorService;