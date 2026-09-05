/**
 * Prompt-safe projection of persisted pipeline diagnostics.
 *
 * The artifact is trusted only as a typed, bounded container; its provider
 * fields are still task data. This module projects the artifact onto the
 * small set of fields the repair executor needs, removes raw error evidence,
 * and renders that one projection inside an explicit untrusted-data block.
 * No provider-derived value is interpolated outside the block.
 */
import type { RateLimitMetadata } from "./rate-limit.ts";
import type {
    DiagnosticRecordDisposition,
    JsonObject,
    JsonValue,
    PipelineIdentifier,
    PipelineRawState,
    PipelineSnapshotRequest,
} from "./pipeline-diagnostics-contracts.ts";
import {
    MAX_EXCERPT_BYTES,
    MAX_JOBS_PER_RUN,
    MAX_STEPS_PER_JOB,
    MAX_TOTAL_BYTES,
} from "./pipeline-diagnostics-contracts.ts";
import type { PipelineDiagnosticsArtifact } from "./pipeline-diagnostics-artifact.ts";
import { sanitizeDiagnosticExcerpt } from "./pipeline-diagnostics-sanitize.ts";

/** Opening marker used for every prompt-facing diagnostics payload. */
export const UNTRUSTED_PIPELINE_DIAGNOSTICS_OPEN =
    "<untrusted-pipeline-diagnostics>" as const;
/** Closing marker used for every prompt-facing diagnostics payload. */
export const UNTRUSTED_PIPELINE_DIAGNOSTICS_CLOSE =
    "</untrusted-pipeline-diagnostics>" as const;

/** Maximum number of characters occupied by the complete marked block. */
export const MAX_REPAIR_DIAGNOSTICS_CHARS = 8 * 1024;
export const MAX_PIPELINE_DIAGNOSTICS_BOUNDARY_CHARS =
    MAX_REPAIR_DIAGNOSTICS_CHARS;

const DISPOSITIONS: ReadonlySet<string> = new Set([
    "ok",
    "malformed",
    "unavailable",
    "truncated",
    "rate-limited",
]);

const TEXT_FIELDS: ReadonlyArray<string> = [
    "provider",
    "commitSha",
    "branch",
    "repository",
    "name",
    "title",
    "path",
    "message",
    "summary",
    "text",
    "excerpt",
];

const ID_FIELDS: ReadonlyArray<string> = [
    "runId",
    "runAttempt",
    "workflowId",
    "workflowRunId",
    "workflowRunAttempt",
    "workflowId",
    "suiteId",
    "checkSuiteId",
    "checkRunId",
    "jobId",
    "runNumber",
    "statusId",
    "number",
];

const STATE_FIELDS: ReadonlyArray<string> = ["status", "state", "conclusion"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const safeDisposition = (value: unknown): DiagnosticRecordDisposition =>
    typeof value === "string" && DISPOSITIONS.has(value)
        ? (value as DiagnosticRecordDisposition)
        : "unavailable";

const safeString = (value: unknown): string | undefined =>
    typeof value === "string" ? sanitizeDiagnosticExcerpt(value) : undefined;

const safeIdentifier = (value: unknown): PipelineIdentifier | undefined =>
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
        ? value
        : undefined;

/** Re-apply terminal sanitization without retaining object references. */
const safeJson = (value: unknown, seen: Set<object> = new Set()): JsonValue => {
    if (value === null) return null;
    if (typeof value === "string") return sanitizeDiagnosticExcerpt(value);
    if (typeof value === "boolean") return value;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : String(value);
    if (typeof value === "undefined") return null;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = Array.isArray(value)
        ? value.map((entry) => safeJson(entry, seen))
        : Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [
                  sanitizeDiagnosticExcerpt(key),
                  safeJson(entry, seen),
              ]),
          );
    seen.delete(value);
    return result as JsonValue;
};

const valueAt = (
    value: Record<string, unknown>,
    key: string,
): JsonValue | undefined =>
    hasOwn(value, key) ? safeJson(value[key]) : undefined;

const rawStateFor = (
    value: Record<string, unknown>,
): PipelineRawState | undefined => {
    const rawState = isRecord(value.rawState) ? value.rawState : undefined;
    const state = rawState ?? value;
    const result: Record<string, JsonValue> = {};
    for (const key of STATE_FIELDS) {
        const entry = valueAt(state, key);
        if (entry !== undefined) result[key] = entry;
    }
    return Object.keys(result).length === 0 ? undefined : result;
};

const addKnownValue = (
    target: Record<string, JsonValue>,
    source: Record<string, unknown>,
    key: string,
): void => {
    const value = valueAt(source, key);
    if (value !== undefined) target[key] = value;
};

const knownValuesFor = (
    source: Record<string, unknown>,
    keys: ReadonlyArray<string>,
): Record<string, JsonValue> =>
    Object.fromEntries(
        keys
            .map((key) => [key, valueAt(source, key)] as const)
            .filter(([, value]) => value !== undefined),
    ) as Record<string, JsonValue>;

const outputFor = (
    source: Record<string, unknown>,
): Readonly<Record<string, JsonValue>> => {
    const output = valueAt(source, "output");
    if (output === undefined) return {};
    if (!isRecord(source.output)) return { output };
    return {
        output: knownValuesFor(source.output, ["summary", "text"]),
    };
};

export type RepairDiagnosticsRecord = JsonObject & {
    readonly kind: string;
    readonly disposition: DiagnosticRecordDisposition;
    readonly provider?: string;
    readonly commitSha?: string;
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
    readonly suiteId?: PipelineIdentifier;
    readonly checkRunId?: PipelineIdentifier;
    readonly jobId?: PipelineIdentifier;
    readonly status?: JsonValue;
    readonly state?: JsonValue;
    readonly conclusion?: JsonValue;
    readonly rawState?: PipelineRawState;
    readonly output?: JsonValue;
    readonly message?: string;
    readonly excerpt?: string;
    readonly fetchedBytes?: number;
    readonly availableBytes?: number;
};

const repairRecordFor = (value: unknown): RepairDiagnosticsRecord => {
    const record = isRecord(value) ? value : {};
    const source = isRecord(record.value) ? record.value : {};
    const rawState = rawStateFor(source);
    const result: Record<string, JsonValue> = {
        kind: typeof record.kind === "string" ? record.kind : "unknown",
        disposition: safeDisposition(record.disposition),
        ...knownValuesFor(source, [
            ...TEXT_FIELDS,
            ...ID_FIELDS,
            ...STATE_FIELDS,
            "fetchedBytes",
            "availableBytes",
        ]),
        ...(rawState === undefined ? {} : { rawState: rawState as JsonObject }),
        ...outputFor(source),
    };
    return result as RepairDiagnosticsRecord;
};

export type RepairDiagnosticsLog = JsonObject & {
    readonly jobId?: PipelineIdentifier;
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly disposition: DiagnosticRecordDisposition;
    readonly excerpt: string;
    readonly fetchedBytes: number;
    readonly availableBytes?: number;
};

const repairLogFor = (value: unknown): RepairDiagnosticsLog => {
    const source = isRecord(value) ? value : {};
    const result: Record<string, JsonValue> = {
        disposition: safeDisposition(source.disposition),
        excerpt: safeString(source.excerpt) ?? "",
        fetchedBytes:
            typeof source.fetchedBytes === "number" &&
            Number.isFinite(source.fetchedBytes)
                ? source.fetchedBytes
                : 0,
    };
    for (const key of ["jobId", "runId", "runAttempt"]) {
        const identifier = safeIdentifier(source[key]);
        if (identifier !== undefined) result[key] = identifier;
    }
    if (
        typeof source.availableBytes === "number" &&
        Number.isFinite(source.availableBytes)
    )
        result.availableBytes = source.availableBytes;
    return result as RepairDiagnosticsLog;
};

export type RepairDiagnosticsError = JsonObject & {
    readonly source: string;
    readonly disposition: DiagnosticRecordDisposition;
    readonly message: string;
    readonly rateLimit?: JsonObject;
};

const rateLimitFor = (value: unknown): JsonObject | undefined => {
    if (!isRecord(value)) return undefined;
    const result: Record<string, JsonValue> = {};
    for (const key of [
        "resetAtMs",
        "retryAfterMs",
        "retryAfter",
        "resetAt",
        "remaining",
    ])
        addKnownValue(result, value, key);
    return Object.keys(result).length === 0 ? undefined : result;
};

const repairErrorFor = (value: unknown): RepairDiagnosticsError => {
    const source = isRecord(value) ? value : {};
    const message = safeString(source.message);
    const result: Record<string, JsonValue> = {
        source: safeString(source.source) ?? "unknown",
        disposition: safeDisposition(source.disposition),
        message:
            message ??
            (source.message === undefined
                ? "Diagnostic error without a message."
                : JSON.stringify(safeJson(source.message))),
    };
    const rateLimit = rateLimitFor(source.rateLimit as RateLimitMetadata);
    if (rateLimit !== undefined) result.rateLimit = rateLimit;
    return result as RepairDiagnosticsError;
};

const errorsFor = (
    artifact: PipelineDiagnosticsArtifact,
): RepairDiagnosticsError[] => {
    const values: unknown[] = [
        ...artifact.errors,
        ...artifact.jobs.errors,
        ...artifact.checks.errors,
        ...artifact.logs.errors,
        ...artifact.records.flatMap((record) =>
            isRecord(record) && Array.isArray(record.errors)
                ? record.errors
                : [],
        ),
    ];
    const errors: RepairDiagnosticsError[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const error = repairErrorFor(value);
        const key = JSON.stringify(error);
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push(error);
    }
    return errors;
};

export type RepairDiagnosticsLimits = {
    readonly maxJobs: number;
    readonly maxStepsPerJob: number;
    readonly maxExcerptBytes: number;
    readonly maxTotalBytes: number;
    readonly maxCharacters: number;
};

export type RepairDiagnosticsOmittedCounts = {
    readonly records: number;
    readonly logs: number;
    readonly errors: number;
    readonly fields: number;
};

export type RepairDiagnostics = JsonObject & {
    readonly version: 1;
    readonly request: PipelineSnapshotRequest;
    readonly source: "pipeline-diagnostics";
    readonly disposition: DiagnosticRecordDisposition;
    readonly truncated: boolean;
    readonly limits: RepairDiagnosticsLimits;
    readonly records: ReadonlyArray<RepairDiagnosticsRecord>;
    readonly errors: ReadonlyArray<RepairDiagnosticsError>;
    readonly logs: ReadonlyArray<RepairDiagnosticsLog>;
    /** True when the prompt-facing representation omitted any content. */
    readonly omitted: boolean;
    readonly omission?: "pipeline diagnostics omitted to respect the boundary cap";
    readonly omittedCounts: RepairDiagnosticsOmittedCounts;
};

const requestFor = (
    request: PipelineSnapshotRequest,
): PipelineSnapshotRequest => ({
    repository: sanitizeDiagnosticExcerpt(request.repository),
    branch: sanitizeDiagnosticExcerpt(request.branch),
    commitSha: sanitizeDiagnosticExcerpt(request.commitSha),
});

/** Create the unbounded typed projection before applying the prompt cap. */
export const projectRepairDiagnostics = (
    artifact: PipelineDiagnosticsArtifact,
): RepairDiagnostics =>
    ({
        version: 1,
        request: requestFor(artifact.request),
        source: "pipeline-diagnostics",
        disposition: safeDisposition(artifact.disposition),
        truncated: artifact.truncated === true,
        limits: {
            maxJobs: MAX_JOBS_PER_RUN,
            maxStepsPerJob: MAX_STEPS_PER_JOB,
            maxExcerptBytes: MAX_EXCERPT_BYTES,
            maxTotalBytes: MAX_TOTAL_BYTES,
            maxCharacters: MAX_REPAIR_DIAGNOSTICS_CHARS,
        },
        records: artifact.records.map(repairRecordFor),
        errors: errorsFor(artifact),
        logs: artifact.logs.records.map(repairLogFor),
        omitted: false,
        omittedCounts: { records: 0, logs: 0, errors: 0, fields: 0 },
    }) as RepairDiagnostics;

type OmissionState = {
    records: number;
    logs: number;
    errors: number;
    fields: number;
};

const omissionTotal = (state: OmissionState): number =>
    state.records + state.logs + state.errors + state.fields;

const compactText = (value: string, maxCharacters: number): string => {
    if (value.length <= maxCharacters) return value;
    const marker = `...[omitted ${String(value.length - maxCharacters)} characters]`;
    const prefixLength = Math.max(0, maxCharacters - marker.length);
    return `${value.slice(0, prefixLength)}${marker}`.slice(0, maxCharacters);
};

const compactJson = (
    value: JsonValue,
    maxStringCharacters: number,
    state: OmissionState,
): JsonValue => {
    if (typeof value === "string") {
        if (value.length <= maxStringCharacters) return value;
        state.fields += 1;
        return compactText(value, maxStringCharacters);
    }
    if (Array.isArray(value))
        return value.map((entry) =>
            compactJson(entry, maxStringCharacters, state),
        );
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            compactJson(entry, maxStringCharacters, state),
        ]),
    );
};

const encoded = (value: RepairDiagnostics): string =>
    // Escape the marker's opening character in data so XML-like content
    // cannot terminate the surrounding untrusted block early.
    JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");

const completeText = (body: string): string =>
    `${UNTRUSTED_PIPELINE_DIAGNOSTICS_OPEN}\n${body}\n${UNTRUSTED_PIPELINE_DIAGNOSTICS_CLOSE}`;

const candidateFor = (
    base: RepairDiagnostics,
    state: OmissionState,
): RepairDiagnostics => {
    const omitted = omissionTotal(state) > 0;
    const candidate: Record<string, JsonValue> = {
        ...base,
        omitted,
        omittedCounts: { ...state },
    };
    if (omitted)
        candidate.omission =
            "pipeline diagnostics omitted to respect the boundary cap";
    else delete candidate.omission;
    return candidate as RepairDiagnostics;
};

const dropTrailingEntry = (
    arrays: {
        records: RepairDiagnosticsRecord[];
        logs: RepairDiagnosticsLog[];
        errors: RepairDiagnosticsError[];
    },
    state: OmissionState,
): boolean => {
    if (arrays.errors.length > 0) {
        arrays.errors = arrays.errors.slice(0, -1);
        state.errors += 1;
        return true;
    }
    if (arrays.logs.length > 0) {
        arrays.logs = arrays.logs.slice(0, -1);
        state.logs += 1;
        return true;
    }
    if (arrays.records.length > 0) {
        arrays.records = arrays.records.slice(0, -1);
        state.records += 1;
        return true;
    }
    return false;
};

const fitProjection = (
    projection: RepairDiagnostics,
    maxCharacters: number,
): RepairDiagnostics => {
    const overhead =
        UNTRUSTED_PIPELINE_DIAGNOSTICS_OPEN.length +
        UNTRUSTED_PIPELINE_DIAGNOSTICS_CLOSE.length +
        2;
    const bodyBudget = maxCharacters - overhead;
    const state: OmissionState = { records: 0, logs: 0, errors: 0, fields: 0 };
    const arrays = {
        records: [...projection.records],
        logs: [...projection.logs],
        errors: [...projection.errors],
    };

    const tryCandidate = (maxStringCharacters: number): RepairDiagnostics => {
        const compactState: OmissionState = { ...state, fields: 0 };
        const compacted = compactJson(
            {
                ...projection,
                ...arrays,
            } as RepairDiagnostics,
            maxStringCharacters,
            compactState,
        ) as RepairDiagnostics;
        state.fields = compactState.fields;
        return candidateFor(compacted, state);
    };

    let candidate = tryCandidate(1024);
    for (const maxStringCharacters of [512, 256, 128, 64, 32, 16, 8]) {
        if (encoded(candidate).length <= bodyBudget) return candidate;
        candidate = tryCandidate(maxStringCharacters);
    }

    while (encoded(candidate).length > bodyBudget) {
        if (!dropTrailingEntry(arrays, state)) break;
        candidate = tryCandidate(8);
    }

    if (encoded(candidate).length <= bodyBudget) return candidate;

    const minimalState: OmissionState = {
        records: state.records + arrays.records.length,
        logs: state.logs + arrays.logs.length,
        errors: state.errors + arrays.errors.length,
        fields: state.fields,
    };
    const minimal = candidateFor(
        {
            ...projection,
            request: {
                repository: compactText(projection.request.repository, 64),
                branch: compactText(projection.request.branch, 64),
                commitSha: compactText(projection.request.commitSha, 64),
            },
            records: [],
            logs: [],
            errors: [],
        },
        minimalState,
    );
    if (encoded(minimal).length > bodyBudget)
        throw new RangeError(
            `Pipeline diagnostics boundary cap ${String(maxCharacters)} is too small for its marker and metadata.`,
        );
    return minimal;
};

export type PipelineDiagnosticsBoundaryOptions = {
    readonly maxCharacters?: number;
};

export type PipelineDiagnosticsBoundary = {
    readonly structured: RepairDiagnostics;
    readonly text: string;
};

/**
 * Build the structured and prompt-facing forms from one bounded projection.
 * Parsing the JSON body of `text` (after normal JSON decoding) yields the
 * same `structured` value; `<` is escaped only in the textual encoding to
 * prevent a provider value from injecting the closing marker.
 */
export const buildPipelineDiagnosticsBoundary = (
    artifact: PipelineDiagnosticsArtifact,
    options: PipelineDiagnosticsBoundaryOptions = {},
): PipelineDiagnosticsBoundary => {
    const maxCharacters = options.maxCharacters ?? MAX_REPAIR_DIAGNOSTICS_CHARS;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0)
        throw new RangeError(
            `Pipeline diagnostics boundary cap must be a positive safe integer; received ${String(maxCharacters)}.`,
        );
    const structured = fitProjection(
        projectRepairDiagnostics(artifact),
        maxCharacters,
    );
    return { structured, text: completeText(encoded(structured)) };
};

/** Render only the marked textual form for prompt interpolation. */
export const renderPipelineDiagnostics = (
    artifact: PipelineDiagnosticsArtifact,
    options: PipelineDiagnosticsBoundaryOptions = {},
): string => buildPipelineDiagnosticsBoundary(artifact, options).text;