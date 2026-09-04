/**
 * Bounded failing check-run diagnostics for GitHub Actions.
 *
 * This module collects the failing check-run half of the pipeline
 * diagnostics collector: for each failing `check-run` diagnostic carrying a
 * check-run identity it inspects the check run and its annotations through
 * the injected `checks.get` and paginated `checks.listAnnotations`
 * endpoints, using only repository and check-run IDs. A check-run diagnostic
 * may also carry run, attempt, job, or workflow metadata; those fields stay
 * check metadata and never route to the workflow-run jobs endpoint, and no
 * URL-like field found in any payload is ever parsed into a request.
 *
 * Every endpoint response is validated against its expected envelope and the
 * requested check-run identity (the exact commit SHA compared lowercased,
 * never truncated or aliased). A response carrying only an ID, or an object
 * or array in the wrong envelope, is malformed and never replaces the
 * snapshot diagnostic's status/conclusion or raw values with an empty
 * object. When one endpoint fails, the other bounded evidence is retained
 * and an explicit non-ok disposition/error is emitted.
 *
 * Output (summary, text, and unknown JSON fields) is captured under the
 * aggregate `MAX_CHECK_OUTPUT_CHARS` character budget, which counts
 * serialized property names, values, and JSON structure. Annotations are
 * bounded by count, pagination page cap, per-record raw bound, and the final
 * raw representation bound. Any omitted output, annotations, keys, or
 * unknown fields carry an explicit truncation marker and a "truncated"
 * disposition; a result is never ok with silently incomplete evidence, and
 * non-object or otherwise malformed output cannot bypass the budget by
 * passing through unchanged into `rawValues`.
 */
import type { Octokit } from "octokit";

import {
    MIN_EVIDENCE_BUDGET,
    TRUNCATION_MARKER_KEY,
    budgetEvidence,
    budgetRawEvidence,
} from "./evidence-budget.ts";
import {
    classifyDiagnosticError,
    type DiagnosticFailureDisposition,
} from "./pipeline-diagnostics-errors.ts";
import {
    MAX_CHECK_ANNOTATIONS,
    MAX_CHECK_OUTPUT_CHARS,
    MAX_PAGINATION_PAGES,
    type AnnotationRecord,
    type CollectedRecord,
    type CollectionResult,
    type DiagnosticError,
    type DiagnosticRecordDisposition,
    type ExactCommitSha,
    type JsonObject,
    type JsonValue,
    type PipelineDiagnostic,
    type PipelineIdentifier,
    type PipelineRawState,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "./pipeline-diagnostics-contracts.ts";
import {
    paginateAnnotations,
    type Endpoint,
    type PaginationResult,
} from "./pipeline-diagnostics-pagination.ts";
import type { FailedPipelineObservation } from "./pipeline-observation.ts";
import { classifyPipelineState, serializeJson } from "./pipeline-snapshot.ts";
import type { PipelineSnapshotRequestExecutor } from "./pipeline-snapshot-collector.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Source label used for the check-run branch of diagnostics. */
export const CHECK_RUN_DIAGNOSTIC_SOURCE = "check-run" as const;

/** Source label used for the check-get endpoint and its failures. */
export const CHECK_RUN_GET_SOURCE = "github.check-run.get" as const;

/** Source label used for the check annotations endpoint and its failures. */
export const CHECK_RUN_ANNOTATIONS_SOURCE =
    "github.check-run.annotations" as const;

const DEFAULT_PROVIDER = "github.check-run";
const PAGE_SIZE = 100;

/** Input to the failing check-run diagnostics collector. */
export type CheckRunDiagnosticsInput = {
    readonly request: PipelineSnapshotRequest;
    /** Diagnostics to inspect; snapshot/observation are fallback sources. */
    readonly diagnostics?: ReadonlyArray<PipelineDiagnostic>;
    /** Snapshot carrying selected, normalized diagnostics. */
    readonly snapshot?: PipelineSnapshot;
    /** Failed observation whose snapshot and identity should be retained. */
    readonly observation?: FailedPipelineObservation;
};

/** Injectable dependencies and test-only tighter bounds. */
export type CheckRunDiagnosticsDependencies = {
    /** Explicit `checks.get` endpoint. */
    readonly getCheck?: Endpoint;
    /** Explicit `checks.listAnnotations` endpoint. */
    readonly listAnnotations?: Endpoint;
    /** Octokit client used only to discover the allowlisted checks endpoints. */
    readonly client?: Octokit;
    /** Optional request executor used for every endpoint call. */
    readonly request?: PipelineSnapshotRequestExecutor;
    /** Page size used by the bounded annotation requests (at most 100). */
    readonly perPage?: number;
    /** Maximum annotation pages; never allowed to exceed MAX_PAGINATION_PAGES. */
    readonly maxPages?: number;
    /** Maximum annotations; never allowed to exceed MAX_CHECK_ANNOTATIONS. */
    readonly maxAnnotations?: number;
    /** Maximum output characters; never allowed to exceed MAX_CHECK_OUTPUT_CHARS. */
    readonly maxOutputChars?: number;
};

/** Service shape matching the repository's explicit read-only services. */
export type CheckRunDiagnosticsService = {
    readonly collect: (
        input: CheckRunDiagnosticsInput,
    ) => Promise<CollectionResult>;
    readonly read: (
        input: CheckRunDiagnosticsInput,
    ) => Promise<CollectionResult>;
};

/**
 * Collected context for one failing check run. Retains the provider, the
 * exact requested commit SHA (compared lowercased, never truncated), the
 * check-run ID, optional job/run/workflow identity carried by the
 * diagnostic, the merged raw state, the full diagnostic raw fields, the
 * bounded output evidence, and the bounded annotation records in addition to
 * the check-run API fields. `rawValues` is always the budget-bounded final
 * raw representation.
 */
export type CollectedCheckContext = JsonObject & {
    readonly provider: string;
    readonly commitSha: ExactCommitSha;
    readonly checkRunId: PipelineIdentifier;
    readonly name?: string;
    readonly jobId?: PipelineIdentifier;
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
    readonly rawState: PipelineRawState;
    readonly diagnostic: PipelineDiagnostic;
    readonly rawValues: JsonValue;
    readonly output?: JsonValue;
    readonly annotations: ReadonlyArray<AnnotationRecord>;
    readonly annotationsTruncated: boolean;
};

type CheckIdentity = {
    readonly provider: string;
    readonly commitSha: string;
    readonly checkRunId: PipelineIdentifier;
    readonly jobId?: PipelineIdentifier;
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
};

type CheckWork = {
    readonly identity: CheckIdentity;
    readonly diagnostic: PipelineDiagnostic;
};

type Work = CheckWork | { readonly error: DiagnosticError };

type CollectionState = {
    readonly records: CollectedRecord[];
    readonly errors: DiagnosticError[];
    truncated: boolean;
};

type RequestTrace = {
    cause?: unknown;
    response?: unknown;
};

type Transport = {
    readonly owner: string;
    readonly repo: string;
    readonly getCheck: Endpoint | undefined;
    readonly listAnnotations: Endpoint | undefined;
    readonly baseRequest: PipelineSnapshotRequestExecutor;
    readonly perPage: number;
    readonly maxPages: number;
    readonly maxAnnotations: number;
    readonly maxOutputChars: number;
};

type ParsedAnnotation =
    | { readonly kind: "valid"; readonly record: AnnotationRecord }
    | { readonly kind: "invalid"; readonly error: DiagnosticError };

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

const firstDefined = <T>(
    ...values: ReadonlyArray<T | undefined>
): T | undefined => values.find((value) => value !== undefined);

/** State fields prefer the API payload and fall back to the diagnostic. */
const mergedState = (
    primary: PipelineRawState,
    fallback: PipelineRawState,
): PipelineRawState => {
    const status = firstDefined(primary.status, fallback.status);
    const state = firstDefined(primary.state, fallback.state);
    const conclusion = firstDefined(primary.conclusion, fallback.conclusion);
    return {
        ...(status === undefined ? {} : { status }),
        ...(state === undefined ? {} : { state }),
        ...(conclusion === undefined ? {} : { conclusion }),
    };
};

const rawDiagnosticSha = (diagnostic: PipelineDiagnostic): string | undefined =>
    shaAt(diagnostic.rawValues, [
        "commitSha",
        "commit_sha",
        "sha",
        "headSha",
        "head_sha",
    ]);

const unwrapData = (value: unknown): unknown =>
    isRecord(value) && hasOwn(value, "data") ? value.data : value;

const diagnosticErrorFor = (
    source: string,
    message: string,
    evidence: unknown,
    cause?: unknown,
    disposition?: DiagnosticFailureDisposition,
): DiagnosticError =>
    classifyDiagnosticError({
        source,
        message,
        evidence,
        ...(cause === undefined ? {} : { cause }),
        ...(disposition === undefined ? {} : { disposition }),
    });

const diagnosticCandidates = (
    input: CheckRunDiagnosticsInput,
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
    diagnostic.source === CHECK_RUN_DIAGNOSTIC_SOURCE &&
    classifyPipelineState(diagnostic.rawState) === "failing";

const identityKey = (identity: CheckIdentity): string =>
    JSON.stringify([
        identity.provider,
        identity.commitSha.trim().toLowerCase(),
        identifierToken(identity.checkRunId),
    ]);

const optionalMetadataError = (
    diagnostic: PipelineDiagnostic,
): DiagnosticError | undefined => {
    const metadata: ReadonlyArray<
        readonly [string, PipelineIdentifier | undefined]
    > = [
        ["run ID", diagnostic.runId],
        ["run attempt", diagnostic.runAttempt],
        ["job ID", diagnostic.jobId],
        ["workflow ID", diagnostic.workflowId],
    ];
    for (const [label, value] of metadata) {
        if (value !== undefined && identifier(value) === undefined)
            return diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                `check-run diagnostic contains a malformed ${label}.`,
                { diagnostic },
                undefined,
                "malformed",
            );
    }
    return undefined;
};

const workForDiagnostic = (
    diagnostic: PipelineDiagnostic,
    request: PipelineSnapshotRequest,
): Work => {
    const provider = diagnostic.provider?.trim() || DEFAULT_PROVIDER;
    const checkRunId = diagnostic.checkRunId;
    if (checkRunId === undefined || identifier(checkRunId) === undefined)
        return {
            error: diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run diagnostic is missing a usable check-run ID.",
                { diagnostic },
                undefined,
                "malformed",
            ),
        };
    const commitSha = shaValue(request.commitSha);
    if (commitSha === undefined)
        return {
            error: diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run request is missing an exact commit SHA.",
                { diagnostic, request },
                undefined,
                "malformed",
            ),
        };
    const diagnosticSha = rawDiagnosticSha(diagnostic);
    if (diagnosticSha !== undefined && !sameSha(diagnosticSha, commitSha))
        return {
            error: diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run diagnostic commit SHA conflicts with the requested exact SHA.",
                { diagnostic, requestedSha: commitSha },
                undefined,
                "malformed",
            ),
        };
    const metadataError = optionalMetadataError(diagnostic);
    if (metadataError !== undefined) return { error: metadataError };
    return {
        identity: {
            provider,
            commitSha,
            checkRunId,
            ...(diagnostic.jobId === undefined
                ? {}
                : { jobId: diagnostic.jobId }),
            ...(diagnostic.runId === undefined
                ? {}
                : { runId: diagnostic.runId }),
            ...(diagnostic.runAttempt === undefined
                ? {}
                : { runAttempt: diagnostic.runAttempt }),
            ...(diagnostic.workflowId === undefined
                ? {}
                : { workflowId: diagnostic.workflowId }),
        },
        diagnostic,
    };
};

const workForInput = (
    input: CheckRunDiagnosticsInput,
): {
    readonly work: ReadonlyArray<CheckWork>;
    readonly errors: DiagnosticError[];
} => {
    const work: CheckWork[] = [];
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

const CHECK_IDENTITY_KEYS: ReadonlyArray<string> = [
    "id",
    "check_run_id",
    "checkRunId",
];
const CHECK_SHA_KEYS: ReadonlyArray<string> = ["head_sha", "headSha"];

type ParsedCheck =
    | { readonly kind: "valid"; readonly check: Record<string, unknown> }
    | { readonly kind: "invalid"; readonly error: DiagnosticError };

/**
 * Validate one check-get response. The expected envelope is an object (after
 * unwrapping exactly one Octokit `data` level) whose check-run ID matches
 * the requested identity and whose head SHA matches the requested exact
 * commit SHA lowercased. A response carrying only an ID, or an object/array
 * in the wrong envelope, is malformed and never becomes a collected check.
 */
const parseCheckResponse = (
    response: unknown,
    work: CheckWork,
): ParsedCheck => {
    const invalid = (message: string): ParsedCheck => ({
        kind: "invalid",
        error: diagnosticErrorFor(
            CHECK_RUN_GET_SOURCE,
            message,
            { response, diagnostic: work.diagnostic },
            undefined,
            "malformed",
        ),
    });
    const unwrapped = unwrapData(response);
    if (!isRecord(unwrapped))
        return invalid(
            "check-run response did not contain the expected check-run object.",
        );
    const checkRunId = identifierAt(unwrapped, CHECK_IDENTITY_KEYS);
    if (
        checkRunId === undefined ||
        !sameIdentifier(checkRunId, work.identity.checkRunId)
    )
        return invalid(
            "check-run response check-run ID does not match the requested identity and was omitted.",
        );
    const headSha = shaAt(unwrapped, CHECK_SHA_KEYS);
    if (headSha === undefined || !sameSha(headSha, work.identity.commitSha))
        return invalid(
            "check-run response head SHA does not match the requested exact SHA and was omitted.",
        );
    if (
        Object.keys(unwrapped).every((key) => CHECK_IDENTITY_KEYS.includes(key))
    )
        return invalid(
            "check-run response carries only a check-run ID and no other evidence.",
        );
    return { kind: "valid", check: unwrapped };
};

const collectCheckGet = async (
    work: CheckWork,
    transport: Transport,
    state: CollectionState,
): Promise<Record<string, unknown> | undefined> => {
    if (typeof transport.getCheck !== "function") {
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run get endpoint is not callable.",
                { checkRunId: work.identity.checkRunId },
                undefined,
                "unavailable",
            ),
        );
        return undefined;
    }
    const trace: RequestTrace = {};
    try {
        const response = await tracedRequest(transport.baseRequest, trace)(
            transport.getCheck,
            {
                owner: transport.owner,
                repo: transport.repo,
                check_run_id: work.identity.checkRunId,
            },
            undefined,
        );
        const parsed = parseCheckResponse(response, work);
        if (parsed.kind === "invalid") {
            state.errors.push(parsed.error);
            return undefined;
        }
        return parsed.check;
    } catch (cause) {
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run get request failed.",
                {
                    checkRunId: work.identity.checkRunId,
                    ...(trace.response === undefined
                        ? {}
                        : { response: trace.response }),
                    ...(trace.cause === undefined
                        ? {}
                        : { cause: trace.cause }),
                },
                cause,
            ),
        );
        return undefined;
    }
};

const annotationRecordFor = (raw: JsonValue): ParsedAnnotation => {
    const invalid = (rawAnnotation: unknown): ParsedAnnotation => ({
        kind: "invalid",
        error: diagnosticErrorFor(
            CHECK_RUN_ANNOTATIONS_SOURCE,
            "check-run annotation is not a JSON object.",
            { annotation: rawAnnotation },
            undefined,
            "malformed",
        ),
    });
    const serialized = serializeJson(raw);
    if (!isRecord(serialized)) return invalid(raw);
    const normalized = Object.assign({}, serialized, {
        ...(hasOwn(serialized, "start_line")
            ? { startLine: serialized.start_line }
            : {}),
        ...(hasOwn(serialized, "start_column")
            ? { startColumn: serialized.start_column }
            : {}),
        ...(hasOwn(serialized, "end_line")
            ? { endLine: serialized.end_line }
            : {}),
        ...(hasOwn(serialized, "end_column")
            ? { endColumn: serialized.end_column }
            : {}),
    });
    const budgeted = budgetRawEvidence(normalized);
    const record = budgeted.value;
    if (!isRecord(record)) return invalid(raw);
    return { kind: "valid", record: record as AnnotationRecord };
};

const paginationErrorFor = (
    pagination: PaginationResult,
    trace: RequestTrace,
    source: string,
): DiagnosticError | undefined => {
    if (pagination.error === undefined) return undefined;
    const explicit =
        pagination.error.disposition === "malformed"
            ? ("malformed" as const)
            : trace.cause === undefined
              ? ("unavailable" as const)
              : undefined;
    return diagnosticErrorFor(
        source,
        pagination.error.message,
        {
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
    source: string,
): DiagnosticError | undefined =>
    pagination.disposition !== "truncated"
        ? undefined
        : diagnosticErrorFor(
              source,
              `check-run annotations collection was truncated after ${String(pagination.records.length)} retained annotations.`,
              {
                  records: pagination.records,
                  truncation: pagination.truncation,
              },
              undefined,
              "truncated",
          );

const collectAnnotations = async (
    work: CheckWork,
    transport: Transport,
    state: CollectionState,
): Promise<{
    readonly annotations: AnnotationRecord[];
    readonly truncated: boolean;
}> => {
    if (typeof transport.listAnnotations !== "function") {
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_ANNOTATIONS_SOURCE,
                "check-run annotations endpoint is not callable.",
                { checkRunId: work.identity.checkRunId },
                undefined,
                "unavailable",
            ),
        );
        return { annotations: [], truncated: false };
    }
    const trace: RequestTrace = {};
    const pagination = await paginateAnnotations({
        source: CHECK_RUN_ANNOTATIONS_SOURCE,
        endpoint: transport.listAnnotations,
        parameters: {
            owner: transport.owner,
            repo: transport.repo,
            check_run_id: work.identity.checkRunId,
            per_page: transport.perPage,
        },
        perPage: transport.perPage,
        maxPages: transport.maxPages,
        maxItems: transport.maxAnnotations,
        request: tracedRequest(transport.baseRequest, trace),
    });
    const paginationError = paginationErrorFor(
        pagination,
        trace,
        CHECK_RUN_ANNOTATIONS_SOURCE,
    );
    if (paginationError !== undefined) state.errors.push(paginationError);
    const truncationError = paginationTruncationError(
        pagination,
        CHECK_RUN_ANNOTATIONS_SOURCE,
    );
    if (truncationError !== undefined) state.errors.push(truncationError);
    let truncated = pagination.disposition === "truncated";
    const annotations: AnnotationRecord[] = [];
    for (const rawAnnotation of pagination.records) {
        const parsed = annotationRecordFor(rawAnnotation);
        if (parsed.kind === "invalid") {
            state.errors.push(parsed.error);
            truncated = true;
            continue;
        }
        const record = parsed.record;
        const recordTruncated = containsTruncationMarker(serializeJson(record));
        if (recordTruncated) {
            truncated = true;
            state.errors.push(
                diagnosticErrorFor(
                    CHECK_RUN_ANNOTATIONS_SOURCE,
                    "check-run annotation raw evidence was truncated.",
                    { annotation: record },
                    undefined,
                    "truncated",
                ),
            );
        }
        annotations.push(record);
        state.records.push(
            recordError(
                "annotation",
                record,
                recordTruncated ? "truncated" : "ok",
                [],
            ),
        );
    }
    return { annotations, truncated };
};

type OutputCapture = {
    readonly value: JsonValue | undefined;
    readonly truncated: boolean;
    readonly malformed: boolean;
};

/**
 * Bound one raw output value under the aggregate output budget. The budget
 * covers serialized property names, values, and JSON structure; a
 * non-object output is reported malformed and is still bounded so it can
 * never pass through unchanged into `rawValues`.
 */
const captureOutput = (
    rawOutput: unknown,
    maxOutputChars: number,
): OutputCapture => {
    if (rawOutput === undefined)
        return { value: undefined, truncated: false, malformed: false };
    const serialized = serializeJson(rawOutput);
    const budget = Math.max(MIN_EVIDENCE_BUDGET, maxOutputChars);
    const result = budgetEvidence(serialized, budget);
    return {
        value: result.value,
        truncated: result.disposition === "truncated",
        malformed: !isRecord(serialized),
    };
};

const tracedRequest =
    (base: PipelineSnapshotRequestExecutor, trace: RequestTrace) =>
    async (
        endpoint: Endpoint,
        parameters: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown> => {
        try {
            const response = await base(endpoint, parameters, signal);
            trace.response = response;
            return response;
        } catch (cause) {
            trace.cause = cause;
            throw cause;
        }
    };

const requestDirectly: PipelineSnapshotRequestExecutor = async (
    endpoint,
    parameters,
    signal,
) =>
    (endpoint as Endpoint)({
        ...parameters,
        ...(signal === undefined ? {} : { request: { signal } }),
    });

const clientChecks = (
    dependencies: CheckRunDiagnosticsDependencies,
):
    | {
          readonly get?: unknown;
          readonly listAnnotations?: unknown;
      }
    | undefined => {
    if (dependencies.client === undefined) return undefined;
    return (
        dependencies.client as unknown as {
            readonly rest?: { readonly checks?: unknown };
        }
    ).rest?.checks as
        | { readonly get?: unknown; readonly listAnnotations?: unknown }
        | undefined;
};

const getCheckEndpointFor = (
    dependencies: CheckRunDiagnosticsDependencies,
): Endpoint | undefined =>
    dependencies.getCheck ??
    ((clientChecks(dependencies)?.get ?? undefined) as Endpoint | undefined);

const listAnnotationsEndpointFor = (
    dependencies: CheckRunDiagnosticsDependencies,
): Endpoint | undefined =>
    dependencies.listAnnotations ??
    ((clientChecks(dependencies)?.listAnnotations ?? undefined) as
        | Endpoint
        | undefined);

const boundedLimit = (value: number | undefined, maximum: number): number => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
            `diagnostics limit must be a positive safe integer; received ${String(value)}.`,
        );
    return Math.min(value, maximum);
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

const transportFor = (
    dependencies: CheckRunDiagnosticsDependencies,
    repository: string,
): Transport => {
    const { owner, name: repo } = parseRepositorySlug(repository);
    return {
        owner,
        repo,
        getCheck: getCheckEndpointFor(dependencies),
        listAnnotations: listAnnotationsEndpointFor(dependencies),
        baseRequest: dependencies.request ?? requestDirectly,
        perPage: boundedLimit(dependencies.perPage, PAGE_SIZE),
        maxPages: boundedLimit(dependencies.maxPages, MAX_PAGINATION_PAGES),
        maxAnnotations: boundedLimit(
            dependencies.maxAnnotations,
            MAX_CHECK_ANNOTATIONS,
        ),
        maxOutputChars: boundedLimit(
            dependencies.maxOutputChars,
            MAX_CHECK_OUTPUT_CHARS,
        ),
    };
};

type OutputOutcome = {
    readonly output: JsonValue | undefined;
    readonly truncated: boolean;
};

const collectOutput = (
    check: Record<string, unknown> | undefined,
    maxOutputChars: number,
    state: CollectionState,
): OutputOutcome => {
    if (check === undefined) return { output: undefined, truncated: false };
    const capture = captureOutput(check.output, maxOutputChars);
    if (capture.malformed)
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run output is not a JSON object.",
                { output: capture.value },
                undefined,
                "malformed",
            ),
        );
    if (capture.truncated)
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                `check-run output was truncated to fit the ${String(maxOutputChars)}-character output budget.`,
                { output: capture.value },
                undefined,
                "truncated",
            ),
        );
    return { output: capture.value, truncated: capture.truncated };
};

type CheckValueParts = {
    readonly work: CheckWork;
    readonly check: Record<string, unknown> | undefined;
    readonly output: JsonValue | undefined;
    readonly annotations: ReadonlyArray<AnnotationRecord>;
    readonly annotationsTruncated: boolean;
};

/**
 * Assemble the collected check context. Known identity fields are
 * normalized, the API payload's remaining fields are preserved as unknown
 * metadata, and the final raw representation is evidence-budgeted; output
 * and annotations retain their own bounded forms at the top level.
 */
const buildCheckValue = (parts: CheckValueParts): CollectedCheckContext => {
    const { work, check, output, annotations, annotationsTruncated } = parts;
    const rawState = mergedState(
        check === undefined ? {} : rawStateFor(check),
        work.diagnostic.rawState,
    );
    const name =
        check !== undefined &&
        typeof check.name === "string" &&
        check.name.trim().length > 0
            ? check.name
            : work.diagnostic.name;
    const metadata: Record<string, unknown> = {
        provider: work.identity.provider,
        commitSha: work.identity.commitSha,
        checkRunId: work.identity.checkRunId,
        ...(name === undefined ? {} : { name }),
        ...(work.identity.jobId === undefined
            ? {}
            : { jobId: work.identity.jobId }),
        ...(work.identity.runId === undefined
            ? {}
            : { runId: work.identity.runId }),
        ...(work.identity.runAttempt === undefined
            ? {}
            : { runAttempt: work.identity.runAttempt }),
        ...(work.identity.workflowId === undefined
            ? {}
            : { workflowId: work.identity.workflowId }),
        rawState,
        diagnostic: work.diagnostic,
        ...(output === undefined ? {} : { output }),
        annotations,
        annotationsTruncated,
    };
    const {
        output: _outputField,
        annotations: _inlineAnnotations,
        ...checkRemainder
    } = check === undefined ? {} : check;
    const candidate = Object.assign(metadata, checkRemainder, metadata);
    const rawValues = bounded(candidate);
    return {
        ...(isRecord(rawValues) ? rawValues : candidate),
        rawValues,
        diagnostic: work.diagnostic,
        ...(output === undefined ? {} : { output }),
        annotations,
        annotationsTruncated,
    } as unknown as CollectedCheckContext;
};

const collectCheck = async (
    input: CheckRunDiagnosticsInput,
    work: CheckWork,
    dependencies: CheckRunDiagnosticsDependencies,
    state: CollectionState,
): Promise<void> => {
    const errorStart = state.errors.length;
    const recordStart = state.records.length;

    const diagnosticRawValues = bounded(work.diagnostic.rawValues);
    const diagnosticEvidenceTruncated =
        containsTruncationMarker(diagnosticRawValues);
    if (diagnosticEvidenceTruncated) {
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run diagnostic raw evidence was truncated.",
                { rawValues: diagnosticRawValues },
                undefined,
                "truncated",
            ),
        );
        state.truncated = true;
    }

    const transport = transportFor(dependencies, input.request.repository);
    const check = await collectCheckGet(work, transport, state);
    const outputOutcome = collectOutput(check, transport.maxOutputChars, state);
    const annotationOutcome = await collectAnnotations(work, transport, state);

    const value = buildCheckValue({
        work,
        check,
        output: outputOutcome.output,
        annotations: annotationOutcome.annotations,
        annotationsTruncated: annotationOutcome.truncated,
    });
    const rawEvidenceTruncated = containsTruncationMarker(value.rawValues);
    if (rawEvidenceTruncated) {
        state.errors.push(
            diagnosticErrorFor(
                CHECK_RUN_GET_SOURCE,
                "check-run raw evidence was truncated.",
                { rawValues: value.rawValues },
                undefined,
                "truncated",
            ),
        );
        state.truncated = true;
    }

    const truncated =
        diagnosticEvidenceTruncated ||
        outputOutcome.truncated ||
        annotationOutcome.truncated ||
        rawEvidenceTruncated;
    if (truncated) state.truncated = true;
    const checkErrors = state.errors.slice(errorStart);
    const disposition = dispositionForErrors(checkErrors, truncated);
    state.records.splice(
        recordStart,
        0,
        recordError("check-run", value, disposition, checkErrors),
    );
};

const collectWithDependencies = async (
    input: CheckRunDiagnosticsInput,
    dependencies: CheckRunDiagnosticsDependencies,
): Promise<CollectionResult> => {
    const state: CollectionState = {
        records: [],
        errors: [],
        truncated: false,
    };
    const selected = workForInput(input);
    state.errors.push(...selected.errors);
    for (const work of selected.work)
        await collectCheck(input, work, dependencies, state);
    return {
        request: input.request,
        source: CHECK_RUN_DIAGNOSTIC_SOURCE,
        records: state.records,
        truncated: state.truncated,
        errors: state.errors,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        ...(input.observation === undefined
            ? {}
            : { observation: input.observation }),
    } as unknown as CollectionResult;
};

/** Collect bounded output and annotations for failing check-run diagnostics. */
export const collectCheckRunDiagnostics = (
    input: CheckRunDiagnosticsInput,
    dependencies: CheckRunDiagnosticsDependencies = {},
): Promise<CollectionResult> => collectWithDependencies(input, dependencies);

/** Alias emphasizing the collected evidence is output and annotations. */
export const collectCheckRunOutputAndAnnotations = collectCheckRunDiagnostics;

/** Factory for the failing check-run diagnostics read service. */
export const makeCheckRunDiagnosticsService = (
    dependencies: CheckRunDiagnosticsDependencies = {},
): CheckRunDiagnosticsService => {
    const collect = (input: CheckRunDiagnosticsInput) =>
        collectWithDependencies(input, dependencies);
    return { collect, read: collect };
};

/** Compatibility alias for callers naming the collector rather than service. */
export const makeCheckRunDiagnosticsCollector = makeCheckRunDiagnosticsService;

/** Compatibility alias for the check-run decomposition child. */
export const makePipelineDiagnosticsChecksCollector =
    makeCheckRunDiagnosticsService;