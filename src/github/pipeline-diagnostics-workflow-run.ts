/**
 * Bounded workflow-run diagnostics for GitHub Actions.
 *
 * This module deliberately collects only jobs returned by the injected
 * `actions.listJobsForWorkflowRun` endpoint. Steps are embedded in the job
 * response, so no URL-like field from a job or step can become a request.
 * Diagnostics are selected before identity grouping: a check-run carrying a
 * coincidental run ID never reaches the jobs endpoint.
 */
import type { Octokit } from "octokit";

import { budgetRawEvidence, TRUNCATION_MARKER_KEY } from "./evidence-budget.ts";
import {
    classifyDiagnosticError,
    type DiagnosticFailureDisposition,
} from "./pipeline-diagnostics-errors.ts";
import {
    MAX_JOBS_PER_RUN,
    MAX_PAGINATION_PAGES,
    MAX_STEPS_PER_JOB,
    type CollectedRecord,
    type CollectionResult,
    type DiagnosticError,
    type DiagnosticRecordDisposition,
    type JobContext,
    type JsonObject,
    type JsonValue,
    type PipelineDiagnostic,
    type PipelineIdentifier,
    type PipelineRawState,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
    type RunIdentity,
    type StepRecord,
} from "./pipeline-diagnostics-contracts.ts";
import {
    paginateJobs,
    type Endpoint,
    type PaginationResult,
} from "./pipeline-diagnostics-pagination.ts";
import type { FailedPipelineObservation } from "./pipeline-observation.ts";
import { classifyPipelineState, serializeJson } from "./pipeline-snapshot.ts";
import type { PipelineSnapshotRequestExecutor } from "./pipeline-snapshot-collector.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Source label used for the workflow-run branch of diagnostics. */
export const WORKFLOW_RUN_DIAGNOSTIC_SOURCE = "workflow-run" as const;

/** Source label used for jobs endpoint failures and dispositions. */
export const WORKFLOW_RUN_JOBS_SOURCE = "github.workflow-run.jobs" as const;

const DEFAULT_PROVIDER = "github.workflow-run";
const PAGE_SIZE = 100;

/** Input to the workflow-run jobs and steps collector. */
export type WorkflowRunDiagnosticsInput = {
    readonly request: PipelineSnapshotRequest;
    /** Diagnostics to inspect; snapshot/observation are fallback sources. */
    readonly diagnostics?: ReadonlyArray<PipelineDiagnostic>;
    /** Snapshot carrying selected, normalized diagnostics. */
    readonly snapshot?: PipelineSnapshot;
    /** Failed observation whose snapshot and identity should be retained. */
    readonly observation?: FailedPipelineObservation;
};

/** Injectable dependencies and test-only tighter bounds. */
export type WorkflowRunDiagnosticsDependencies = {
    /** Explicit `actions.listJobsForWorkflowRun` endpoint. */
    readonly endpoint?: Endpoint;
    /** Octokit client used only to discover the allowlisted jobs endpoint. */
    readonly client?: Octokit;
    /** Optional request executor used for every endpoint call. */
    readonly request?: PipelineSnapshotRequestExecutor;
    /** Page size used by the bounded endpoint request (at most GitHub's 100). */
    readonly perPage?: number;
    /** Maximum pages; never allowed to exceed MAX_PAGINATION_PAGES. */
    readonly maxPages?: number;
    /** Maximum jobs; never allowed to exceed MAX_JOBS_PER_RUN. */
    readonly maxJobsPerRun?: number;
    /** Maximum steps; never allowed to exceed MAX_STEPS_PER_JOB. */
    readonly maxStepsPerJob?: number;
};

/** Service shape matching the repository's explicit read-only services. */
export type WorkflowRunDiagnosticsService = {
    readonly collect: (
        input: WorkflowRunDiagnosticsInput,
    ) => Promise<CollectionResult>;
    readonly read: (
        input: WorkflowRunDiagnosticsInput,
    ) => Promise<CollectionResult>;
};

type Identity = {
    readonly provider: string;
    readonly commitSha: string;
    readonly runId: PipelineIdentifier;
    readonly runAttempt: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
};

type RunWork = {
    readonly identity: Identity;
    readonly diagnostic: PipelineDiagnostic;
};

type InvalidWork = {
    readonly error: DiagnosticError;
};

type Work = RunWork | InvalidWork;

type ParsedStep = {
    readonly value: StepRecord;
    readonly truncated: boolean;
};

type ParsedJob = {
    readonly value: JobContext;
    readonly steps: ReadonlyArray<ParsedStep>;
    readonly stepErrors: ReadonlyArray<DiagnosticError>;
    readonly truncated: boolean;
    readonly identity: {
        readonly jobId: PipelineIdentifier;
        readonly runId: PipelineIdentifier;
        readonly runAttempt: PipelineIdentifier;
        readonly commitSha: string;
        readonly workflowId?: PipelineIdentifier;
    };
};

type JobParseResult =
    | { readonly kind: "valid"; readonly job: ParsedJob }
    | { readonly kind: "invalid"; readonly error: DiagnosticError };

type CollectionState = {
    readonly records: CollectedRecord[];
    readonly errors: DiagnosticError[];
    truncated: boolean;
};

type RequestTrace = {
    cause?: unknown;
    response?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const bounded = (value: unknown): JsonValue => budgetRawEvidence(value).value;

const containsTruncationMarker = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.some(containsTruncationMarker);
    if (!isRecord(value)) return false;
    return (
        hasOwn(value, TRUNCATION_MARKER_KEY) ||
        Object.values(value).some((entry) =>
            containsTruncationMarker(entry as JsonValue),
        )
    );
};

const identifier = (value: unknown): PipelineIdentifier | undefined => {
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
        return value;
    return undefined;
};

const identifierAt = (
    value: Record<string, unknown>,
    names: ReadonlyArray<string>,
): PipelineIdentifier | undefined => {
    const values = names
        .filter((name) => hasOwn(value, name))
        .map((name) => identifier(value[name]));
    if (values.length === 0 || values.some((value) => value === undefined))
        return undefined;
    const unique = [...new Set(values.map((value) => identifierToken(value!)))];
    return unique.length === 1 ? values[0] : undefined;
};

const identifierToken = (value: PipelineIdentifier): string =>
    String(value).trim();

const sameIdentifier = (
    left: PipelineIdentifier | undefined,
    right: PipelineIdentifier | undefined,
): boolean =>
    left !== undefined &&
    right !== undefined &&
    identifierToken(left) === identifierToken(right);

const shaValue = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;

const sameSha = (left: string, right: string): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();

const rawField = (
    value: Record<string, unknown>,
    names: ReadonlyArray<string>,
): unknown => {
    for (const name of names) if (hasOwn(value, name)) return value[name];
    return undefined;
};

const shaAt = (
    value: Record<string, unknown>,
    names: ReadonlyArray<string>,
): string | undefined => {
    const values = names
        .filter((name) => hasOwn(value, name))
        .map((name) => shaValue(value[name]));
    if (values.length === 0 || values.some((value) => value === undefined))
        return undefined;
    const unique = [...new Set(values.map((value) => value!.toLowerCase()))];
    return unique.length === 1 ? values[0] : undefined;
};

const rawStateFor = (value: Record<string, unknown>): PipelineRawState => ({
    ...(hasOwn(value, "status") ? { status: serializeJson(value.status) } : {}),
    ...(hasOwn(value, "state") ? { state: serializeJson(value.state) } : {}),
    ...(hasOwn(value, "conclusion")
        ? { conclusion: serializeJson(value.conclusion) }
        : {}),
});

const rawDiagnosticSha = (diagnostic: PipelineDiagnostic): string | undefined =>
    shaAt(diagnostic.rawValues, [
        "commitSha",
        "commit_sha",
        "sha",
        "headSha",
        "head_sha",
    ]);

const diagnosticError = (
    message: string,
    evidence: unknown,
    cause?: unknown,
    disposition?: DiagnosticFailureDisposition,
): DiagnosticError =>
    classifyDiagnosticError({
        source: WORKFLOW_RUN_JOBS_SOURCE,
        message,
        cause,
        ...(disposition === undefined ? {} : { disposition }),
        evidence,
    });

const diagnosticCandidates = (
    input: WorkflowRunDiagnosticsInput,
): ReadonlyArray<PipelineDiagnostic> => {
    if (input.diagnostics !== undefined) return input.diagnostics;
    if (input.snapshot !== undefined)
        return input.snapshot.items.map((item) => item.diagnostic);
    if (input.observation?.snapshot !== undefined)
        return input.observation.snapshot.items.map((item) => item.diagnostic);
    return [];
};

const isFailingDiagnostic = (diagnostic: PipelineDiagnostic): boolean =>
    diagnostic.disposition === "selected" &&
    diagnostic.source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE &&
    classifyPipelineState(diagnostic.rawState) === "failing";

const identityKey = (identity: Identity): string =>
    JSON.stringify([
        identity.provider,
        identity.commitSha.trim().toLowerCase(),
        identifierToken(identity.runId),
        identifierToken(identity.runAttempt),
        identity.workflowId === undefined
            ? null
            : identifierToken(identity.workflowId),
    ]);

const runEvidenceFor = (work: RunWork): Record<string, unknown> => ({
    provider: work.identity.provider,
    commitSha: work.identity.commitSha,
    runId: work.identity.runId,
    runAttempt: work.identity.runAttempt,
    ...(work.identity.workflowId === undefined
        ? {}
        : { workflowId: work.identity.workflowId }),
});

const workForDiagnostic = (
    diagnostic: PipelineDiagnostic,
    request: PipelineSnapshotRequest,
): Work => {
    const provider = diagnostic.provider?.trim() || DEFAULT_PROVIDER;
    const runId = diagnostic.runId;
    const runAttempt = diagnostic.runAttempt;
    const workflowId = diagnostic.workflowId;
    if (runId === undefined || identifier(runId) === undefined)
        return {
            error: diagnosticError(
                "workflow-run diagnostic is missing a usable run ID.",
                { diagnostic },
                undefined,
                "malformed",
            ),
        };
    if (runAttempt === undefined || identifier(runAttempt) === undefined)
        return {
            error: diagnosticError(
                "workflow-run diagnostic is missing a usable run attempt; jobs were not requested.",
                { diagnostic },
                undefined,
                "malformed",
            ),
        };
    if (workflowId !== undefined && identifier(workflowId) === undefined)
        return {
            error: diagnosticError(
                "workflow-run diagnostic contains a malformed workflow ID.",
                { diagnostic },
                undefined,
                "malformed",
            ),
        };
    const commitSha = shaValue(request.commitSha);
    if (commitSha === undefined)
        return {
            error: diagnosticError(
                "workflow-run request is missing an exact commit SHA.",
                { diagnostic, request },
                undefined,
                "malformed",
            ),
        };
    const diagnosticSha = rawDiagnosticSha(diagnostic);
    if (diagnosticSha !== undefined && !sameSha(diagnosticSha, commitSha))
        return {
            error: diagnosticError(
                "workflow-run diagnostic commit SHA conflicts with the requested exact SHA.",
                { diagnostic, requestedSha: commitSha },
                undefined,
                "malformed",
            ),
        };
    return {
        identity: {
            provider,
            commitSha,
            runId,
            runAttempt,
            ...(workflowId === undefined ? {} : { workflowId }),
        },
        diagnostic,
    };
};

const workForInput = (
    input: WorkflowRunDiagnosticsInput,
): {
    readonly work: ReadonlyArray<RunWork>;
    readonly errors: DiagnosticError[];
} => {
    const work: RunWork[] = [];
    const errors: DiagnosticError[] = [];
    const seen = new Set<string>();
    for (const diagnostic of diagnosticCandidates(input)) {
        if (!isFailingDiagnostic(diagnostic)) continue;
        const candidate = workForDiagnostic(diagnostic, input.request);
        if ("error" in candidate) {
            errors.push(candidate.error);
            continue;
        }
        const key = identityKey(candidate.identity);
        if (seen.has(key)) continue;
        seen.add(key);
        work.push(candidate);
    }
    return { work, errors };
};

const jobIdentityError = (
    message: string,
    rawJob: unknown,
): JobParseResult => ({
    kind: "invalid",
    error: diagnosticError(message, { job: rawJob }, undefined, "malformed"),
});

const stepNumberFor = (step: Record<string, unknown>): number | undefined => {
    const values = [step.number, step.step_number].filter(
        (value) => value !== undefined,
    );
    if (values.length === 0) return undefined;
    if (
        values.some(
            (value) =>
                typeof value !== "number" ||
                !Number.isSafeInteger(value) ||
                value <= 0,
        )
    )
        return undefined;
    const unique = [...new Set(values as number[])];
    return unique.length === 1 ? unique[0] : undefined;
};

const stepTimestamp = (
    step: Record<string, unknown>,
    names: ReadonlyArray<string>,
): string | undefined => {
    const value = rawField(step, names);
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
};

const parsedStep = (
    value: unknown,
    index: number,
): ParsedStep | DiagnosticError => {
    if (!isRecord(value))
        return diagnosticError(
            `workflow-run job step ${String(index + 1)} is not a JSON object.`,
            { step: value },
            undefined,
            "malformed",
        );
    const number = stepNumberFor(value);
    if (number === undefined)
        return diagnosticError(
            `workflow-run job step ${String(index + 1)} is missing a usable numeric identity.`,
            { step: value },
            undefined,
            "malformed",
        );
    const name = typeof value.name === "string" ? value.name : undefined;
    if (name === undefined || name.trim().length === 0)
        return diagnosticError(
            `workflow-run job step ${String(index + 1)} is missing a usable name.`,
            { step: value },
            undefined,
            "malformed",
        );
    const startedAt = stepTimestamp(value, ["startedAt", "started_at"]);
    const completedAt = stepTimestamp(value, ["completedAt", "completed_at"]);
    const candidate = Object.assign({ name, number }, value, {
        name,
        number,
        ...(hasOwn(value, "conclusion")
            ? { conclusion: serializeJson(value.conclusion) }
            : {}),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
    });
    const raw = bounded(candidate);
    return {
        value: isRecord(raw)
            ? (raw as StepRecord)
            : ({ name, number } as StepRecord),
        truncated: containsTruncationMarker(raw),
    };
};

const parseSteps = (
    rawJob: Record<string, unknown>,
    diagnostic: PipelineDiagnostic,
    maxSteps: number,
): {
    readonly steps: ReadonlyArray<ParsedStep>;
    readonly errors: ReadonlyArray<DiagnosticError>;
    readonly truncated: boolean;
} => {
    const rawSteps = rawJob.steps;
    if (rawSteps === undefined)
        return { steps: [], errors: [], truncated: false };
    if (!Array.isArray(rawSteps))
        return {
            steps: [],
            errors: [
                diagnosticError(
                    "workflow-run job has a malformed steps field.",
                    { job: rawJob, diagnostic },
                    undefined,
                    "malformed",
                ),
            ],
            truncated: false,
        };

    const steps: ParsedStep[] = [];
    const errors: DiagnosticError[] = [];
    for (const [index, step] of rawSteps.entries()) {
        if (steps.length >= maxSteps) break;
        const parsed = parsedStep(step, index);
        if ("source" in parsed) {
            errors.push(
                diagnosticError(
                    parsed.message,
                    { job: rawJob, step, diagnostic },
                    undefined,
                    "malformed",
                ),
            );
            continue;
        }
        steps.push(parsed);
        if (parsed.truncated)
            errors.push(
                diagnosticError(
                    `workflow-run job step ${String(index + 1)} raw evidence was truncated.`,
                    { step: parsed.value },
                    undefined,
                    "truncated",
                ),
            );
    }
    const truncated =
        rawSteps.length > maxSteps || steps.some((step) => step.truncated);
    if (truncated)
        errors.push(
            diagnosticError(
                `workflow-run job steps exceeded the ${String(maxSteps)}-step bound.`,
                { jobId: rawJob.id ?? rawJob.job_id, steps: rawSteps.length },
                undefined,
                "truncated",
            ),
        );
    return { steps, errors, truncated };
};

const jobIdentityFor = (
    job: Record<string, unknown>,
):
    | {
          readonly jobId: PipelineIdentifier;
          readonly runId: PipelineIdentifier;
          readonly runAttempt: PipelineIdentifier;
          readonly commitSha: string;
          readonly workflowId?: PipelineIdentifier;
      }
    | DiagnosticError => {
    const jobId = identifierAt(job, ["id", "job_id"]);
    if (jobId === undefined)
        return diagnosticError(
            "workflow-run job is missing a usable job ID.",
            { job },
            undefined,
            "malformed",
        );
    const runId = identifierAt(job, ["run_id", "runId"]);
    if (runId === undefined)
        return diagnosticError(
            `workflow-run job ${identifierToken(jobId)} is missing a usable run ID.`,
            { job },
            undefined,
            "malformed",
        );
    const runAttempt = identifierAt(job, ["run_attempt", "runAttempt"]);
    if (runAttempt === undefined)
        return diagnosticError(
            `workflow-run job ${identifierToken(jobId)} is missing a usable run attempt.`,
            { job },
            undefined,
            "malformed",
        );
    const commitSha = shaAt(job, ["head_sha", "headSha"]);
    if (commitSha === undefined)
        return diagnosticError(
            `workflow-run job ${identifierToken(jobId)} is missing an exact head SHA.`,
            { job },
            undefined,
            "malformed",
        );
    const workflowIdNames = ["workflow_id", "workflowId"];
    const hasWorkflowId = workflowIdNames.some((name) => hasOwn(job, name));
    const workflowId = identifierAt(job, workflowIdNames);
    if (hasWorkflowId && workflowId === undefined)
        return diagnosticError(
            `workflow-run job ${identifierToken(jobId)} has a malformed workflow ID.`,
            { job },
            undefined,
            "malformed",
        );
    return {
        jobId,
        runId,
        runAttempt,
        commitSha,
        ...(workflowId === undefined ? {} : { workflowId }),
    };
};

const jobMatches = (
    identity: ReturnType<typeof jobIdentityFor>,
    requested: Identity,
): identity is Extract<
    ReturnType<typeof jobIdentityFor>,
    { readonly jobId: PipelineIdentifier }
> => {
    if ("source" in identity) return false;
    return (
        sameIdentifier(identity.runId, requested.runId) &&
        sameIdentifier(identity.runAttempt, requested.runAttempt) &&
        sameSha(identity.commitSha, requested.commitSha) &&
        (requested.workflowId === undefined ||
            identity.workflowId === undefined ||
            sameIdentifier(identity.workflowId, requested.workflowId))
    );
};

const mismatchMessage = (
    requested: Identity,
    rawJob: Record<string, unknown>,
): string => {
    const jobId = identifierAt(rawJob, ["id", "job_id"]);
    const attempt = identifierAt(rawJob, ["run_attempt", "runAttempt"]);
    const runId = identifierAt(rawJob, ["run_id", "runId"]);
    const sha = shaValue(rawField(rawJob, ["head_sha", "headSha"]));
    if (!sameIdentifier(runId, requested.runId))
        return `workflow-run job ${String(jobId ?? "(unknown)")} belongs to a different run and was omitted.`;
    if (!sameIdentifier(attempt, requested.runAttempt))
        return `workflow-run job ${String(jobId ?? "(unknown)")} belongs to attempt ${String(attempt ?? "(missing)")} instead of requested attempt ${identifierToken(requested.runAttempt)} and was omitted.`;
    if (sha === undefined || !sameSha(sha, requested.commitSha))
        return `workflow-run job ${String(jobId ?? "(unknown)")} does not match the requested exact commit SHA and was omitted.`;
    return `workflow-run job ${String(jobId ?? "(unknown")} does not match the requested workflow identity and was omitted.`;
};

const parseJob = (
    value: unknown,
    work: RunWork,
    maxSteps: number,
): { readonly result: JobParseResult; readonly truncated: boolean } => {
    if (!isRecord(value))
        return {
            result: jobIdentityError(
                "workflow-run job is not a JSON object.",
                value,
            ),
            truncated: false,
        };
    const identity = jobIdentityFor(value);
    if ("source" in identity)
        return {
            result: { kind: "invalid", error: identity },
            truncated: false,
        };
    if (!jobMatches(identity, work.identity))
        return {
            result: {
                kind: "invalid",
                error: diagnosticError(
                    mismatchMessage(work.identity, value),
                    { job: value, diagnostic: work.diagnostic },
                    undefined,
                    "malformed",
                ),
            },
            truncated: false,
        };
    const steps = parseSteps(value, work.diagnostic, maxSteps);
    const rawState = rawStateFor(value);
    const workflowId = identity.workflowId ?? work.identity.workflowId;
    const { steps: _originalSteps, ...jobWithoutSteps } = value;
    const candidate = Object.assign(
        {
            provider: work.identity.provider,
            commitSha: work.identity.commitSha,
            runId: identity.runId,
            runAttempt: identity.runAttempt,
            jobId: identity.jobId,
            ...(workflowId === undefined ? {} : { workflowId }),
            rawState,
            steps: steps.steps.map((step) => step.value),
            diagnostic: work.diagnostic,
        },
        jobWithoutSteps,
        {
            provider: work.identity.provider,
            commitSha: work.identity.commitSha,
            runId: identity.runId,
            runAttempt: identity.runAttempt,
            jobId: identity.jobId,
            ...(workflowId === undefined ? {} : { workflowId }),
            rawState,
            steps: steps.steps.map((step) => step.value),
            diagnostic: work.diagnostic,
        },
    );
    const rawValues = bounded(candidate);
    const rawEvidenceTruncated = containsTruncationMarker(rawValues);
    const stepErrors = [
        ...steps.errors,
        ...(rawEvidenceTruncated
            ? [
                  diagnosticError(
                      "workflow-run job raw evidence was truncated.",
                      { job: rawValues },
                      undefined,
                      "truncated",
                  ),
              ]
            : []),
    ];
    const jobValue = {
        ...(isRecord(rawValues) ? rawValues : candidate),
        rawValues,
    } as JobContext;
    return {
        result: {
            kind: "valid",
            job: {
                value: jobValue,
                steps: steps.steps,
                stepErrors,
                truncated: steps.truncated || rawEvidenceTruncated,
                identity: {
                    ...identity,
                    ...(workflowId === undefined ? {} : { workflowId }),
                },
            },
        },
        truncated: steps.truncated || rawEvidenceTruncated,
    };
};

const dispositionForErrors = (
    errors: ReadonlyArray<DiagnosticError>,
    truncated: boolean,
): DiagnosticRecordDisposition => {
    if (
        truncated ||
        errors.some(({ disposition }) => disposition === "truncated")
    )
        return "truncated";
    const priority: ReadonlyArray<DiagnosticRecordDisposition> = [
        "rate-limited",
        "unavailable",
        "malformed",
    ];
    return (
        priority.find((disposition) =>
            errors.some((error) => error.disposition === disposition),
        ) ?? "ok"
    );
};

const recordError = (
    kind: CollectedRecord["kind"],
    value: CollectedRecord["value"],
    disposition: DiagnosticRecordDisposition,
    errors: ReadonlyArray<DiagnosticError>,
): CollectedRecord =>
    ({
        kind,
        value,
        disposition,
        ...(errors.length === 0 ? {} : { errors }),
    }) as CollectedRecord;

const runValueFor = (work: RunWork): RunIdentity => {
    const rawValues = bounded(work.diagnostic.rawValues);
    const identity = {
        provider: work.identity.provider,
        commitSha: work.identity.commitSha,
        runId: work.identity.runId,
        runAttempt: work.identity.runAttempt,
        ...(work.identity.workflowId === undefined
            ? {}
            : { workflowId: work.identity.workflowId }),
    };
    return Object.assign(
        identity,
        isRecord(rawValues) ? rawValues : {},
        identity,
        { diagnostic: work.diagnostic, rawValues },
    ) as RunIdentity;
};

const appendJobRecords = (
    state: CollectionState,
    parsed: ParsedJob,
    work: RunWork,
    jobErrors: ReadonlyArray<DiagnosticError>,
): void => {
    const jobDisposition = dispositionForErrors(
        jobErrors,
        jobErrors.some(({ disposition }) => disposition === "truncated"),
    );
    state.records.push(
        recordError("job", parsed.value, jobDisposition, jobErrors),
    );
    for (const step of parsed.steps)
        state.records.push(
            recordError(
                "step",
                Object.assign(
                    {
                        provider: work.identity.provider,
                        commitSha: work.identity.commitSha,
                        runId: parsed.identity.runId,
                        runAttempt: parsed.identity.runAttempt,
                        jobId: parsed.identity.jobId,
                        ...(parsed.identity.workflowId === undefined
                            ? {}
                            : { workflowId: parsed.identity.workflowId }),
                    },
                    step.value,
                    {
                        provider: work.identity.provider,
                        commitSha: work.identity.commitSha,
                        runId: parsed.identity.runId,
                        runAttempt: parsed.identity.runAttempt,
                        jobId: parsed.identity.jobId,
                        ...(parsed.identity.workflowId === undefined
                            ? {}
                            : { workflowId: parsed.identity.workflowId }),
                        diagnostic: work.diagnostic,
                    },
                ) as StepRecord,
                step.truncated ? "truncated" : "ok",
                [],
            ),
        );
};

const paginationErrorFor = (
    pagination: PaginationResult,
    trace: RequestTrace,
    work: RunWork,
): DiagnosticError | undefined => {
    if (pagination.error === undefined) return undefined;
    const explicit =
        pagination.error.disposition === "malformed"
            ? ("malformed" as const)
            : trace.cause === undefined
              ? ("unavailable" as const)
              : undefined;
    return diagnosticError(
        pagination.error.message,
        {
            ...runEvidenceFor(work),
            records: pagination.records,
            ...(trace.response === undefined
                ? {}
                : { response: trace.response }),
            ...(trace.cause === undefined ? {} : { cause: trace.cause }),
        },
        trace.cause,
        explicit,
    );
};

const paginationTruncationError = (
    pagination: PaginationResult,
    work: RunWork,
): DiagnosticError | undefined =>
    pagination.disposition !== "truncated"
        ? undefined
        : diagnosticError(
              `workflow-run jobs collection was truncated after ${String(pagination.records.length)} retained jobs.`,
              {
                  ...runEvidenceFor(work),
                  records: pagination.records,
                  truncation: pagination.truncation,
              },
              undefined,
              "truncated",
          );

const applyPaginationOutcome = (
    state: CollectionState,
    pagination: PaginationResult,
    trace: RequestTrace,
    work: RunWork,
): boolean => {
    const paginationError = paginationErrorFor(pagination, trace, work);
    if (paginationError !== undefined) state.errors.push(paginationError);
    const truncationError = paginationTruncationError(pagination, work);
    if (truncationError === undefined) return false;
    state.errors.push(truncationError);
    state.truncated = true;
    return true;
};

const appendParsedJobs = (
    state: CollectionState,
    records: ReadonlyArray<JsonValue>,
    work: RunWork,
    maxSteps: number,
): { readonly matched: number; readonly truncated: boolean } => {
    let matched = 0;
    let truncated = false;
    for (const rawJob of records) {
        const parsed = parseJob(rawJob, work, maxSteps);
        if (parsed.result.kind === "invalid") {
            state.errors.push(parsed.result.error);
            continue;
        }
        matched += 1;
        const jobErrors = parsed.result.job.stepErrors;
        state.errors.push(...jobErrors);
        if (parsed.result.job.truncated) {
            state.truncated = true;
            truncated = true;
        }
        appendJobRecords(state, parsed.result.job, work, jobErrors);
    }
    return { matched, truncated };
};

const appendNoMatchingJobsError = (
    state: CollectionState,
    pagination: PaginationResult,
    work: RunWork,
    matched: number,
): void => {
    if (pagination.error !== undefined || matched > 0) return;
    if (pagination.disposition === "truncated") return;
    const message =
        pagination.records.length === 0
            ? "workflow-run jobs response contained no jobs from which the requested run attempt could be established."
            : "workflow-run jobs response contained no job matching the requested run attempt and exact SHA.";
    state.errors.push(
        diagnosticError(
            message,
            { records: pagination.records, diagnostic: work.diagnostic },
            undefined,
            "malformed",
        ),
    );
};

const collectRun = async (
    input: WorkflowRunDiagnosticsInput,
    work: RunWork,
    dependencies: WorkflowRunDiagnosticsDependencies,
    state: CollectionState,
): Promise<void> => {
    const errorStart = state.errors.length;
    const recordStart = state.records.length;
    const diagnosticRawValues = bounded(work.diagnostic.rawValues);
    const diagnosticEvidenceTruncated =
        containsTruncationMarker(diagnosticRawValues);
    if (diagnosticEvidenceTruncated)
        state.errors.push(
            diagnosticError(
                "workflow-run diagnostic raw evidence was truncated.",
                { rawValues: diagnosticRawValues },
                undefined,
                "truncated",
            ),
        );
    if (diagnosticEvidenceTruncated) state.truncated = true;
    const { owner, name: repo } = parseRepositorySlug(input.request.repository);
    const endpoint = endpointFor(dependencies);
    const trace: RequestTrace = {};
    const baseRequest = dependencies.request ?? requestDirectly;
    const perPage = boundedLimit(dependencies.perPage, PAGE_SIZE);
    const request: PipelineSnapshotRequestExecutor = async (
        requestEndpoint,
        parameters,
        signal,
    ) => {
        try {
            const response = await baseRequest(
                requestEndpoint,
                parameters,
                signal,
            );
            trace.response = response;
            return response;
        } catch (cause) {
            trace.cause = cause;
            throw cause;
        }
    };
    const pagination = await paginateJobs({
        source: WORKFLOW_RUN_JOBS_SOURCE,
        endpoint,
        parameters: {
            owner,
            repo,
            run_id: work.identity.runId,
            filter: "all",
            per_page: perPage,
        },
        perPage,
        maxPages: boundedLimit(dependencies.maxPages, MAX_PAGINATION_PAGES),
        maxItems: boundedLimit(dependencies.maxJobsPerRun, MAX_JOBS_PER_RUN),
        request,
    });
    const paginationTruncated = applyPaginationOutcome(
        state,
        pagination,
        trace,
        work,
    );
    const maxSteps = boundedLimit(
        dependencies.maxStepsPerJob,
        MAX_STEPS_PER_JOB,
    );
    const jobs = appendParsedJobs(state, pagination.records, work, maxSteps);
    appendNoMatchingJobsError(state, pagination, work, jobs.matched);

    const runErrors = state.errors.slice(errorStart);
    const runDisposition = dispositionForErrors(
        runErrors,
        diagnosticEvidenceTruncated || paginationTruncated || jobs.truncated,
    );
    state.records.splice(
        recordStart,
        0,
        recordError("run", runValueFor(work), runDisposition, runErrors),
    );
};

const endpointFor = (
    dependencies: WorkflowRunDiagnosticsDependencies,
): Endpoint => {
    if (dependencies.endpoint !== undefined) return dependencies.endpoint;
    const actions =
        dependencies.client === undefined
            ? undefined
            : (
                  dependencies.client as unknown as {
                      readonly rest?: {
                          readonly actions?: {
                              readonly listJobsForWorkflowRun?: unknown;
                          };
                      };
                  }
              ).rest?.actions;
    return (actions?.listJobsForWorkflowRun ?? undefined) as Endpoint;
};

const requestDirectly: PipelineSnapshotRequestExecutor = async (
    endpoint,
    parameters,
    signal,
) =>
    endpoint({
        ...parameters,
        ...(signal === undefined ? {} : { request: { signal } }),
    });

const boundedLimit = (value: number | undefined, maximum: number): number => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
            `diagnostics limit must be a positive safe integer; received ${String(value)}.`,
        );
    return Math.min(value, maximum);
};

const collectWithDependencies = async (
    input: WorkflowRunDiagnosticsInput,
    dependencies: WorkflowRunDiagnosticsDependencies,
): Promise<CollectionResult> => {
    const state: CollectionState = {
        records: [],
        errors: [],
        truncated: false,
    };
    const selected = workForInput(input);
    state.errors.push(...selected.errors);
    for (const work of selected.work)
        await collectRun(input, work, dependencies, state);
    return {
        request: input.request,
        source: WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
        records: state.records,
        truncated: state.truncated,
        errors: state.errors,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        ...(input.observation === undefined
            ? {}
            : { observation: input.observation }),
    } as unknown as CollectionResult;
};

/** Collect bounded jobs and embedded steps for failing workflow-run diagnostics. */
export const collectWorkflowRunDiagnostics = (
    input: WorkflowRunDiagnosticsInput,
    dependencies: WorkflowRunDiagnosticsDependencies = {},
): Promise<CollectionResult> => collectWithDependencies(input, dependencies);

/** Alias emphasizing that the collector's records are jobs and steps. */
export const collectWorkflowRunJobsAndSteps = collectWorkflowRunDiagnostics;

/** Factory for the workflow-run diagnostics read service. */
export const makeWorkflowRunDiagnosticsService = (
    dependencies: WorkflowRunDiagnosticsDependencies = {},
): WorkflowRunDiagnosticsService => {
    const collect = (input: WorkflowRunDiagnosticsInput) =>
        collectWithDependencies(input, dependencies);
    return { collect, read: collect };
};

/** Compatibility alias for callers naming the collector rather than service. */
export const makeWorkflowRunDiagnosticsCollector =
    makeWorkflowRunDiagnosticsService;

/** Compatibility alias for the jobs-and-steps decomposition child. */
export const makePipelineDiagnosticsJobsCollector =
    makeWorkflowRunDiagnosticsService;