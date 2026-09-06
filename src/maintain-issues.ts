/**
 * One-shot, sequential maintenance execution.
 *
 * The runner owns scheduling, durable progress, and reporting only.  It does
 * not know how to edit GitHub: plans go through the two deterministic
 * maintenance adapters, and each adapter performs its own authoritative live
 * read/reconciliation before it can mutate anything.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { makeMaintenancePlanService } from "./maintain-issues-plan.ts";
import type { MaintenancePlanService } from "./maintain-issues-plan.ts";
import {
    executeMaintenanceLifecycle,
    type MaintenanceLifecycleReport,
} from "./maintain-issues-lifecycle.ts";
import { type MaintenanceSnapshot } from "./maintain-issues-snapshot-service.ts";
import {
    MaintenanceRunStateStoreLive,
    type MaintenanceIssueState,
    type MaintenanceRunState,
    type MaintenanceRunStateStoreService,
    type MaintenanceSelectionState,
    loadMaintenanceRunState,
    validateMaintenanceResumeState,
} from "./maintain-issues-state.ts";
import { type MaintenanceRuntime } from "./runtime.ts";
import {
    DuplicateAction,
    type MaintainIssuesRalphieConfig,
} from "./options.ts";
import { type ProgressReporterService } from "./progress/progress.ts";
import { rateLimitFromUnknown } from "./github/rate-limit.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import { type CommandResult } from "./process/command-runner.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";

export { MAINTENANCE_MAX_REPLANS } from "./maintain-issues-lifecycle.ts";
export const MAINTENANCE_RATE_LIMIT_MAX_RETRIES = 3;
export const MAINTENANCE_RATE_LIMIT_DEFAULT_DELAY_MS = 100;
export const MAINTENANCE_RATE_LIMIT_MAX_DELAY_MS = 1_000;
export type MaintainIssuesOptions = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
    /** Set only when the operator supplied --duplicate-action on resume. */
    readonly explicitDuplicateAction?: DuplicateAction;
    /** Loaded by the command before it creates OpenCode/output resources. */
    readonly resumeState?: MaintenanceRunState;
};

/** Typed dispatch seam for maintenance runs. */
export type MaintainIssuesEntryPoint = (
    options: MaintainIssuesOptions,
    runtime: MaintenanceRuntime,
) => Promise<void>;

export type MaintenanceActionCounts = {
    readonly unchanged: number;
    readonly changed: number;
    readonly skipped: number;
    readonly replanned: number;
    readonly failed: number;
};

export type MaintenanceRunSummary = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly statePath: string;
    readonly snapshotFingerprint: string;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly counts: MaintenanceActionCounts;
    readonly dryRun: boolean;
    /** Lossless action/skip evidence for JSON callers and verbose output. */
    readonly evidence: ReadonlyArray<unknown>;
};
class MaintenanceExecutionError extends RalphieError {
    override readonly _tag = "MaintenanceExecutionError" as const;
}
type MaintenanceReportResult = MaintenanceLifecycleReport;

type MutableMaintenanceState = MaintenanceRunState;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

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
const emptyIssueState = (issueNumber: number): MaintenanceIssueState => ({
    issueNumber,
    status: "pending",
    replanCount: 0,
    replanRequested: false,
    skips: [],
    actions: [],
    updatedAt: nowIso(),
});

const selectionFor = (
    config: MaintainIssuesRalphieConfig,
): MaintenanceSelectionState =>
    ({
        agent: config.agent,
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.thinking === undefined ? {} : { variant: config.thinking }),
        ...(config.maxIssues === undefined
            ? {}
            : { maxIssues: config.maxIssues }),
        issueLabels: [...config.issueLabels],
        issueSort: config.issueSort,
        issueOrder: config.issueOrder,
    }) as MaintenanceSelectionState;

const selectionInputFor = (selection: MaintenanceSelectionState) => ({
    ...(selection.maxIssues === undefined
        ? {}
        : { maxIssues: selection.maxIssues }),
    issueLabels: [...selection.issueLabels],
    issueSort: selection.issueSort,
    issueOrder: selection.issueOrder,
});

const repositoryPathFor = (config: MaintainIssuesRalphieConfig): string => {
    const repository = parseRepositorySlug(config.repo);
    const workspace = resolveWorkspacePath(config.workspace);
    return join(workspace, repository.owner, repository.name);
};

const existingCheckoutPathFor = async (
    config: MaintainIssuesRalphieConfig,
): Promise<string> => {
    const workspace = resolveWorkspacePath(config.workspace);
    try {
        await stat(join(workspace, ".git"));
        return workspace;
    } catch {
        return repositoryPathFor(config);
    }
};

const statusFrom = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const response = value.response;
    const nested = isRecord(response) ? response.status : undefined;
    const status = nested ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const isRateLimitFailure = (value: unknown): boolean => {
    const status = statusFrom(value);
    if (status === 429) return true;
    const metadata = rateLimitFromUnknown(value);
    if (metadata?.remaining === 0 || metadata?.retryAfterMs !== undefined)
        return true;
    if (status !== 403) return false;
    return metadata?.remaining === 0;
};

const sleepWithCancellation = async (
    milliseconds: number,
    signal: AbortSignal | undefined,
): Promise<void> => {
    checkCancellation(signal);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            reject(
                signal?.reason ??
                    Object.assign(new Error("Maintenance run was cancelled."), {
                        name: "AbortError",
                    }),
            );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

/** Retry only an explicitly rate-limited read, with a small hard bound. */
export const withMaintenanceRateLimitRetry = async <Result>(input: {
    readonly operation: string;
    readonly run: () => Promise<Result>;
    readonly signal?: AbortSignal;
    readonly onRetry?: (input: {
        readonly operation: string;
        readonly attempt: number;
        readonly delayMs: number;
        readonly error: unknown;
    }) => Promise<void>;
}): Promise<Result> => {
    let attempt = 0;
    while (true) {
        checkCancellation(input.signal);
        try {
            return await input.run();
        } catch (error) {
            if (
                !isRateLimitFailure(error) ||
                attempt >= MAINTENANCE_RATE_LIMIT_MAX_RETRIES
            ) {
                throw error;
            }
            const metadata = rateLimitFromUnknown(error);
            const exponential =
                MAINTENANCE_RATE_LIMIT_DEFAULT_DELAY_MS * 2 ** attempt;
            const delayMs = Math.min(
                MAINTENANCE_RATE_LIMIT_MAX_DELAY_MS,
                Math.max(0, metadata?.retryAfterMs ?? exponential),
            );
            attempt += 1;
            await input.onRetry?.({
                operation: input.operation,
                attempt,
                delayMs,
                error,
            });
            await sleepWithCancellation(delayMs, input.signal);
        }
    }
};

const commandSucceeded = (value: CommandResult): boolean =>
    value.exitCode === 0;

const readOnlyFallbackBranch = async (
    runtime: MaintenanceRuntime,
    repositoryPath: string,
    currentBranch: string,
    signal: AbortSignal | undefined,
): Promise<string> => {
    const commandRunner = runtime.commandRunner;
    if (typeof commandRunner?.run !== "function") return currentBranch;
    for (const branch of ["main", "master"] as const) {
        checkCancellation(signal);
        let result: CommandResult;
        try {
            result = await commandRunner.run(
                "git",
                [
                    "-C",
                    repositoryPath,
                    "rev-parse",
                    "--verify",
                    `refs/remotes/origin/${branch}`,
                ],
                { signal },
            );
        } catch {
            continue;
        }
        if (commandSucceeded(result)) return branch;
    }
    return currentBranch;
};
const summaryFromReports = (
    reports: ReadonlyArray<MaintenanceReportResult>,
    state: MaintenanceRunState,
    failedDuringRun: boolean,
): MaintenanceActionCounts => {
    let unchanged = 0;
    let changed = 0;
    let skipped = 0;
    let failed =
        failedDuringRun && !reports.some((report) => report.status === "failed")
            ? 1
            : 0;
    for (const report of reports) {
        switch (report.status) {
            case "applied":
                changed += 1;
                break;
            case "unchanged":
                unchanged += 1;
                break;
            case "skipped":
                skipped += 1;
                break;
            case "failed":
                failed += 1;
                break;
        }
    }
    return {
        unchanged,
        changed,
        skipped,
        replanned: state.issues.reduce(
            (total, issue) => total + issue.replanCount,
            0,
        ),
        failed,
    };
};
const createInitialState = (input: {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly duplicateAction: DuplicateAction;
    readonly selection: MaintenanceSelectionState;
    readonly dryRun: boolean;
}): MutableMaintenanceState => {
    const timestamp = nowIso();
    return {
        version: 1,
        mode: "maintain-issues",
        status: "active",
        runId: input.runId,
        repository: input.repository,
        branch: input.branch,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
        selection: input.selection,
        selectedIssueNumbers: [],
        nextIssueIndex: 0,
        plans: [],
        issues: [],
        reconciliationResults: [],
        skips: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    };
};

const mutationFailure = (
    message: string,
    cause?: unknown,
): MaintenanceExecutionError =>
    new MaintenanceExecutionError({
        message,
        ...(cause === undefined ? {} : { cause }),
    });

type MaintenanceClient = Awaited<
    ReturnType<MaintenanceRuntime["githubClient"]["initialize"]>
>;

type MaintenanceEmit = (
    update: Parameters<ProgressReporterService["emit"]>[0],
) => Promise<void>;

type MaintenancePreparedRepository = {
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
};

type MaintenanceCaptureResult = {
    readonly state: MutableMaintenanceState;
    readonly snapshot: MaintenanceSnapshot;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
};

const reportsFromResumeState = (
    resumeState: MaintenanceRunState | undefined,
): MaintenanceReportResult[] => {
    const reports: MaintenanceReportResult[] = [];
    for (const reconciliation of resumeState?.reconciliationResults ?? []) {
        if (
            reconciliation.status !== "applied" &&
            reconciliation.status !== "unchanged" &&
            reconciliation.status !== "skipped" &&
            reconciliation.status !== "recovery-required"
        ) {
            continue;
        }
        reports.push({
            status:
                reconciliation.status === "recovery-required"
                    ? "failed"
                    : reconciliation.status,
            result: reconciliation.result,
        });
    }
    return reports;
};

const prepareMaintenanceWorkspace = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly dryRun: boolean;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly emit: MaintenanceEmit;
}): Promise<void> => {
    const { config, runtime, dryRun, resumeState, emit } = input;
    if (!dryRun && config.cleanStart && resumeState === undefined) {
        await emit({
            stage: "workspace-cleanup",
            status: "started",
            message: `Removing existing workspace ${config.workspace}...`,
            repository: config.repo,
        });
        await runtime.workspace.remove(config.workspace);
        await emit({
            stage: "workspace-cleanup",
            status: "succeeded",
            message: `Workspace removed: ${config.workspace}.`,
            repository: config.repo,
        });
    }
    if (dryRun) return;
    await emit({
        stage: "workspace-preparation",
        status: "started",
        message: `Preparing workspace ${config.workspace}...`,
        repository: config.repo,
    });
    await runtime.workspace.prepare(config.workspace);
    await emit({
        stage: "workspace-preparation",
        status: "succeeded",
        message: `Workspace ready: ${config.workspace}.`,
        repository: config.repo,
    });
};

const prepareMaintenanceRepository = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly dryRun: boolean;
    readonly requestedBranch: string | undefined;
    readonly signal: AbortSignal | undefined;
    readonly emit: MaintenanceEmit;
}): Promise<MaintenancePreparedRepository> => {
    const { config, runtime, dryRun, requestedBranch, signal, emit } = input;
    await emit({
        stage: "github-authentication",
        status: "started",
        message: "Checking GitHub authentication...",
        repository: config.repo,
    });
    const client = await runtime.githubClient.initialize();
    await emit({
        stage: "github-authentication",
        status: "succeeded",
        message: "GitHub authentication verified.",
        repository: config.repo,
    });
    checkCancellation(signal);

    await emit({
        stage: "git-verification",
        status: "started",
        message: "Checking Git installation...",
        repository: config.repo,
    });
    await runtime.gitRepository.verifyInstalled();
    await emit({
        stage: "git-verification",
        status: "succeeded",
        message: "Git installation verified.",
        repository: config.repo,
    });

    if (dryRun) {
        const repositoryPath = await existingCheckoutPathFor(config);
        const invariant = await runtime.gitRepositoryInvariant.capture(
            repositoryPath,
            signal,
        );
        const branch =
            requestedBranch ??
            (await readOnlyFallbackBranch(
                runtime,
                repositoryPath,
                invariant.branch,
                signal,
            ));
        return { branch, repositoryPath, client };
    }

    const prepared = await runtime.gitRepository.prepare(
        config.repo,
        requestedBranch,
        config.workspace,
        undefined,
        signal,
    );
    await emit({
        stage: "repository-preparation",
        status: "succeeded",
        message: `Repository ready on ${prepared.branch}: ${prepared.path}.`,
        repository: config.repo,
        details: {
            repositoryPath: prepared.path,
            branch: prepared.branch,
            cloned: prepared.cloned,
            cleaned: prepared.cleaned,
        },
    });
    return {
        branch: prepared.branch,
        repositoryPath: prepared.path,
        client,
    };
};

const pendingIssuesAfterSnapshotChange = (
    state: MutableMaintenanceState,
): MutableMaintenanceState => ({
    ...state,
    issues: state.issues.map((issue) =>
        issue.status === "complete" || issue.status === "skipped"
            ? issue
            : {
                  ...issue,
                  replanRequested: true,
                  status: "pending",
                  updatedAt: nowIso(),
              },
    ),
});

const captureMaintenanceContext = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly signal: AbortSignal | undefined;
    readonly statePath: string;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
}): Promise<MaintenanceCaptureResult> => {
    const baseState =
        input.resumeState ??
        createInitialState({
            runId: input.actualRunId,
            repository: input.config.repo,
            branch: input.branch,
            duplicateAction: input.duplicateAction,
            selection: input.selection,
            dryRun: false,
        });
    if (input.resumeState === undefined) await input.persist(baseState);
    await input.emit({
        stage: "maintenance-observation",
        status: "started",
        message: "Capturing the complete maintenance snapshot...",
        repository: input.config.repo,
        details: {
            kind: "observation",
            branch: input.branch,
            selection: input.selection,
        },
    });
    const captured = await withMaintenanceRateLimitRetry({
        operation: "maintenance snapshot",
        signal: input.signal,
        run: () =>
            input.runtime.maintenanceSnapshot.capture({
                repository: input.config.repo,
                repositoryPath: input.repositoryPath,
                branch: input.branch,
                client: input.client,
                signal: input.signal,
                runId: input.actualRunId,
                selection: selectionInputFor(input.selection),
            }),
        onRetry: async ({ operation, attempt, delayMs, error }) => {
            await input.emit({
                stage: "maintenance-observation",
                status: "info",
                message: `Rate limit while reading ${operation}; retrying.`,
                repository: input.config.repo,
                details: { kind: "rate-limit", attempt, delayMs, error },
            });
        },
    });
    await input.emit({
        stage: "maintenance-observation",
        status: "succeeded",
        message: `Maintenance snapshot captured (${captured.selectedIssueNumbers.length} selected issues).`,
        repository: input.config.repo,
        details: {
            kind: "observation",
            snapshotFingerprint: captured.fingerprint,
            groundingFingerprint: captured.grounding?.head,
            metadata: captured.metadata,
            skips: captured.skips,
        },
    });

    const selectedIssueNumbers = Object.freeze([
        ...(input.resumeState?.selectedIssueNumbers ??
            captured.selectedIssueNumbers),
    ]);
    const savedIssues = input.resumeState?.issues ?? [];
    const issues = selectedIssueNumbers.map(
        (issueNumber) =>
            savedIssues.find((issue) => issue.issueNumber === issueNumber) ??
            emptyIssueState(issueNumber),
    );
    const snapshotChanged =
        input.resumeState?.snapshotFingerprint !== undefined &&
        input.resumeState.snapshotFingerprint !== captured.fingerprint;
    let nextState: MutableMaintenanceState = {
        ...baseState,
        branch: input.branch,
        selection: input.selection,
        selectedIssueNumbers,
        snapshotFingerprint: captured.fingerprint,
        ...(captured.grounding?.head === undefined
            ? {}
            : { groundingFingerprint: captured.grounding.head }),
        issues,
        nextIssueIndex: Math.min(
            input.resumeState?.nextIssueIndex ?? 0,
            issues.length,
        ),
        status: "active",
        lastError: undefined,
        updatedAt: nowIso(),
    };
    if (snapshotChanged) {
        nextState = pendingIssuesAfterSnapshotChange(nextState);
        await input.emit({
            stage: "maintenance-replan",
            status: "info",
            message:
                "The resumed snapshot changed; pending plans will be replanned.",
            repository: input.config.repo,
            details: {
                kind: "replan",
                previousSnapshotFingerprint:
                    input.resumeState?.snapshotFingerprint,
                snapshotFingerprint: captured.fingerprint,
            },
        });
    }
    await input.persist(nextState);
    return { state: nextState, snapshot: captured, selectedIssueNumbers };
};

type StartedMaintenanceOpenCode = Awaited<
    ReturnType<MaintenanceRuntime["opencode"]["start"]>
>;

const startMaintenancePlanner = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly emit: MaintenanceEmit;
    readonly onStarted: (service: StartedMaintenanceOpenCode) => void;
}): Promise<MaintenancePlanService> => {
    if (input.runtime.maintenancePlanner !== undefined) {
        return input.runtime.maintenancePlanner;
    }
    await input.emit({
        stage: "opencode-runtime",
        status: "started",
        message:
            "Starting OpenCode runtime for read-only maintenance planning...",
        repository: input.config.repo,
    });
    const started = await input.runtime.opencode.start();
    input.onStarted(started);
    const planner =
        input.runtime.maintenancePlannerForAgent?.(started.client) ??
        makeMaintenancePlanService({
            agent: started.client,
            repositoryInvariant: input.runtime.gitRepositoryInvariant,
        });
    await input.emit({
        stage: "opencode-runtime",
        status: "succeeded",
        message: "OpenCode runtime ready for read-only planning.",
        repository: input.config.repo,
    });
    return planner;
};

const finishMaintenanceRun = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly progress: MaintenanceRuntime["progress"];
    readonly dryRun: boolean;
    readonly statePath: string;
    readonly captured: MaintenanceSnapshot;
    readonly actualRunId: string;
    readonly branch: string;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly state: MutableMaintenanceState;
    readonly reports: MaintenanceReportResult[];
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly noIssues: boolean;
}): Promise<MaintenanceRunSummary> => {
    const summary: MaintenanceRunSummary = {
        runId: input.actualRunId,
        repository: input.config.repo,
        branch: input.branch,
        statePath: input.statePath,
        snapshotFingerprint: input.captured.fingerprint,
        selectedIssueNumbers: input.selectedIssueNumbers,
        counts: summaryFromReports(input.reports, input.state, false),
        dryRun: input.dryRun,
        evidence: [
            input.captured.metadata,
            ...input.captured.skips,
            ...input.reports.map((report) => report.result),
        ],
    };
    if (!input.dryRun) {
        await input.persist({
            ...input.state,
            status: "complete",
            nextIssueIndex: input.selectedIssueNumbers.length,
            updatedAt: nowIso(),
        });
    }
    if (!input.dryRun && input.config.cleanEnd) {
        await input.emit({
            stage: "workspace-cleanup",
            status: "started",
            message: `Removing workspace ${input.config.workspace}...`,
            repository: input.config.repo,
        });
        await input.runtime.workspace.remove(input.config.workspace);
        await input.progress.stopPersisting();
        await input.emit({
            stage: "workspace-cleanup",
            status: "succeeded",
            message: `Workspace removed: ${input.config.workspace}.`,
            repository: input.config.repo,
        });
    }
    await input.emit({
        stage: "run",
        status: "succeeded",
        message: input.noIssues
            ? "Maintenance completed; no issues matched the selection."
            : `Maintenance completed: ${summary.counts.changed} changed, ${summary.counts.unchanged} unchanged, ${summary.counts.skipped} skipped, ${summary.counts.replanned} replanned.`,
        repository: input.config.repo,
        details: summary,
    });
    return summary;
};

const executeMaintenanceIssues = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: MaintenanceRuntime;
    readonly progress: MaintenanceRuntime["progress"];
    readonly signal: AbortSignal | undefined;
    readonly statePath: string;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
    readonly captured: MaintenanceSnapshot;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly state: MutableMaintenanceState;
    readonly reports: MaintenanceReportResult[];
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly onOpenCodeStarted: (service: StartedMaintenanceOpenCode) => void;
}): Promise<MaintenanceRunSummary> => {
    if (input.selectedIssueNumbers.length === 0) {
        return finishMaintenanceRun({ ...input, noIssues: true });
    }
    const planner = await startMaintenancePlanner({
        config: input.config,
        runtime: input.runtime,
        emit: input.emit,
        onStarted: input.onOpenCodeStarted,
    });
    const lifecycle = await executeMaintenanceLifecycle({
        config: input.config,
        runtime: input.runtime,
        signal: input.signal,
        actualRunId: input.actualRunId,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
        selection: input.selection,
        branch: input.branch,
        repositoryPath: input.repositoryPath,
        client: input.client,
        snapshot: input.captured,
        planner,
        selectedIssueNumbers: input.selectedIssueNumbers,
        initialState: input.state,
        reports: input.reports,
        emit: input.emit,
        persist: input.persist,
    });
    return finishMaintenanceRun({
        ...input,
        state: lifecycle.state,
        noIssues: false,
    });
};

const persistMaintenanceFailure = async (input: {
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly statePath: string;
    readonly config: MaintainIssuesRalphieConfig;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly error: unknown;
}): Promise<void> => {
    if (input.dryRun || input.state === undefined) return;
    await input.persist({
        ...input.state,
        status: "failed",
        lastError: errorMessage(input.error),
        updatedAt: nowIso(),
    });
    await input.emit({
        stage: "maintenance-recovery",
        status: "succeeded",
        message: "Maintenance failure state was persisted for resume.",
        repository: input.config.repo,
        details: { kind: "recovery", statePath: input.statePath },
    });
};

const emitMaintenanceFailure = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly actualRunId: string;
    readonly statePath: string;
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly reports: ReadonlyArray<MaintenanceReportResult>;
    readonly emit: MaintenanceEmit;
    readonly error: unknown;
}): Promise<void> => {
    await input.emit({
        stage: "run",
        status: "failed",
        message: `Maintenance failed: ${errorMessage(input.error)}`,
        repository: input.config.repo,
        details: {
            kind: "outcome",
            runId: input.actualRunId,
            statePath: input.statePath,
            dryRun: input.dryRun,
            counts:
                input.state === undefined
                    ? undefined
                    : summaryFromReports(input.reports, input.state, true),
            evidence: input.reports.map((report) => report.result),
        },
    });
};

type MaintenanceRunInputs = {
    readonly stateStore: MaintenanceRunStateStoreService;
    readonly statePath: string;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly requestedBranch: string | undefined;
    readonly selection: MaintenanceSelectionState;
    readonly dryRun: boolean;
    readonly reports: MaintenanceReportResult[];
};

const maintenanceRunInputsFor = async (
    options: MaintainIssuesOptions,
    runtime: MaintenanceRuntime,
): Promise<MaintenanceRunInputs> => {
    const { config, signal } = options;
    checkCancellation(signal);
    const stateStore: MaintenanceRunStateStoreService =
        runtime.maintenanceRunStateStore ?? MaintenanceRunStateStoreLive;
    const statePath =
        config.resume ??
        join(
            resolveWorkspacePath(config.workspace),
            ".ralphie",
            "runs",
            options.runId,
            "state.json",
        );
    const resumeExpectations = {
        repository: config.repo,
        branch: config.branch,
        dryRun: config.dryRun,
        ...(options.explicitDuplicateAction === undefined
            ? {}
            : { duplicateAction: options.explicitDuplicateAction }),
    };
    const resumeState =
        options.resumeState ??
        (config.resume === undefined
            ? undefined
            : await loadMaintenanceRunState(
                  statePath,
                  resumeExpectations,
                  stateStore,
              ));
    if (resumeState !== undefined) {
        validateMaintenanceResumeState(resumeState, resumeExpectations);
    }
    return {
        stateStore,
        statePath,
        resumeState,
        actualRunId: resumeState?.runId ?? options.runId,
        duplicateAction: resumeState?.duplicateAction ?? config.duplicateAction,
        requestedBranch: resumeState?.branch ?? config.branch,
        selection: resumeState?.selection ?? selectionFor(config),
        dryRun: config.dryRun,
        reports: reportsFromResumeState(resumeState),
    };
};

const handleMaintenanceFailure = async (input: {
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly statePath: string;
    readonly config: MaintainIssuesRalphieConfig;
    readonly actualRunId: string;
    readonly reports: ReadonlyArray<MaintenanceReportResult>;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly error: unknown;
}): Promise<unknown> => {
    let error = input.error;
    try {
        await persistMaintenanceFailure({
            dryRun: input.dryRun,
            state: input.state,
            statePath: input.statePath,
            config: input.config,
            emit: input.emit,
            persist: input.persist,
            error,
        });
    } catch (persistError) {
        error = mutationFailure(
            `${errorMessage(error)}; failed to persist maintenance recovery state: ${errorMessage(persistError)}`,
            error,
        );
    }
    try {
        await emitMaintenanceFailure({
            config: input.config,
            actualRunId: input.actualRunId,
            statePath: input.statePath,
            dryRun: input.dryRun,
            state: input.state,
            reports: input.reports,
            emit: input.emit,
            error,
        });
    } catch {
        // A renderer failure must not prevent the durable failure state or
        // the original command error from reaching the CLI boundary.
    }
    return error;
};

/** Run one bounded maintenance pass and return its summary internally. */
export const executeMaintenanceRun = async (
    options: MaintainIssuesOptions,
    runtime: MaintenanceRuntime,
): Promise<MaintenanceRunSummary> => {
    const { config, signal } = options;
    const {
        stateStore,
        statePath,
        resumeState,
        actualRunId,
        duplicateAction,
        requestedBranch,
        selection,
        dryRun,
        reports,
    } = await maintenanceRunInputsFor(options, runtime);
    let state: MutableMaintenanceState | undefined;
    let startedOpenCode: StartedMaintenanceOpenCode | undefined;

    const persist = async (next: MutableMaintenanceState): Promise<void> => {
        state = next;
        if (!dryRun) await stateStore.save(statePath, next);
    };
    const emit: MaintenanceEmit = async (update) => {
        await runtime.progress.emit(update);
    };

    try {
        await emit({
            stage: "run",
            status: "info",
            message: `Ralphie maintenance started for ${config.repo}.`,
            repository: config.repo,
            details: {
                mode: config.mode,
                runId: actualRunId,
                duplicateAction,
                dryRun,
                ...(requestedBranch === undefined ? {} : { requestedBranch }),
                statePath,
                ...(resumeState === undefined ? {} : { resumed: true }),
            },
        });
        await prepareMaintenanceWorkspace({
            config,
            runtime,
            dryRun,
            resumeState,
            emit,
        });
        const prepared = await prepareMaintenanceRepository({
            config,
            runtime,
            dryRun,
            requestedBranch,
            signal,
            emit,
        });
        checkCancellation(signal);
        const captured = await captureMaintenanceContext({
            config,
            runtime,
            signal,
            statePath,
            actualRunId,
            duplicateAction,
            dryRun,
            selection,
            branch: prepared.branch,
            repositoryPath: prepared.repositoryPath,
            client: prepared.client,
            resumeState,
            emit,
            persist,
        });
        state = captured.state;
        return await executeMaintenanceIssues({
            config,
            runtime,
            progress: runtime.progress,
            signal,
            statePath,
            actualRunId,
            duplicateAction,
            dryRun,
            selection,
            branch: prepared.branch,
            repositoryPath: prepared.repositoryPath,
            client: prepared.client,
            captured: captured.snapshot,
            selectedIssueNumbers: captured.selectedIssueNumbers,
            state: captured.state,
            reports,
            emit,
            persist,
            onOpenCodeStarted: (started) => {
                startedOpenCode = started;
            },
        });
    } catch (error) {
        const finalError = await handleMaintenanceFailure({
            dryRun,
            state,
            statePath,
            config,
            actualRunId,
            reports,
            emit,
            persist,
            error,
        });
        if (finalError instanceof Error) throw finalError;
        throw mutationFailure("Maintenance failed.", finalError);
    } finally {
        await startedOpenCode?.close();
    }
};

/** Public command entry point. */
export const maintainIssues: MaintainIssuesEntryPoint = async (
    options,
    runtime,
): Promise<void> => {
    await executeMaintenanceRun(options, runtime);
};