/**
 * Focused maintenance issue lifecycle.
 *
 * Owns the plan → validate → reconcile → replan → persist transitions for one
 * maintenance run. Planning and validation semantics stay with the planner
 * module, mutation semantics stay with the two GitHub action-policy modules,
 * and durable state shape/resume protocol stay with the state module.
 */
import {
    maintenanceActionKey,
    validateIssueMaintenancePlan,
    type MaintenancePlanService,
    type ValidatedIssueMaintenanceAction,
    type ValidatedIssueMaintenancePlan,
} from "./maintain-issues-plan.ts";
import type {
    MaintenanceCandidate,
    MaintenanceCandidateAnalysis,
} from "./maintain-issues-candidates.ts";
import { type MaintenanceSnapshot } from "./maintain-issues-snapshot-service.ts";
import {
    type MaintenanceActionState,
    type MaintenanceIssueState,
    type MaintenanceReconciliationState,
    type MaintenanceRunState,
    type MaintenanceSelectionState,
    type MaintenanceStoredPlan,
} from "./maintain-issues-state.ts";
import { type RelationshipMutationResult } from "./github/issue-maintenance-relationships.ts";
import { type MaintenanceMutationResult } from "./github/issue-maintenance.ts";
import { type MaintenanceRuntime } from "./runtime.ts";
import { type DuplicateAction } from "./options.ts";
import { type MaintainIssuesRalphieConfig } from "./options.ts";
import {
    type ProgressIssue,
    type ProgressReporterService,
} from "./progress/progress.ts";
import { RalphieError } from "./shared/error.ts";

export const MAINTENANCE_MAX_REPLANS = 2;

export type MaintenanceLifecycleReport = {
    readonly status: "applied" | "unchanged" | "skipped" | "failed";
    readonly result: unknown;
};

export type MaintenanceLifecycleEmit = (
    update: Parameters<ProgressReporterService["emit"]>[0],
) => Promise<void>;

export type MaintenanceLifecyclePersist = (
    state: MaintenanceRunState,
) => Promise<void>;

type MaintenanceLifecycleClient = Awaited<
    ReturnType<MaintenanceRuntime["githubClient"]["initialize"]>
>;

type MaintenanceLifecycleReconciliationRuntime = Pick<
    MaintenanceRuntime,
    | "maintenanceMutation"
    | "maintenanceRelationships"
    | "gitRepositoryInvariant"
>;

/** Explicit dependencies needed to run one maintenance lifecycle. */
export type MaintenanceLifecycleInput = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceLifecycleReconciliationRuntime;
    readonly signal: AbortSignal | undefined;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceLifecycleClient;
    readonly snapshot: MaintenanceSnapshot;
    readonly planner: MaintenancePlanService;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly initialState: MaintenanceRunState;
    readonly reports: MaintenanceLifecycleReport[];
    readonly emit: MaintenanceLifecycleEmit;
    readonly persist: MaintenanceLifecyclePersist;
};

export type MaintenanceLifecycleOutcome = {
    readonly state: MaintenanceRunState;
};

class MaintenanceLifecycleError extends RalphieError {
    override readonly _tag = "MaintenanceLifecycleError" as const;
}

type MaintenanceResult = MaintenanceMutationResult | RelationshipMutationResult;

type MaintenanceRecordedResult = {
    readonly actionKey: string;
    readonly issueNumber: number;
    readonly status: string;
};

type MutableMaintenanceState = MaintenanceRunState;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const nowIso = (): string => new Date().toISOString();

const checkCancellation = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted !== true) return;
    throw (
        signal.reason ??
        Object.assign(new Error("Maintenance run was cancelled."), {
            name: "AbortError",
        })
    );
};

const issueProgress = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
): ProgressIssue => {
    const detailed = snapshot.selectedIssues.find(
        (issue) => issue.number === issueNumber,
    );
    if (detailed !== undefined) {
        return { number: issueNumber, title: detailed.title };
    }
    const summary = snapshot.openIssueSummaries.find(
        (issue) => issue.number === issueNumber,
    );
    return {
        number: issueNumber,
        title: summary?.title ?? `Issue #${String(issueNumber)}`,
    };
};

const isRelationshipAction = (
    action: ValidatedIssueMaintenanceAction,
): action is Extract<
    ValidatedIssueMaintenanceAction,
    {
        readonly action: "link-duplicate" | "close-duplicate" | "link-related";
    }
> =>
    action.action === "link-duplicate" ||
    action.action === "close-duplicate" ||
    action.action === "link-related";

const candidateAnalysisFrom = (
    value: unknown,
): MaintenanceCandidateAnalysis | undefined => {
    if (!isRecord(value) || !Array.isArray(value.candidates)) return undefined;
    if (
        typeof value.status !== "string" ||
        typeof value.subjectIssueNumber !== "number" ||
        typeof value.snapshotFingerprint !== "string" ||
        !Array.isArray(value.skips)
    ) {
        return undefined;
    }
    return value as unknown as MaintenanceCandidateAnalysis;
};

const candidateFor = (
    analysis: MaintenanceCandidateAnalysis | undefined,
    action: ValidatedIssueMaintenanceAction,
): MaintenanceCandidate | undefined => {
    if (!isRelationshipAction(action) || analysis === undefined)
        return undefined;
    return analysis.candidates.find(
        (candidate) => candidate.candidateId === action.candidateId,
    );
};

const actionRecord = (
    action: ValidatedIssueMaintenanceAction,
): Record<string, unknown> => action as unknown as Record<string, unknown>;

const actionStateFor = (
    action: ValidatedIssueMaintenanceAction,
    replanCount: number,
    previous: MaintenanceActionState | undefined,
    preserveSkipped: boolean,
): MaintenanceActionState => {
    const previousCanResume =
        previous !== undefined &&
        (preserveSkipped ||
            (previous.status !== "skipped" && previous.status !== "pending"));
    return {
        actionKey: action.actionKey,
        action: actionRecord(action),
        status: previousCanResume ? previous.status : "pending",
        attempts: previousCanResume ? previous.attempts : 0,
        replanCount,
        ...(previousCanResume && previous.result !== undefined
            ? { result: previous.result }
            : {}),
        updatedAt: nowIso(),
    };
};

const actionStatesFor = (
    plan: ValidatedIssueMaintenancePlan,
    previous: ReadonlyArray<MaintenanceActionState>,
    replanCount: number,
    preserveSkipped: boolean,
): ReadonlyArray<MaintenanceActionState> => {
    const previousByKey = new Map(
        previous.map((action) => [action.actionKey, action]),
    );
    return Object.freeze(
        plan.actions.map((action) =>
            actionStateFor(
                action,
                replanCount,
                previousByKey.get(action.actionKey),
                preserveSkipped,
            ),
        ),
    );
};

const storedPlanFor = (
    issueNumber: number,
    plan: ValidatedIssueMaintenancePlan,
    candidates: MaintenanceCandidateAnalysis,
    replanCount: number,
): MaintenanceStoredPlan => ({
    issueNumber,
    snapshotFingerprint: plan.snapshotFingerprint,
    plan,
    candidates,
    skips: [],
    replanCount,
    recordedAt: nowIso(),
});

const relationshipActionFor = (
    action: ValidatedIssueMaintenanceAction,
): boolean => isRelationshipAction(action);

const evidenceFromResult = (
    result: MaintenanceResult,
): ReadonlyArray<unknown> => ("evidence" in result ? [result.evidence] : []);

const groundedAtSnapshot = async (input: {
    readonly runtime: MaintenanceLifecycleReconciliationRuntime;
    readonly snapshot: MaintenanceSnapshot;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly signal?: AbortSignal;
}): Promise<
    | { readonly current: true }
    | { readonly current: false; readonly detail: string }
> => {
    const grounding = input.snapshot.grounding;
    if (grounding === undefined) return { current: true };
    const current = await input.runtime.gitRepositoryInvariant.capture(
        input.repositoryPath,
        input.signal,
    );
    if (
        current.branch !== input.branch ||
        current.branch !== grounding.branch ||
        current.head.toLowerCase() !== grounding.head.toLowerCase()
    ) {
        return {
            current: false,
            detail:
                `grounding HEAD changed from ${grounding.head} to ${current.head} ` +
                `(branch ${current.branch}); the action must be replanned`,
        };
    }
    return { current: true };
};

const issueStateWith = (
    state: MutableMaintenanceState,
    index: number,
    issue: MaintenanceIssueState,
): MutableMaintenanceState => ({
    ...state,
    issues: state.issues.map((entry, entryIndex) =>
        entryIndex === index ? issue : entry,
    ),
    updatedAt: nowIso(),
});

const plansWith = (
    state: MutableMaintenanceState,
    storedPlan: MaintenanceStoredPlan,
): MutableMaintenanceState => ({
    ...state,
    plans: [
        ...state.plans.filter(
            (plan) => plan.issueNumber !== storedPlan.issueNumber,
        ),
        storedPlan,
    ].sort((left, right) => left.issueNumber - right.issueNumber),
    updatedAt: nowIso(),
});

const resultStateFor = (
    state: MutableMaintenanceState,
    result: MaintenanceRecordedResult,
): MutableMaintenanceState => {
    const entry: MaintenanceReconciliationState = {
        actionKey: result.actionKey,
        issueNumber: result.issueNumber,
        status: result.status,
        result,
        recordedAt: nowIso(),
    };
    return {
        ...state,
        reconciliationResults: [...state.reconciliationResults, entry],
        skips:
            result.status === "skipped"
                ? [...state.skips, result]
                : state.skips,
        updatedAt: nowIso(),
    };
};

const stateActionWith = (
    state: MutableMaintenanceState,
    issueIndex: number,
    actionIndex: number,
    patch: Partial<MaintenanceActionState>,
): MutableMaintenanceState => {
    const issue = state.issues[issueIndex];
    if (issue === undefined) return state;
    const actions = issue.actions.map((action, currentIndex) =>
        currentIndex === actionIndex
            ? { ...action, ...patch, updatedAt: nowIso() }
            : action,
    );
    return issueStateWith(state, issueIndex, {
        ...issue,
        actions,
        updatedAt: nowIso(),
    });
};

const mutationFailure = (
    message: string,
    cause?: unknown,
): MaintenanceLifecycleError =>
    new MaintenanceLifecycleError({
        message,
        ...(cause === undefined ? {} : { cause }),
    });

type MaintenanceIssueExecutionContext = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceLifecycleReconciliationRuntime;
    readonly signal: AbortSignal | undefined;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly maintenanceBranch: string;
    readonly maintenanceRepositoryPath: string;
    readonly maintenanceClient: MaintenanceLifecycleClient;
    readonly captured: MaintenanceSnapshot;
    readonly planner: MaintenancePlanService;
    readonly reports: MaintenanceLifecycleReport[];
    state: MutableMaintenanceState;
    readonly emit: MaintenanceLifecycleEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
};

type MaintenanceActionStep = {
    readonly issue: MaintenanceIssueState;
    readonly needsReplan: boolean;
};

type ValidatedPlannerOutput = {
    readonly plan: ValidatedIssueMaintenancePlan | undefined;
    readonly skips: ReadonlyArray<{
        readonly reason: string;
        readonly actionIndex: number | null;
        readonly issueNumber: number | null;
        readonly detail: string;
    }>;
};

const validatePlannerOutput = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
    planned: Awaited<ReturnType<MaintenancePlanService["plan"]>>,
): ValidatedPlannerOutput => {
    if (planned.status !== "accepted") {
        return { plan: undefined, skips: planned.skips };
    }
    const validation = validateIssueMaintenancePlan(
        snapshot,
        issueNumber,
        planned.plan,
    );
    return validation.status === "accepted"
        ? { plan: validation.plan, skips: planned.skips }
        : { plan: undefined, skips: validation.skips };
};

const planForState = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
    issueState: MaintenanceIssueState,
):
    | {
          readonly plan: ValidatedIssueMaintenancePlan;
          readonly candidates: MaintenanceCandidateAnalysis;
      }
    | undefined => {
    if (
        issueState.plan === undefined ||
        issueState.replanRequested ||
        issueState.status === "skipped" ||
        issueState.status === "complete"
    ) {
        return undefined;
    }
    const validation = validateIssueMaintenancePlan(
        snapshot,
        issueNumber,
        issueState.plan,
    );
    if (validation.status !== "accepted") return undefined;
    const candidates = candidateAnalysisFrom(issueState.candidates);
    if (candidates === undefined) return undefined;
    return { plan: validation.plan, candidates };
};

const resultStatusForReport = (
    result: MaintenanceResult | { readonly status: "dry-run" },
): MaintenanceLifecycleReport["status"] => {
    if (result.status === "applied") return "applied";
    if (result.status === "unchanged") return "unchanged";
    if (result.status === "recovery-required") return "failed";
    return "skipped";
};

const restoreMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issueNumber: number,
    currentState: MaintenanceIssueState,
): Promise<MaintenanceIssueState | undefined> => {
    if (
        currentState.status === "complete" ||
        currentState.status === "skipped"
    ) {
        return currentState;
    }
    const restored = planForState(context.captured, issueNumber, currentState);
    if (restored === undefined) return undefined;
    const normalizedIssue: MaintenanceIssueState = {
        ...currentState,
        status: "planned",
        replanRequested: false,
        actions: actionStatesFor(
            restored.plan,
            currentState.actions,
            currentState.replanCount,
            true,
        ),
        updatedAt: nowIso(),
    };
    await context.persist(
        issueStateWith(context.state, issueIndex, normalizedIssue),
    );
    return normalizedIssue;
};

const planFreshMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issueNumber: number,
    currentState: MaintenanceIssueState,
    forceReplan: boolean,
): Promise<MaintenanceIssueState> => {
    const issue = issueProgress(context.captured, issueNumber);
    await context.emit({
        stage: "maintenance-planning",
        status: "started",
        message: `${forceReplan ? "Replanning" : "Planning"} maintenance for issue #${String(issueNumber)}...`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "plan",
            replan: forceReplan,
            replanCount: currentState.replanCount,
            snapshotFingerprint: context.captured.fingerprint,
        },
    });
    const planned = await context.planner.plan({
        snapshot: context.captured,
        subjectIssueNumber: issueNumber,
        repositoryPath: context.maintenanceRepositoryPath,
        targetBranch: context.maintenanceBranch,
        signal: context.signal,
        runId: context.actualRunId,
        agentSelection: {
            agent: context.selection.agent,
            ...(context.selection.model === undefined
                ? {}
                : { model: context.selection.model }),
            ...(context.selection.variant === undefined
                ? {}
                : { variant: context.selection.variant }),
        },
    });
    checkCancellation(context.signal);
    const validated = validatePlannerOutput(
        context.captured,
        issueNumber,
        planned,
    );
    const planAccepted = validated.plan !== undefined;
    await context.emit({
        stage: "maintenance-planning",
        status: planAccepted ? "succeeded" : "skipped",
        message: planAccepted
            ? `Maintenance plan accepted for issue #${String(issueNumber)} (${validated.plan.actions.length} actions).`
            : `Maintenance plan skipped for issue #${String(issueNumber)}.`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "plan",
            status: planAccepted ? "accepted" : "rejected",
            plannerStatus: planned.status,
            sessionID: planned.sessionID,
            candidates: planned.candidates,
            skips: validated.skips,
            ...(validated.plan === undefined ? {} : { plan: validated.plan }),
        },
    });
    await context.emit({
        stage: "maintenance-validation",
        status: planAccepted ? "succeeded" : "skipped",
        message: planAccepted
            ? `Validated maintenance plan for issue #${String(issueNumber)}.`
            : `No validated maintenance actions for issue #${String(issueNumber)}.`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "validation",
            status: planAccepted ? "accepted" : "rejected",
            plannerStatus: planned.status,
            skips: validated.skips,
        },
    });

    if (validated.plan === undefined) {
        const skippedIssue: MaintenanceIssueState = {
            ...currentState,
            status: "skipped",
            replanRequested: false,
            plan: undefined,
            candidates: planned.candidates,
            skips: [...validated.skips],
            actions: [],
            outcome: {
                status: "skipped",
                skips: validated.skips,
            },
            updatedAt: nowIso(),
        };
        context.reports.push({
            status: "skipped",
            result: skippedIssue.outcome,
        });
        await context.persist(
            issueStateWith(
                {
                    ...context.state,
                    skips: [...context.state.skips, ...validated.skips],
                },
                issueIndex,
                skippedIssue,
            ),
        );
        return skippedIssue;
    }

    const nextIssue: MaintenanceIssueState = {
        ...currentState,
        status: "planned",
        replanRequested: false,
        plan: validated.plan,
        candidates: planned.candidates,
        skips: [...validated.skips],
        actions: actionStatesFor(
            validated.plan,
            currentState.actions,
            currentState.replanCount,
            !forceReplan,
        ),
        outcome: undefined,
        updatedAt: nowIso(),
    };
    await context.persist(
        plansWith(
            issueStateWith(context.state, issueIndex, nextIssue),
            storedPlanFor(
                issueNumber,
                validated.plan,
                planned.candidates,
                nextIssue.replanCount,
            ),
        ),
    );
    return nextIssue;
};

const planMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    forceReplan: boolean,
): Promise<MaintenanceIssueState> => {
    const currentState = context.state.issues[issueIndex];
    const issueNumber = context.selectedIssueNumbers[issueIndex];
    if (currentState === undefined || issueNumber === undefined) {
        throw mutationFailure(
            `Maintenance issue state ${String(issueIndex)} is missing.`,
        );
    }
    if (!forceReplan) {
        const restored = await restoreMaintenanceIssue(
            context,
            issueIndex,
            issueNumber,
            currentState,
        );
        if (restored !== undefined) return restored;
    }
    return planFreshMaintenanceIssue(
        context,
        issueIndex,
        issueNumber,
        currentState,
        forceReplan,
    );
};

const requestMaintenanceReplan = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    detail: string,
): Promise<boolean> => {
    if (issue.replanCount >= MAINTENANCE_MAX_REPLANS) return false;
    const nextIssue: MaintenanceIssueState = {
        ...issue,
        status: "pending",
        replanRequested: true,
        replanCount: issue.replanCount + 1,
        skips: [...issue.skips, { reason: "replan", detail }],
        actions: issue.actions.map((action, index) =>
            index === actionIndex
                ? {
                      ...action,
                      status: "pending",
                      result: {
                          status: "skipped",
                          reason: "stale-plan",
                          detail,
                      },
                      updatedAt: nowIso(),
                  }
                : action,
        ),
        updatedAt: nowIso(),
    };
    await context.persist(issueStateWith(context.state, issueIndex, nextIssue));
    await context.emit({
        stage: "maintenance-replan",
        status: "info",
        message: `Replanning issue #${String(issue.issueNumber)} after live state changed.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "replan",
            actionIndex,
            replanCount: nextIssue.replanCount,
            detail,
        },
    });
    return true;
};

const emitReconciledAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionState: MaintenanceActionState,
): Promise<void> => {
    await context.emit({
        stage: "maintenance-action",
        status: "info",
        message: `Resuming past reconciled maintenance action ${actionState.actionKey}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "action",
            actionKey: actionState.actionKey,
            status: actionState.status,
        },
    });
};

const updateIssueAction = (
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
): MaintenanceIssueState => ({
    ...issue,
    actions: issue.actions.map((entry, index) =>
        index === actionIndex ? actionState : entry,
    ),
    updatedAt: nowIso(),
});

const skipMaintenanceActionForPolicy = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    const result = {
        status: "skipped" as const,
        reason: "duplicate-policy" as const,
        actionKey,
        issueNumber: issue.issueNumber,
        detail: "duplicate closure is disabled; use --duplicate-action close to opt in",
        changed: false as const,
    };
    context.reports.push({ status: "skipped", result });
    const updatedIssue = updateIssueAction(issue, actionIndex, {
        ...issue.actions[actionIndex]!,
        status: "skipped",
        result,
        updatedAt: nowIso(),
    });
    await context.persist(
        resultStateFor(
            issueStateWith(context.state, issueIndex, updatedIssue),
            result,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status: "skipped",
        message: result.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "mutation", result, action },
    });
    return { issue: updatedIssue, needsReplan: false };
};

const skipMaintenanceActionForGrounding = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionKey: string,
    detail: string,
): Promise<MaintenanceActionStep> => {
    const finalResult = {
        status: "skipped" as const,
        reason: "stale-plan" as const,
        actionKey,
        issueNumber: issue.issueNumber,
        detail,
    };
    context.reports.push({ status: "skipped", result: finalResult });
    const updatedIssue = updateIssueAction(issue, actionIndex, {
        ...issue.actions[actionIndex]!,
        status: "skipped",
        result: finalResult,
        updatedAt: nowIso(),
    });
    await context.persist(
        resultStateFor(
            issueStateWith(context.state, issueIndex, updatedIssue),
            finalResult,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status: "skipped",
        message: finalResult.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "mutation", result: finalResult },
    });
    return { issue: updatedIssue, needsReplan: false };
};

const liveStaleMaintenanceReasons = new Set([
    "stale-fingerprint",
    "issue-missing",
    "issue-inaccessible",
    "issue-closed",
    "comment-missing",
    "comment-ambiguous",
    "comment-url-mismatch",
    "source-issue-mismatch",
    "stale-answer",
    "candidate-missing",
    "candidate-invalid",
    "candidate-kind-mismatch",
    "candidate-stale",
    "candidate-not-eligible",
    "pair-missing",
    "pair-inaccessible",
    "pair-closed",
    "pair-changed",
]);

const isLiveStaleMaintenanceResult = (result: MaintenanceResult): boolean =>
    result.status === "skipped" &&
    liveStaleMaintenanceReasons.has(result.reason);

const invokeMaintenanceAdapter = async (
    context: MaintenanceIssueExecutionContext,
    action: ValidatedIssueMaintenanceAction,
    candidate: MaintenanceCandidate | undefined,
): Promise<MaintenanceResult> => {
    if (relationshipActionFor(action)) {
        const service = context.runtime.maintenanceRelationships;
        if (service === undefined) {
            throw mutationFailure(
                "Maintenance relationship service is unavailable.",
            );
        }
        return await service.reconcile(
            context.maintenanceClient,
            context.config.repo,
            {
                action: action as Extract<
                    ValidatedIssueMaintenanceAction,
                    {
                        readonly action:
                            | "link-duplicate"
                            | "close-duplicate"
                            | "link-related";
                    }
                >,
                candidate,
                snapshotFingerprint: context.captured.fingerprint,
                signal: context.signal,
            },
        );
    }
    const service = context.runtime.maintenanceMutation;
    if (service === undefined) {
        throw mutationFailure("Maintenance mutation service is unavailable.");
    }
    const issueUrl =
        context.captured.selectedIssues.find(
            (entry) => entry.number === action.issueNumber,
        )?.url ??
        context.captured.openIssueSummaries.find(
            (entry) => entry.number === action.issueNumber,
        )?.url;
    return await service.reconcile(
        context.maintenanceClient,
        context.config.repo,
        {
            action,
            snapshotFingerprint: context.captured.fingerprint,
            snapshot: context.captured,
            ...(issueUrl === undefined ? {} : { expectedIssueUrl: issueUrl }),
            signal: context.signal,
        },
    );
};

const recordMaintenanceResult = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    actionIndex: number,
    issue: MaintenanceIssueState,
    actionKey: string,
    result: MaintenanceResult,
): Promise<void> => {
    context.reports.push({
        status: resultStatusForReport(result),
        result,
    });
    await context.persist(
        resultStateFor(
            stateActionWith(context.state, issueIndex, actionIndex, {
                status:
                    result.status === "applied" ||
                    result.status === "unchanged" ||
                    result.status === "skipped"
                        ? result.status
                        : "in-progress",
                result,
                replanCount: issue.replanCount,
            }),
            result,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status:
            result.status === "applied" || result.status === "unchanged"
                ? "succeeded"
                : result.status === "skipped"
                  ? "skipped"
                  : "failed",
        message: result.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "mutation",
            actionKey,
            result,
            evidence: evidenceFromResult(result),
        },
    });
};

const reconcileMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    await context.emit({
        stage: "maintenance-mutation",
        status: "started",
        message: `Reconciling maintenance action ${actionKey}...`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "mutation",
            actionKey,
            action,
            snapshotFingerprint: context.captured.fingerprint,
        },
    });
    await context.persist(
        stateActionWith(context.state, issueIndex, actionIndex, {
            status: "in-progress",
            attempts: actionState.attempts + 1,
            replanCount: issue.replanCount,
        }),
    );
    const candidate = candidateFor(
        candidateAnalysisFrom(issue.candidates),
        action,
    );
    const result = await invokeMaintenanceAdapter(context, action, candidate);
    await recordMaintenanceResult(
        context,
        issueIndex,
        actionIndex,
        issue,
        actionKey,
        result,
    );
    // A signal may have fired after GitHub accepted a mutation. Persist and
    // report that authoritative result before observing cancellation so resume
    // does not repeat a completed action.
    checkCancellation(context.signal);
    const updatedIssue = context.state.issues[issueIndex] ?? issue;
    if (result.status === "recovery-required") {
        throw mutationFailure(
            `Maintenance action ${actionKey} requires recovery before another attempt: ${result.detail}`,
        );
    }
    if (!isLiveStaleMaintenanceResult(result)) {
        return { issue: updatedIssue, needsReplan: false };
    }
    const shouldReplan = await requestMaintenanceReplan(
        context,
        issueIndex,
        updatedIssue,
        actionIndex,
        result.detail,
    );
    return {
        issue: context.state.issues[issueIndex] ?? updatedIssue,
        needsReplan: shouldReplan,
    };
};

const executeUnsettledMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    if (context.dryRun) {
        const result = {
            status: "dry-run" as const,
            actionKey,
            issueNumber: issue.issueNumber,
            detail: "dry-run reports this validated action without calling a GitHub mutation adapter",
            action,
        };
        context.reports.push({ status: "skipped", result });
        await context.emit({
            stage: "maintenance-mutation",
            status: "skipped",
            message: `Dry run would reconcile action ${actionKey}.`,
            repository: context.config.repo,
            issue: issueProgress(context.captured, issue.issueNumber),
            current: issueIndex + 1,
            total: context.selectedIssueNumbers.length,
            details: { kind: "mutation", ...result },
        });
        return { issue, needsReplan: false };
    }

    if (
        action.action === "close-duplicate" &&
        context.duplicateAction !== ("close" as DuplicateAction)
    ) {
        return skipMaintenanceActionForPolicy(
            context,
            issueIndex,
            issue,
            actionIndex,
            action,
            actionKey,
        );
    }

    if (action.action !== "skip") {
        const grounding = await groundedAtSnapshot({
            runtime: context.runtime,
            snapshot: context.captured,
            repositoryPath: context.maintenanceRepositoryPath,
            branch: context.maintenanceBranch,
            signal: context.signal,
        });
        if (!grounding.current) {
            const shouldReplan = await requestMaintenanceReplan(
                context,
                issueIndex,
                issue,
                actionIndex,
                grounding.detail,
            );
            if (shouldReplan) {
                return {
                    issue: context.state.issues[issueIndex] ?? issue,
                    needsReplan: true,
                };
            }
            return skipMaintenanceActionForGrounding(
                context,
                issueIndex,
                issue,
                actionIndex,
                actionKey,
                grounding.detail,
            );
        }
    }
    return reconcileMaintenanceAction(
        context,
        issueIndex,
        issue,
        actionIndex,
        actionState,
        action,
        actionKey,
    );
};

const executeMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
): Promise<MaintenanceActionStep> => {
    const actionState = issue.actions[actionIndex];
    if (actionState === undefined) {
        return { issue, needsReplan: false };
    }
    if (
        actionState.status === "applied" ||
        actionState.status === "unchanged" ||
        actionState.status === "skipped"
    ) {
        await emitReconciledAction(context, issueIndex, issue, actionState);
        return { issue, needsReplan: false };
    }
    const action =
        actionState.action as unknown as ValidatedIssueMaintenanceAction;
    const actionKey = actionState.actionKey || maintenanceActionKey(action);
    await context.emit({
        stage: "maintenance-action",
        status: "info",
        message: `Executing maintenance action ${actionKey}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "action", actionKey, action },
    });
    return executeUnsettledMaintenanceAction(
        context,
        issueIndex,
        issue,
        actionIndex,
        actionState,
        action,
        actionKey,
    );
};

const executeMaintenanceActions = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    initialIssue: MaintenanceIssueState,
): Promise<MaintenanceActionStep> => {
    let issue = initialIssue;
    for (
        let actionIndex = 0;
        actionIndex < issue.actions.length;
        actionIndex++
    ) {
        const step = await executeMaintenanceAction(
            context,
            issueIndex,
            issue,
            actionIndex,
        );
        issue = step.issue;
        if (step.needsReplan) return step;
    }
    return { issue, needsReplan: false };
};

const completeMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
): Promise<void> => {
    const completed: MaintenanceIssueState = {
        ...issue,
        status: "complete",
        replanRequested: false,
        outcome: {
            status: "complete",
            actionCount: issue.actions.length,
        },
        updatedAt: nowIso(),
    };
    if (issue.actions.length === 0) {
        context.reports.push({
            status: "unchanged",
            result: completed.outcome,
        });
    }
    await context.persist(
        issueStateWith(
            { ...context.state, nextIssueIndex: issueIndex + 1 },
            issueIndex,
            completed,
        ),
    );
    await context.emit({
        stage: "maintenance-outcome",
        status: "succeeded",
        message: `Maintenance outcome recorded for issue #${String(issue.issueNumber)}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "outcome",
            outcome: completed.outcome,
        },
    });
};

const executeMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
): Promise<void> => {
    let issue = await planMaintenanceIssue(context, issueIndex, false);
    if (issue.status === "complete" || issue.status === "skipped") return;
    while (true) {
        const actions = await executeMaintenanceActions(
            context,
            issueIndex,
            issue,
        );
        issue = actions.issue;
        if (!actions.needsReplan) {
            await completeMaintenanceIssue(context, issueIndex, issue);
            return;
        }
        issue = await planMaintenanceIssue(context, issueIndex, true);
        if (issue.status === "complete" || issue.status === "skipped") return;
    }
};

/**
 * Run the focused plan → validate → reconcile → replan → persist lifecycle
 * for every selected issue, resuming from the durable next-issue cursor.
 */
export const executeMaintenanceLifecycle = async (
    input: MaintenanceLifecycleInput,
): Promise<MaintenanceLifecycleOutcome> => {
    const context: MaintenanceIssueExecutionContext = {
        config: input.config,
        runtime: input.runtime,
        signal: input.signal,
        actualRunId: input.actualRunId,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
        selection: input.selection,
        selectedIssueNumbers: input.selectedIssueNumbers,
        maintenanceBranch: input.branch,
        maintenanceRepositoryPath: input.repositoryPath,
        maintenanceClient: input.client,
        captured: input.snapshot,
        planner: input.planner,
        reports: input.reports,
        state: input.initialState,
        emit: input.emit,
        persist: async (next) => {
            await input.persist(next);
            context.state = next;
        },
    };
    for (
        let issueIndex = context.state.nextIssueIndex;
        issueIndex < input.selectedIssueNumbers.length;
        issueIndex += 1
    ) {
        checkCancellation(input.signal);
        await executeMaintenanceIssue(context, issueIndex);
    }
    return { state: context.state };
};