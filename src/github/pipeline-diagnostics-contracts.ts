/**
 * Shared read-only type foundation for the GitHub Actions pipeline
 * diagnostics collector (runs -> jobs -> steps -> check runs -> annotations).
 *
 * This module defines types and validated constants only: pagination,
 * budgeting, transport, and error-classification logic live in sibling
 * modules and reuse these contracts. Existing definitions are imported and
 * re-exported, never redefined.
 */
import type { FailedPipelineObservation } from "./pipeline-observation.ts";
import type {
    ExactCommitSha,
    JsonObject,
    JsonValue,
    PipelineIdentifier,
    PipelineObservationKind,
    PipelineRawState,
    PipelineSnapshot,
    PipelineSnapshotRequest,
    PipelineSourceError,
} from "./pipeline-snapshot.ts";

/** Explicit disposition carried by every collected record and error. */
export type DiagnosticRecordDisposition =
    | "ok"
    | "malformed"
    | "unavailable"
    | "truncated"
    | "rate-limited";

/**
 * Identity of one workflow run, keyed to the exact requested commit SHA.
 * The SHA uses `ExactCommitSha` semantics: a 40-hex or 64-hex Git object ID,
 * compared lowercased, never truncated or aliased. Unknown JSON fields from
 * the source payload are preserved, never dropped.
 */
export type RunIdentity = JsonObject & {
    readonly provider: string;
    readonly commitSha: ExactCommitSha;
    readonly runId: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
};

/**
 * Context for one job of a run. Raw status/state/conclusion values are kept
 * as raw JSON (`PipelineRawState` semantics) so GitHub values are never
 * normalized away. Unknown JSON fields are preserved, never dropped.
 */
export type JobContext = JsonObject & {
    readonly provider: string;
    readonly runId: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly jobId: PipelineIdentifier;
    readonly rawState: PipelineRawState;
};

/**
 * One workflow step record. Timestamps are ISO strings, `conclusion` stays
 * raw (GitHub uses null before completion). All unknown JSON fields are
 * preserved, never dropped.
 */
export type StepRecord = JsonObject & {
    readonly name: string;
    readonly number: number;
    readonly conclusion?: JsonValue;
    readonly startedAt?: string;
    readonly completedAt?: string;
};

/**
 * Context for one check run. Raw status/state/conclusion values are kept as
 * raw JSON. All unknown JSON fields are preserved, never dropped.
 */
export type CheckContext = JsonObject & {
    readonly checkRunId: PipelineIdentifier;
    readonly provider: string;
    readonly name?: string;
    readonly rawState: PipelineRawState;
};

/**
 * One check annotation with raw line/column geometry. All unknown JSON
 * fields are preserved, never dropped.
 */
export type AnnotationRecord = JsonObject & {
    readonly level?: JsonValue;
    readonly message?: string;
    readonly path?: string;
    readonly startLine?: number;
    readonly startColumn?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
};

/**
 * Error or disposition record carried by collections and records. It is
 * shape-compatible with `PipelineSourceError`: `source`, `message`,
 * `rawValues`, and `rateLimit` occupy the same positions, so a
 * `DiagnosticError` is assignable to the `PipelineSourceError` shape.
 * `rawValues` is bounded by `MAX_RAW_EVIDENCE` when attached.
 */
export type DiagnosticError = PipelineSourceError & {
    readonly disposition: DiagnosticRecordDisposition;
};

/** A collected record grouped by kind, with a per-record disposition. */
export type CollectedRecord =
    | {
          readonly kind: "run";
          readonly disposition: DiagnosticRecordDisposition;
          readonly value: RunIdentity;
          readonly errors?: ReadonlyArray<DiagnosticError>;
      }
    | {
          readonly kind: "job";
          readonly disposition: DiagnosticRecordDisposition;
          readonly value: JobContext;
          readonly errors?: ReadonlyArray<DiagnosticError>;
      }
    | {
          readonly kind: "step";
          readonly disposition: DiagnosticRecordDisposition;
          readonly value: StepRecord;
          readonly errors?: ReadonlyArray<DiagnosticError>;
      }
    | {
          readonly kind: "check-run";
          readonly disposition: DiagnosticRecordDisposition;
          readonly value: CheckContext;
          readonly errors?: ReadonlyArray<DiagnosticError>;
      }
    | {
          readonly kind: "annotation";
          readonly disposition: DiagnosticRecordDisposition;
          readonly value: AnnotationRecord;
          readonly errors?: ReadonlyArray<DiagnosticError>;
      };

/**
 * The result of one bounded diagnostics collection for one run. `truncated`
 * is set when any bound or cap (limits below) was hit. Unknown JSON fields
 * are preserved at the top level, never dropped.
 */
export type CollectionResult = JsonObject & {
    /** The exact-commit request this collection serves. */
    readonly request: PipelineSnapshotRequest;
    /** The pipeline observation kind that produced this collection. */
    readonly source: PipelineObservationKind;
    /** Collected records grouped by kind, each with a per-record disposition. */
    readonly records: ReadonlyArray<CollectedRecord>;
    /** True when any bound or cap was hit (top-level truncated outcome). */
    readonly truncated: boolean;
    /** Parallel errors array; every error carries its disposition. */
    readonly errors: ReadonlyArray<DiagnosticError>;
    /** The snapshot this collection diagnoses, when available. */
    readonly snapshot?: PipelineSnapshot;
    /** The failed observation this collection accompanies, when available. */
    readonly observation?: FailedPipelineObservation;
};

/** Maximum workflow-run jobs collected for one run. */
export const MAX_JOBS_PER_RUN = 20;

/** Maximum workflow steps collected for one job. */
export const MAX_STEPS_PER_JOB = 40;

/** Maximum check annotations collected for one check run. */
export const MAX_CHECK_ANNOTATIONS = 100;

/** Maximum characters of check output (summary/text) collected per check run. */
export const MAX_CHECK_OUTPUT_CHARS = 50_000;

/** Raw-evidence bound: maximum raw JSON retained per record. */
export const MAX_RAW_EVIDENCE = 32_768;

/** Maximum UTF-8 bytes retained per individual job-log excerpt. */
export const MAX_EXCERPT_BYTES = 8 * 1024;

/** Maximum UTF-8 bytes retained across all job-log excerpts for one run. */
export const MAX_TOTAL_BYTES = 64 * 1024;

/** Hard pagination page cap for every diagnostics endpoint. */
export const MAX_PAGINATION_PAGES = 10_000;

/**
 * Validate one diagnostics limit as a positive safe integer. Throws a
 * RangeError for 0, negatives, and non-integers (including NaN and
 * Infinity). Every exported limit above is validated at module scope.
 */
export const validateDiagnosticsLimit = (
    name: string,
    value: number,
): number => {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
            `${name} must be a positive safe integer; received ${String(value)}.`,
        );
    return value;
};

validateDiagnosticsLimit("MAX_JOBS_PER_RUN", MAX_JOBS_PER_RUN);
validateDiagnosticsLimit("MAX_STEPS_PER_JOB", MAX_STEPS_PER_JOB);
validateDiagnosticsLimit("MAX_CHECK_ANNOTATIONS", MAX_CHECK_ANNOTATIONS);
validateDiagnosticsLimit("MAX_CHECK_OUTPUT_CHARS", MAX_CHECK_OUTPUT_CHARS);
validateDiagnosticsLimit("MAX_RAW_EVIDENCE", MAX_RAW_EVIDENCE);
validateDiagnosticsLimit("MAX_EXCERPT_BYTES", MAX_EXCERPT_BYTES);
validateDiagnosticsLimit("MAX_TOTAL_BYTES", MAX_TOTAL_BYTES);
validateDiagnosticsLimit("MAX_PAGINATION_PAGES", MAX_PAGINATION_PAGES);

export type {
    ExactCommitSha,
    JsonObject,
    JsonValue,
    PipelineDiagnostic,
    PipelineDiagnosticDisposition,
    PipelineIdentifier,
    PipelineObservationKind,
    PipelineRawState,
    PipelineSnapshot,
    PipelineSnapshotRequest,
    PipelineSourceError,
    PipelineSourceErrorInput,
} from "./pipeline-snapshot.ts";
export type { FailedPipelineObservation } from "./pipeline-observation.ts";
export type { RateLimitMetadata } from "./rate-limit.ts";