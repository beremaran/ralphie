/**
 * Public, read-only assembly of bounded pipeline diagnostics.
 *
 * The workflow-run and check-run collectors deliberately have separate
 * transport surfaces.  This module is the seam between a failed observation
 * and those collectors: it validates the immutable request, walks diagnostics
 * in their supplied order, routes each source before deduplicating it, and
 * merges the bounded records into one deterministic result.  It never follows
 * a URL from a diagnostic or an endpoint response.
 */
import type { Octokit } from "octokit";

import { classifyDiagnosticError } from "./pipeline-diagnostics-errors.ts";
import {
    CHECK_RUN_DIAGNOSTIC_SOURCE,
    CHECK_RUN_GET_SOURCE,
    type CheckRunDiagnosticsDependencies,
    type CheckRunDiagnosticsInput,
    type CheckRunDiagnosticsService,
    makeCheckRunDiagnosticsService,
} from "./pipeline-diagnostics-checks.ts";
import {
    WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
    type WorkflowRunDiagnosticsDependencies,
    type WorkflowRunDiagnosticsInput,
    type WorkflowRunDiagnosticsService,
    makeWorkflowRunDiagnosticsService,
} from "./pipeline-diagnostics-workflow-run.ts";
import {
    type CollectedRecord,
    type CollectionResult,
    type DiagnosticError,
    type DiagnosticRecordDisposition,
    type PipelineDiagnostic,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "./pipeline-diagnostics-contracts.ts";
import type { FailedPipelineObservation } from "./pipeline-observation.ts";
import { classifyPipelineState, serializeJson } from "./pipeline-snapshot.ts";
import type { PipelineSnapshotRequestExecutor } from "./pipeline-snapshot-collector.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Source label for the composed result. */
export const PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE =
    "pipeline-diagnostics" as const;

/** Input accepted by the composed diagnostics operation. */
export type PipelineDiagnosticsCollectorInput = {
    /** Request identity; when omitted it is derived from a supplied snapshot. */
    readonly request?: PipelineSnapshotRequest;
    /** A normalized snapshot to diagnose. */
    readonly snapshot?: PipelineSnapshot;
    /** The failed observation that caused diagnostics to be requested. */
    readonly observation?: FailedPipelineObservation;
    /** Explicit diagnostics, primarily useful for callers with a snapshot slice. */
    readonly diagnostics?: ReadonlyArray<PipelineDiagnostic>;
    /** Optional caller cancellation signal for the read-only operation. */
    readonly signal?: AbortSignal;
};

/**
 * Dependencies for the composed operation.  A child can be supplied either
 * as its explicit service or as its endpoint dependency object; this keeps
 * the operation easy to use with both a real Octokit client and deterministic
 * fake endpoints in tests.
 */
export type PipelineDiagnosticsCollectorDependencies = {
    readonly client?: Octokit;
    readonly request?: PipelineSnapshotRequestExecutor;

    readonly jobs?:
        | WorkflowRunDiagnosticsService
        | WorkflowRunDiagnosticsDependencies;
    readonly checks?:
        | CheckRunDiagnosticsService
        | CheckRunDiagnosticsDependencies;
};

/** The two child results plus the deterministic aggregate. */
export type PipelineDiagnosticsCollectionResult = {
    readonly request: PipelineSnapshotRequest;
    readonly source: typeof PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE;
    readonly records: ReadonlyArray<CollectedRecord>;
    /** Aggregate disposition; child record/error dispositions are preserved. */
    readonly disposition: DiagnosticRecordDisposition;
    readonly truncated: boolean;
    readonly errors: ReadonlyArray<DiagnosticError>;
    readonly snapshot?: PipelineSnapshot;
    readonly observation?: FailedPipelineObservation;
    /** Jobs and embedded steps collected by the workflow-run child. */
    readonly jobs: CollectionResult;
    /** Check runs and annotations collected by the check-run child. */
    readonly checks: CollectionResult;
};

export type PipelineDiagnosticsCollectorService = {
    readonly collect: (
        input: PipelineDiagnosticsCollectorInput,
    ) => Promise<PipelineDiagnosticsCollectionResult>;
};

const EXACT_COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const FALLBACK_REQUEST: PipelineSnapshotRequest = {
    repository: "",
    branch: "",
    commitSha: "",
};

type SourceKind = "workflow-run" | "check-run";

type ResolvedCollectorInput = {
    readonly request: PipelineSnapshotRequest;
    readonly snapshot?: PipelineSnapshot;
    readonly observation?: FailedPipelineObservation;
    readonly diagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly workflowDiagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly checkDiagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly errors: ReadonlyArray<DiagnosticError>;
};

type RankedRecord = {
    readonly record: CollectedRecord;
    readonly source: SourceKind;
    readonly diagnosticOrder: number;
    readonly identity: string;
    readonly kindOrder: number;
    readonly originalOrder: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;

const identifier = (value: unknown): string | number | undefined => {
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
        return value;
    return undefined;
};

const token = (value: unknown): string | null => {
    const normalized = identifier(value);
    return normalized === undefined ? null : String(normalized).trim();
};

const sha = (value: unknown): string | undefined => {
    const normalized = text(value);
    return normalized === undefined ? undefined : normalized;
};

const normalizedBranch = (value: string): string =>
    value.trim().replace(/^refs\/heads\//i, "");

const sameRequestIdentity = (
    left: PipelineSnapshotRequest,
    right: PipelineSnapshotRequest,
): boolean => {
    try {
        return (
            parseRepositorySlug(left.repository).slug.toLowerCase() ===
                parseRepositorySlug(right.repository).slug.toLowerCase() &&
            normalizedBranch(left.branch) === normalizedBranch(right.branch) &&
            left.commitSha.trim().toLowerCase() ===
                right.commitSha.trim().toLowerCase()
        );
    } catch {
        return false;
    }
};

const canonical = (value: unknown): string => {
    const serialized = serializeJson(value);
    const visit = (entry: ReturnType<typeof serializeJson>): string => {
        if (entry === null) return "null";
        if (typeof entry === "string") return JSON.stringify(entry);
        if (typeof entry === "number" || typeof entry === "boolean")
            return JSON.stringify(entry);
        if (Array.isArray(entry)) return `[${entry.map(visit).join(",")}]`;
        const object = entry as {
            readonly [key: string]: ReturnType<typeof serializeJson>;
        };
        return `{${Object.keys(object)
            .sort()
            .map(
                (key) => `${JSON.stringify(key)}:${visit(object[key] ?? null)}`,
            )
            .join(",")}}`;
    };
    return visit(serialized);
};

const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

const diagnosticIdentity = (
    diagnostic: PipelineDiagnostic,
    request: PipelineSnapshotRequest,
    source: SourceKind,
): string => {
    const provider = text(diagnostic.provider) ?? `github.${source}`;
    const raw = isRecord(diagnostic.rawValues) ? diagnostic.rawValues : {};
    const rawSha = [
        raw.commitSha,
        raw.commit_sha,
        raw.sha,
        raw.headSha,
        raw.head_sha,
    ]
        .map(sha)
        .find((value) => value !== undefined);
    const identity =
        source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE
            ? [
                  source,
                  provider,
                  request.commitSha.trim().toLowerCase(),
                  token(diagnostic.runId),
                  token(diagnostic.runAttempt),
                  token(diagnostic.workflowId),
              ]
            : [
                  source,
                  provider,
                  request.commitSha.trim().toLowerCase(),
                  token(diagnostic.checkRunId),
                  token(diagnostic.jobId),
                  token(diagnostic.runId),
                  token(diagnostic.runAttempt),
                  token(diagnostic.workflowId),
              ];
    return JSON.stringify([
        ...identity,
        rawSha === undefined ? null : rawSha.toLowerCase(),
    ]);
};

const recordIdentity = (
    record: CollectedRecord,
    source: SourceKind,
): string => {
    const value = record.value as Record<string, unknown>;
    return canonical({
        source,
        provider: value.provider,
        commitSha: value.commitSha,
        runId: value.runId,
        runAttempt: value.runAttempt,
        workflowId: value.workflowId,
        jobId: value.jobId,
        checkRunId: value.checkRunId,
        name: value.name,
        number: value.number,
        path: value.path,
        message: value.message,
    });
};

const diagnosticFromValue = (
    record: CollectedRecord,
): PipelineDiagnostic | undefined => {
    const value = record.value as Record<string, unknown>;
    return isRecord(value.diagnostic)
        ? (value.diagnostic as unknown as PipelineDiagnostic)
        : undefined;
};

const kindOrder = (record: CollectedRecord): number => {
    if (record.kind === "run" || record.kind === "check-run") return 0;
    if (record.kind === "job" || record.kind === "annotation") return 1;
    return 2;
};

const failingDiagnostic = (value: unknown): value is PipelineDiagnostic =>
    isRecord(value) &&
    (value.source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE ||
        value.source === CHECK_RUN_DIAGNOSTIC_SOURCE) &&
    value.disposition === "selected" &&
    isRecord(value.rawState) &&
    classifyPipelineState(value.rawState) === "failing";

const malformed = (message: string, evidence: unknown): DiagnosticError =>
    classifyDiagnosticError({
        source: PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE,
        message,
        evidence,
        disposition: "malformed",
    });

const requestFromSnapshot = (
    snapshot: unknown,
): PipelineSnapshotRequest | undefined => {
    if (!isRecord(snapshot)) return undefined;
    const repository = text(snapshot.repository);
    const branch = text(snapshot.branch);
    const commitSha = sha(snapshot.commitSha);
    if (
        repository === undefined ||
        branch === undefined ||
        commitSha === undefined
    )
        return undefined;
    return { repository, branch, commitSha };
};

const diagnosticsFromSnapshot = (
    snapshot: unknown,
): ReadonlyArray<PipelineDiagnostic> | undefined => {
    if (!isRecord(snapshot)) return undefined;
    if (Array.isArray(snapshot.diagnostics))
        return snapshot.diagnostics as ReadonlyArray<PipelineDiagnostic>;
    if (Array.isArray(snapshot.items))
        return snapshot.items.flatMap((item) =>
            isRecord(item) && isRecord(item.diagnostic)
                ? [item.diagnostic as unknown as PipelineDiagnostic]
                : [],
        );
    return undefined;
};

const sourceSnapshot = (
    input: PipelineDiagnosticsCollectorInput,
): PipelineSnapshot | undefined =>
    input.snapshot ?? input.observation?.snapshot;

const snapshotList = (
    input: PipelineDiagnosticsCollectorInput,
): ReadonlyArray<PipelineSnapshot> => {
    const values: PipelineSnapshot[] = [];
    if (input.snapshot !== undefined) values.push(input.snapshot);
    if (
        input.observation?.snapshot !== undefined &&
        input.observation.snapshot !== input.snapshot
    )
        values.push(input.observation.snapshot);
    return values;
};

const snapshotValidationErrors = (
    input: PipelineDiagnosticsCollectorInput,
    request: PipelineSnapshotRequest,
): ReadonlyArray<DiagnosticError> => {
    const errors: DiagnosticError[] = [];
    for (const snapshot of snapshotList(input)) {
        const error = validateSnapshot(snapshot, request);
        if (error !== undefined) errors.push(error);
    }
    return errors;
};

const observationValidationErrors = (
    input: PipelineDiagnosticsCollectorInput,
    request: PipelineSnapshotRequest,
): ReadonlyArray<DiagnosticError> => {
    const observation = input.observation;
    if (observation === undefined) return [];
    const errors: DiagnosticError[] = [];
    if (observation.kind !== "failed")
        errors.push(
            malformed(
                "pipeline diagnostics requires a failed pipeline observation.",
                { observation },
            ),
        );
    const observedSha = observationRequest(observation);
    const validSha =
        observedSha !== undefined &&
        EXACT_COMMIT_SHA.test(observedSha) &&
        sameRequestIdentity({ ...request, commitSha: observedSha }, request);
    if (!validSha)
        errors.push(
            malformed(
                "failed pipeline observation is missing or conflicts with the requested exact commit SHA.",
                { observation, request },
            ),
        );
    return errors;
};

const diagnosticShapeErrors = (
    diagnostics: ReadonlyArray<unknown>,
): ReadonlyArray<DiagnosticError> => {
    const errors: DiagnosticError[] = [];
    for (const diagnostic of diagnostics)
        if (!isRecord(diagnostic))
            errors.push(
                malformed(
                    "pipeline diagnostics contains a non-object diagnostic.",
                    { diagnostic },
                ),
            );
    return errors;
};

const missingSourceError = (
    input: PipelineDiagnosticsCollectorInput,
    snapshot: PipelineSnapshot | undefined,
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
    request: PipelineSnapshotRequest,
): DiagnosticError | undefined =>
    input.diagnostics === undefined &&
    snapshot === undefined &&
    diagnostics.length === 0
        ? malformed(
              "pipeline diagnostics requires a snapshot or supplied diagnostics; an absent source cannot be reported as a successful empty collection.",
              { request },
          )
        : undefined;

const diagnosticsForInput = (
    input: PipelineDiagnosticsCollectorInput,
    snapshot: PipelineSnapshot | undefined,
): ReadonlyArray<PipelineDiagnostic> =>
    input.diagnostics ?? diagnosticsFromSnapshot(snapshot) ?? [];

const validateRequest = (
    request: PipelineSnapshotRequest | undefined,
): DiagnosticError | undefined => {
    if (request === undefined)
        return malformed(
            "pipeline diagnostics request is missing repository, branch, and exact commit identity.",
            { request: null },
        );
    const repository = text(request.repository);
    const branch = text(request.branch);
    const commitSha = sha(request.commitSha);
    if (repository === undefined)
        return malformed(
            "pipeline diagnostics request is missing a repository.",
            {
                request,
            },
        );
    if (branch === undefined)
        return malformed("pipeline diagnostics request is missing a branch.", {
            request,
        });
    if (commitSha === undefined || !EXACT_COMMIT_SHA.test(commitSha))
        return malformed(
            "pipeline diagnostics request is missing an exact commit SHA.",
            { request },
        );
    try {
        parseRepositorySlug(repository);
    } catch {
        return malformed(
            "pipeline diagnostics request has an invalid repository.",
            {
                request,
            },
        );
    }
    return undefined;
};

const validateSnapshot = (
    snapshot: PipelineSnapshot,
    request: PipelineSnapshotRequest,
): DiagnosticError | undefined => {
    const snapshotRequest = requestFromSnapshot(snapshot);
    if (snapshotRequest === undefined)
        return malformed(
            "pipeline diagnostics snapshot is missing repository, branch, or exact commit identity.",
            { snapshot },
        );
    if (!sameRequestIdentity(snapshotRequest, request))
        return malformed(
            "pipeline diagnostics snapshot identity does not match the requested repository, branch, and exact commit SHA.",
            { request, snapshot },
        );
    if (diagnosticsFromSnapshot(snapshot) === undefined)
        return malformed(
            "pipeline diagnostics snapshot is missing its diagnostics collection.",
            { snapshot },
        );
    return undefined;
};

const observationRequest = (
    observation: FailedPipelineObservation | undefined,
): string | undefined => {
    if (observation === undefined) return undefined;
    return text(observation.observedSha);
};

const deduplicateDiagnostics = (
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
    source: SourceKind,
    request: PipelineSnapshotRequest,
): ReadonlyArray<PipelineDiagnostic> => {
    const seen = new Set<string>();
    const result: PipelineDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
        const key = diagnosticIdentity(diagnostic, request, source);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(diagnostic);
    }
    return result;
};

const resolveInput = (
    input: PipelineDiagnosticsCollectorInput,
): ResolvedCollectorInput => {
    const snapshot = sourceSnapshot(input);
    const derivedRequest = requestFromSnapshot(snapshot);
    const request = input.request ?? derivedRequest ?? FALLBACK_REQUEST;
    const requestError = validateRequest(input.request ?? derivedRequest);
    const diagnostics = diagnosticsForInput(input, snapshot);
    const missingError = missingSourceError(
        input,
        snapshot,
        diagnostics,
        request,
    );
    const errors = [
        ...(requestError === undefined ? [] : [requestError]),
        ...snapshotValidationErrors(input, request),
        ...observationValidationErrors(input, request),
        ...(missingError === undefined ? [] : [missingError]),
        ...diagnosticShapeErrors(diagnostics),
    ];

    const validDiagnostics = diagnostics.filter(
        isRecord,
    ) as ReadonlyArray<PipelineDiagnostic>;
    const workflowDiagnostics = deduplicateDiagnostics(
        validDiagnostics.filter(
            (diagnostic) =>
                failingDiagnostic(diagnostic) &&
                diagnostic.source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
        ),
        WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
        request,
    );
    const checkDiagnostics = deduplicateDiagnostics(
        validDiagnostics.filter(
            (diagnostic) =>
                failingDiagnostic(diagnostic) &&
                diagnostic.source === CHECK_RUN_DIAGNOSTIC_SOURCE,
        ),
        CHECK_RUN_DIAGNOSTIC_SOURCE,
        request,
    );
    return {
        request,
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(input.observation === undefined
            ? {}
            : { observation: input.observation }),
        diagnostics: validDiagnostics,
        workflowDiagnostics,
        checkDiagnostics,
        errors,
    };
};

const isWorkflowService = (
    value: unknown,
): value is WorkflowRunDiagnosticsService =>
    isRecord(value) && typeof value.collect === "function";

const isCheckService = (value: unknown): value is CheckRunDiagnosticsService =>
    isRecord(value) && typeof value.collect === "function";

const childRequest = (
    dependencies: { readonly request?: PipelineSnapshotRequestExecutor },
    signal: AbortSignal | undefined,
): PipelineSnapshotRequestExecutor | undefined => {
    const base =
        dependencies.request ??
        (async (endpoint, parameters, requestSignal) =>
            endpoint({
                ...parameters,
                ...(requestSignal === undefined
                    ? {}
                    : { request: { signal: requestSignal } }),
            }));
    if (signal === undefined) return dependencies.request;
    return (endpoint, parameters) => {
        if (signal.aborted)
            return Promise.reject(
                signal.reason ??
                    new Error("Pipeline diagnostics read aborted."),
            );
        return base(endpoint, parameters, signal);
    };
};

const workflowDependencies = (
    dependencies: PipelineDiagnosticsCollectorDependencies,
    signal: AbortSignal | undefined,
): WorkflowRunDiagnosticsDependencies => {
    const merged = {
        ...(dependencies.client === undefined
            ? {}
            : { client: dependencies.client }),
        ...(dependencies.request === undefined
            ? {}
            : { request: dependencies.request }),
        ...(isWorkflowService(dependencies.jobs)
            ? {}
            : (dependencies.jobs ?? {})),
    } as WorkflowRunDiagnosticsDependencies;
    const request = childRequest(merged, signal);
    return request === undefined ? merged : { ...merged, request };
};

const checkDependencies = (
    dependencies: PipelineDiagnosticsCollectorDependencies,
    signal: AbortSignal | undefined,
): CheckRunDiagnosticsDependencies => {
    const merged = {
        ...(dependencies.client === undefined
            ? {}
            : { client: dependencies.client }),
        ...(dependencies.request === undefined
            ? {}
            : { request: dependencies.request }),
        ...(isCheckService(dependencies.checks)
            ? {}
            : (dependencies.checks ?? {})),
    } as CheckRunDiagnosticsDependencies;
    const request = childRequest(merged, signal);
    return request === undefined ? merged : { ...merged, request };
};

const workflowServiceFor = (
    dependencies: PipelineDiagnosticsCollectorDependencies,
    signal: AbortSignal | undefined,
): WorkflowRunDiagnosticsService => {
    if (isWorkflowService(dependencies.jobs)) return dependencies.jobs;
    return makeWorkflowRunDiagnosticsService(
        workflowDependencies(dependencies, signal),
    );
};

const checkServiceFor = (
    dependencies: PipelineDiagnosticsCollectorDependencies,
    signal: AbortSignal | undefined,
): CheckRunDiagnosticsService => {
    if (isCheckService(dependencies.checks)) return dependencies.checks;
    return makeCheckRunDiagnosticsService(
        checkDependencies(dependencies, signal),
    );
};

const emptyChildResult = (
    request: PipelineSnapshotRequest,
    source: SourceKind,
    errors: ReadonlyArray<DiagnosticError>,
    snapshot?: PipelineSnapshot,
    observation?: FailedPipelineObservation,
): CollectionResult =>
    ({
        request,
        source,
        records: [],
        truncated: false,
        errors,
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(observation === undefined ? {} : { observation }),
    }) as unknown as CollectionResult;

const collectChild = async (
    source: SourceKind,
    input: WorkflowRunDiagnosticsInput | CheckRunDiagnosticsInput,
    dependencies: PipelineDiagnosticsCollectorDependencies,
    signal: AbortSignal | undefined,
): Promise<CollectionResult> => {
    try {
        if (source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE) {
            const service = workflowServiceFor(dependencies, signal);
            return await service.collect(input as WorkflowRunDiagnosticsInput);
        }
        const service = checkServiceFor(dependencies, signal);
        return await service.collect(input as CheckRunDiagnosticsInput);
    } catch (cause) {
        const error = classifyDiagnosticError({
            source:
                source === WORKFLOW_RUN_DIAGNOSTIC_SOURCE
                    ? "github.workflow-run.jobs"
                    : CHECK_RUN_GET_SOURCE,
            message: `${source} diagnostics collection failed.`,
            cause,
            evidence: { request: input.request },
        });
        return emptyChildResult(
            input.request,
            source,
            [error],
            input.snapshot,
            input.observation,
        );
    }
};

const rankedRecords = (
    source: SourceKind,
    result: CollectionResult,
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
    request: PipelineSnapshotRequest,
): ReadonlyArray<RankedRecord> => {
    const order = new Map<string, number>();
    diagnostics.forEach((diagnostic, index) =>
        order.set(diagnosticIdentity(diagnostic, request, source), index),
    );
    let activeDiagnostic: PipelineDiagnostic | undefined;
    return result.records.map((record, originalOrder) => {
        const direct = diagnosticFromValue(record);
        if (direct !== undefined) activeDiagnostic = direct;
        else if (
            source === CHECK_RUN_DIAGNOSTIC_SOURCE &&
            record.kind !== "annotation"
        )
            activeDiagnostic = undefined;
        const diagnostic = direct ?? activeDiagnostic;
        const diagnosticOrder =
            diagnostic === undefined
                ? diagnostics.length
                : (order.get(diagnosticIdentity(diagnostic, request, source)) ??
                  diagnostics.length);
        return {
            record,
            source,
            diagnosticOrder,
            identity: recordIdentity(record, source),
            kindOrder: kindOrder(record),
            originalOrder,
        };
    });
};

const sortRankedRecords = (
    records: ReadonlyArray<RankedRecord>,
): ReadonlyArray<CollectedRecord> =>
    records
        .slice()
        .sort((left, right) => {
            const diagnostic = left.diagnosticOrder - right.diagnosticOrder;
            if (diagnostic !== 0) return diagnostic;
            const kind = left.kindOrder - right.kindOrder;
            if (kind !== 0) return kind;
            const identity = compareText(left.identity, right.identity);
            if (identity !== 0) return identity;
            return left.originalOrder - right.originalOrder;
        })
        .map(({ record }) => record);

const errorIdentity = (error: DiagnosticError): string => {
    const raw = error.rawValues;
    if (!isRecord(raw)) return "";
    return canonical({
        provider: raw.provider,
        commitSha: raw.commitSha ?? raw.commit_sha ?? raw.sha ?? raw.head_sha,
        runId: raw.runId ?? raw.run_id,
        runAttempt: raw.runAttempt ?? raw.run_attempt,
        workflowId: raw.workflowId ?? raw.workflow_id,
        checkRunId: raw.checkRunId ?? raw.check_run_id ?? raw.id,
        jobId: raw.jobId ?? raw.job_id,
    });
};

const sortedErrors = (
    errors: ReadonlyArray<DiagnosticError>,
): ReadonlyArray<DiagnosticError> =>
    errors
        .map((error, index) => ({
            error,
            index,
            key: JSON.stringify([
                error.source,
                errorIdentity(error),
                error.message,
                canonical(error.rawValues),
                error.disposition,
            ]),
        }))
        .sort((left, right) => {
            const comparison = compareText(left.key, right.key);
            return comparison === 0 ? left.index - right.index : comparison;
        })
        .map(({ error }) => error);

const sortedRecordErrors = (record: CollectedRecord): CollectedRecord => {
    if (record.errors === undefined || record.errors.length < 2) return record;
    return {
        ...record,
        errors: sortedErrors(record.errors),
    } as CollectedRecord;
};

const aggregateDisposition = (
    errors: ReadonlyArray<DiagnosticError>,
    records: ReadonlyArray<CollectedRecord>,
    truncated: boolean,
): DiagnosticRecordDisposition => {
    if (
        truncated ||
        errors.some(({ disposition }) => disposition === "truncated") ||
        records.some(({ disposition }) => disposition === "truncated")
    )
        return "truncated";
    const priority: ReadonlyArray<DiagnosticRecordDisposition> = [
        "rate-limited",
        "unavailable",
        "malformed",
    ];
    return (
        priority.find(
            (disposition) =>
                errors.some((error) => error.disposition === disposition) ||
                records.some((record) => record.disposition === disposition),
        ) ?? "ok"
    );
};

const aggregate = (
    input: ResolvedCollectorInput,
    jobs: CollectionResult,
    checks: CollectionResult,
): PipelineDiagnosticsCollectionResult => {
    const records = sortRankedRecords([
        ...rankedRecords(
            WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
            jobs,
            input.diagnostics,
            input.request,
        ),
        ...rankedRecords(
            CHECK_RUN_DIAGNOSTIC_SOURCE,
            checks,
            input.diagnostics,
            input.request,
        ),
    ]).map(sortedRecordErrors);
    const errors = sortedErrors([
        ...input.errors,
        ...jobs.errors,
        ...checks.errors,
    ]);
    const truncated =
        jobs.truncated ||
        checks.truncated ||
        errors.some((error) => error.disposition === "truncated") ||
        records.some((record) => record.disposition === "truncated");
    const disposition = aggregateDisposition(errors, records, truncated);
    return {
        request: input.request,
        source: PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE,
        records,
        disposition,
        truncated,
        errors,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        ...(input.observation === undefined
            ? {}
            : { observation: input.observation }),
        jobs,
        checks,
    };
};

/** Collect and deterministically assemble bounded diagnostics for a failure. */
export const collectPipelineDiagnostics = async (
    input: PipelineDiagnosticsCollectorInput,
    dependencies: PipelineDiagnosticsCollectorDependencies = {},
): Promise<PipelineDiagnosticsCollectionResult> => {
    if (input.signal?.aborted)
        throw (
            input.signal.reason ??
            new Error("Pipeline diagnostics read aborted.")
        );
    const resolved = resolveInput(input);
    if (resolved.errors.length > 0) {
        const jobs = emptyChildResult(
            resolved.request,
            WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
            resolved.errors,
            resolved.snapshot,
            resolved.observation,
        );
        const checks = emptyChildResult(
            resolved.request,
            CHECK_RUN_DIAGNOSTIC_SOURCE,
            resolved.errors,
            resolved.snapshot,
            resolved.observation,
        );
        return aggregate(resolved, jobs, checks);
    }

    const workflowInput: WorkflowRunDiagnosticsInput = {
        request: resolved.request,
        diagnostics: resolved.workflowDiagnostics,
        ...(resolved.snapshot === undefined
            ? {}
            : { snapshot: resolved.snapshot }),
        ...(resolved.observation === undefined
            ? {}
            : { observation: resolved.observation }),
    };
    const checkInput: CheckRunDiagnosticsInput = {
        request: resolved.request,
        diagnostics: resolved.checkDiagnostics,
        ...(resolved.snapshot === undefined
            ? {}
            : { snapshot: resolved.snapshot }),
        ...(resolved.observation === undefined
            ? {}
            : { observation: resolved.observation }),
    };

    const jobs = await collectChild(
        WORKFLOW_RUN_DIAGNOSTIC_SOURCE,
        workflowInput,
        dependencies,
        input.signal,
    );
    if (input.signal?.aborted)
        throw (
            input.signal.reason ??
            new Error("Pipeline diagnostics read aborted.")
        );
    const checks = await collectChild(
        CHECK_RUN_DIAGNOSTIC_SOURCE,
        checkInput,
        dependencies,
        input.signal,
    );
    if (input.signal?.aborted)
        throw (
            input.signal.reason ??
            new Error("Pipeline diagnostics read aborted.")
        );
    return aggregate(resolved, jobs, checks);
};

/** Factory for the composed diagnostics service. */
export const makePipelineDiagnosticsService = (
    dependencies: PipelineDiagnosticsCollectorDependencies = {},
): PipelineDiagnosticsCollectorService => {
    const collect = (input: PipelineDiagnosticsCollectorInput) =>
        collectPipelineDiagnostics(input, dependencies);
    return { collect };
};