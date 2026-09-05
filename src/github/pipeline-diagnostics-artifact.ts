/**
 * Versioned, durable storage for bounded pipeline diagnostics.
 *
 * Collection already applies the evidence limits, but this module is a
 * second trust boundary: anything written to disk is converted to JSON,
 * terminal controls are removed recursively, and the job/step/log limits are
 * checked again. Overflow is represented by a bounded truncation record rather
 * than silently disappearing. Values are never redacted.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { IssueArtifactScope } from "../issues/artifacts.ts";
import type { DiagnosticError } from "./pipeline-diagnostics-contracts.ts";
import {
    MAX_EXCERPT_BYTES,
    MAX_JOBS_PER_RUN,
    MAX_STEPS_PER_JOB,
    MAX_TOTAL_BYTES,
    type PipelineSnapshotRequest,
} from "./pipeline-diagnostics-contracts.ts";
import type { JobLogExcerptsResult } from "./pipeline-diagnostics-logs.ts";
import type { PipelineDiagnosticsCollectionResult } from "./pipeline-diagnostics-collector.ts";
import { sanitizeDiagnosticExcerpt } from "./pipeline-diagnostics-sanitize.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import { RalphieError } from "../shared/error.ts";

export const PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION = 1 as const;

export type PipelineDiagnosticsArtifact =
    PipelineDiagnosticsCollectionResult & {
        readonly version: typeof PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION;
        readonly logs: JobLogExcerptsResult;
    };

export type PipelineDiagnosticsArtifactInput = {
    readonly collection: PipelineDiagnosticsCollectionResult;
    readonly logs?: JobLogExcerptsResult;
};

export type PipelineDiagnosticsWritableValue =
    | PipelineDiagnosticsArtifactInput
    | PipelineDiagnosticsCollectionResult
    | PipelineDiagnosticsArtifact;

const dispositionSchema = z.enum([
    "ok",
    "malformed",
    "unavailable",
    "truncated",
    "rate-limited",
]);

const requestSchema = z
    .object({
        repository: z.string().min(1),
        branch: z.string().min(1),
        commitSha: z.string().min(1),
    })
    .strict();

const collectionSchema = z
    .object({
        request: requestSchema,
        source: z.string().min(1),
        records: z.array(z.unknown()),
        truncated: z.boolean(),
        errors: z.array(z.unknown()),
    })
    .passthrough();

const logsSchema = collectionSchema;

/** Public schema for callers that need to validate a stored artifact. */
export const pipelineDiagnosticsArtifactSchema = z
    .object({
        version: z.literal(PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION),
        request: requestSchema,
        source: z.literal("pipeline-diagnostics"),
        disposition: dispositionSchema,
        truncated: z.boolean(),
        records: z.array(z.unknown()),
        errors: z.array(z.unknown()),
        jobs: collectionSchema,
        checks: collectionSchema,
        logs: logsSchema,
    })
    .passthrough();

export type PipelineDiagnosticsArtifactFileSystem = {
    readonly readFile: (filePath: string) => Promise<string>;
    readonly mkdir: (
        directory: string,
        options: { readonly recursive: true },
    ) => Promise<void>;
    readonly writeFile: (
        filePath: string,
        contents: string,
        options: {
            readonly encoding: "utf8";
            readonly flag: "wx";
            readonly signal?: AbortSignal;
        },
    ) => Promise<void>;
    readonly rename: (temporaryPath: string, filePath: string) => Promise<void>;
    readonly rm: (
        filePath: string,
        options: { readonly force: true },
    ) => Promise<void>;
};

export type PipelineDiagnosticsStoreOptions = {
    readonly fileSystem?: PipelineDiagnosticsArtifactFileSystem;
};

export type PipelineDiagnosticsStoreService = {
    readonly path: string;
    readonly write: (
        value: PipelineDiagnosticsWritableValue,
        signal?: AbortSignal,
    ) => Promise<void>;
    readonly read: () => Promise<PipelineDiagnosticsArtifact>;
};

const liveFileSystem: PipelineDiagnosticsArtifactFileSystem = {
    readFile: async (filePath) => await readFile(filePath, "utf8"),
    mkdir: async (directory, options) => {
        await mkdir(directory, options);
    },
    writeFile: async (filePath, contents, options) =>
        await writeFile(filePath, contents, options),
    rename: async (temporaryPath, filePath) =>
        await rename(temporaryPath, filePath),
    rm: async (filePath, options) => await rm(filePath, options),
};

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

export const pipelineDiagnosticsPath = (scope: IssueArtifactScope): string =>
    join(
        resolveWorkspacePath(scope.workspace),
        ".ralphie",
        "runs",
        safeRunId(scope.runId),
        "pipeline",
        "diagnostics.json",
    );

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    isRecord(value) ? value : {};

const sanitizedJson = (
    value: unknown,
    seen: Set<object> = new Set(),
): unknown => {
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
        ? value.map((entry) => sanitizedJson(entry, seen))
        : Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [
                  sanitizeDiagnosticExcerpt(key),
                  sanitizedJson(entry, seen),
              ]),
          );
    seen.delete(value);
    return result;
};

const bytes = (value: string): number =>
    new TextEncoder().encode(value).byteLength;

const prefixByBytes = (value: string, limit: number): string => {
    if (bytes(value) <= limit) return value;
    let output = "";
    let used = 0;
    for (const codePoint of value) {
        const size = bytes(codePoint);
        if (used + size > limit) break;
        output += codePoint;
        used += size;
    }
    return output;
};

const identifierFor = (value: unknown): string => {
    if (!isRecord(value)) return "unknown";
    const candidate =
        value.jobId ?? value.job_id ?? value.id ?? value.number ?? "unknown";
    return typeof candidate === "string" || typeof candidate === "number"
        ? String(candidate)
        : "unknown";
};

const truncationError = (
    source: string,
    message: string,
    evidence: unknown,
): DiagnosticError => ({
    source,
    message,
    disposition: "truncated",
    rawValues: sanitizedJson(evidence) as never,
});

const recordKind = (value: unknown): string | undefined =>
    isRecord(value) && typeof value.kind === "string" ? value.kind : undefined;

const recordValue = (value: unknown): Record<string, unknown> =>
    isRecord(value) && isRecord(value.value) ? value.value : {};

type BoundedCollection = {
    readonly collection: Record<string, unknown>;
    readonly truncated: boolean;
};

type JobRecordBounds = {
    jobCount: number;
    readonly retainedJobs: Set<string>;
    readonly stepsByJob: Map<string, number>;
    truncated: boolean;
};

const retainJobRecord = (
    state: JobRecordBounds,
    value: Record<string, unknown>,
): boolean => {
    if (state.jobCount >= MAX_JOBS_PER_RUN) {
        state.truncated = true;
        return false;
    }
    state.jobCount += 1;
    state.retainedJobs.add(identifierFor(value));
    return true;
};

const retainStepRecord = (
    state: JobRecordBounds,
    value: Record<string, unknown>,
): boolean => {
    const jobId = identifierFor(value);
    if (state.retainedJobs.size > 0 && !state.retainedJobs.has(jobId)) {
        state.truncated = true;
        return false;
    }
    const count = state.stepsByJob.get(jobId) ?? 0;
    if (count >= MAX_STEPS_PER_JOB) {
        state.truncated = true;
        return false;
    }
    state.stepsByJob.set(jobId, count + 1);
    return true;
};

const retainBoundedRecord = (
    state: JobRecordBounds,
    record: unknown,
): boolean => {
    const kind = recordKind(record);
    const value = recordValue(record);
    if (kind === "job") return retainJobRecord(state, value);
    if (kind === "step") return retainStepRecord(state, value);
    return true;
};

const boundJobRecords = (
    records: ReadonlyArray<unknown>,
    errors: DiagnosticError[],
    source: string,
): BoundedCollection => {
    const state: JobRecordBounds = {
        jobCount: 0,
        retainedJobs: new Set<string>(),
        stepsByJob: new Map<string, number>(),
        truncated: false,
    };
    const bounded: unknown[] = [];

    for (const record of records) {
        if (!retainBoundedRecord(state, record)) continue;
        bounded.push(record);
    }

    if (state.truncated) {
        errors.push(
            truncationError(
                source,
                `Pipeline diagnostics exceeded the ${String(MAX_JOBS_PER_RUN)}-job or ${String(MAX_STEPS_PER_JOB)}-step serialization bound.`,
                { jobs: state.jobCount, records: records.length },
            ),
        );
    }
    return {
        collection: {
            records: bounded,
            errors,
        },
        truncated: state.truncated,
    };
};

const boundCollection = (
    value: unknown,
    source: string,
    applyJobBounds: boolean,
): BoundedCollection => {
    const collection = asRecord(value);
    const records = Array.isArray(collection.records) ? collection.records : [];
    const existingErrors = Array.isArray(collection.errors)
        ? [...collection.errors]
        : [];
    if (!applyJobBounds) {
        return {
            collection: {
                ...collection,
                records,
                errors: existingErrors,
            },
            truncated: collection.truncated === true,
        };
    }
    const bounded = boundJobRecords(records, existingErrors, source);
    return {
        collection: {
            ...collection,
            ...bounded.collection,
            truncated: collection.truncated === true || bounded.truncated,
        },
        truncated: collection.truncated === true || bounded.truncated,
    };
};

const emptyLogs = (request: PipelineSnapshotRequest): JobLogExcerptsResult =>
    ({
        request,
        source: "github.workflow-run.logs",
        records: [],
        truncated: false,
        errors: [],
    }) as JobLogExcerptsResult;

const boundedLogRecords = (
    value: unknown,
): { readonly logs: Record<string, unknown>; readonly truncated: boolean } => {
    const logs = asRecord(value);
    const source =
        typeof logs.source === "string"
            ? logs.source
            : "github.workflow-run.logs";
    const inputRecords = Array.isArray(logs.records) ? logs.records : [];
    const errors = Array.isArray(logs.errors) ? [...logs.errors] : [];
    let used = 0;
    let truncated = logs.truncated === true;
    const records = inputRecords.map((entry) => {
        const record = asRecord(entry);
        const rawExcerpt =
            typeof record.excerpt === "string" ? record.excerpt : "";
        const excerpt = sanitizeDiagnosticExcerpt(rawExcerpt);
        const availableBytes = bytes(excerpt);
        const remaining = Math.max(0, MAX_TOTAL_BYTES - used);
        const allowed = Math.min(MAX_EXCERPT_BYTES, remaining);
        const retained = prefixByBytes(excerpt, allowed);
        const fetchedBytes = bytes(retained);
        const recordTruncated = retained !== excerpt;
        if (recordTruncated) {
            truncated = true;
            errors.push(
                truncationError(
                    source,
                    `Pipeline log excerpt exceeded the ${String(MAX_EXCERPT_BYTES)}-byte per-excerpt or ${String(MAX_TOTAL_BYTES)}-byte total bound.`,
                    {
                        jobId: record.jobId,
                        availableBytes,
                        fetchedBytes,
                    },
                ),
            );
        }
        used += fetchedBytes;
        return {
            ...record,
            excerpt: retained,
            fetchedBytes,
            ...(record.availableBytes === undefined ||
            typeof record.availableBytes !== "number"
                ? { availableBytes }
                : {
                      availableBytes: Math.max(
                          record.availableBytes,
                          availableBytes,
                      ),
                  }),
            ...(recordTruncated ? { disposition: "truncated" } : {}),
        } satisfies Record<string, unknown>;
    });
    return {
        logs: {
            ...logs,
            source,
            records,
            errors,
            truncated,
        },
        truncated,
    };
};

const propagatedTruncationError = (
    bounded:
        | BoundedCollection
        | {
              readonly logs: Record<string, unknown>;
              readonly truncated: boolean;
          },
    source: string,
    message: string,
): ReadonlyArray<DiagnosticError> => {
    if (!bounded.truncated) return [];
    const retainedRecords =
        "collection" in bounded
            ? bounded.collection.records
            : bounded.logs.records;
    return [truncationError(source, message, { retainedRecords })];
};

const artifactFrom = (
    input: PipelineDiagnosticsWritableValue,
): PipelineDiagnosticsArtifact => {
    const candidate =
        "collection" in input
            ? {
                  ...input.collection,
                  logs: input.logs ?? emptyLogs(input.collection.request),
              }
            : "version" in input
              ? input
              : {
                    ...input,
                    logs:
                        "logs" in input && isRecord(input.logs)
                            ? input.logs
                            : emptyLogs(input.request),
                };
    const sanitized = asRecord(sanitizedJson(candidate));
    const errors = Array.isArray(sanitized.errors) ? [...sanitized.errors] : [];
    const jobs = boundCollection(sanitized.jobs, "pipeline.jobs", true);
    const checks = boundCollection(sanitized.checks, "pipeline.checks", false);
    const logs = boundedLogRecords(sanitized.logs);
    const truncated =
        sanitized.truncated === true ||
        jobs.truncated ||
        checks.truncated ||
        logs.truncated;
    const propagatedErrors = [
        ...propagatedTruncationError(
            jobs,
            "pipeline.jobs",
            "Serialized job diagnostics were truncated.",
        ),
        ...propagatedTruncationError(
            logs,
            "pipeline.workflow-run.logs",
            "Serialized workflow-run log diagnostics were truncated.",
        ),
    ];
    const artifact = {
        ...sanitized,
        version: PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION,
        jobs: jobs.collection,
        checks: checks.collection,
        logs: logs.logs,
        errors: [...errors, ...propagatedErrors],
        truncated,
    };
    return pipelineDiagnosticsArtifactSchema.parse(
        artifact,
    ) as PipelineDiagnosticsArtifact;
};

export const createPipelineDiagnosticsArtifact = artifactFrom;

const persistAtomically = async (
    filePath: string,
    artifact: PipelineDiagnosticsArtifact,
    signal: AbortSignal | undefined,
    fileSystem: PipelineDiagnosticsArtifactFileSystem,
): Promise<void> => {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
    try {
        signal?.throwIfAborted();
        await fileSystem.mkdir(dirname(filePath), { recursive: true });
        signal?.throwIfAborted();
        await fileSystem.writeFile(temporaryPath, encoded, {
            encoding: "utf8",
            flag: "wx",
            ...(signal === undefined ? {} : { signal }),
        });
        signal?.throwIfAborted();
        await fileSystem.rename(temporaryPath, filePath);
    } catch (cause) {
        await fileSystem
            .rm(temporaryPath, { force: true })
            .catch(() => undefined);
        if (signal?.aborted === true) throw cause;
        throw new RalphieError({
            message: `Failed to persist pipeline diagnostics at ${filePath}.`,
            cause,
        });
    }
};

export const writePipelineDiagnostics = async (
    scope: IssueArtifactScope,
    value: PipelineDiagnosticsWritableValue,
    options: PipelineDiagnosticsStoreOptions = {},
    signal?: AbortSignal,
): Promise<void> => {
    const artifact = artifactFrom(value);
    await persistAtomically(
        pipelineDiagnosticsPath(scope),
        artifact,
        signal,
        options.fileSystem ?? liveFileSystem,
    );
};

const readPipelineDiagnostics = async (
    filePath: string,
    fileSystem: PipelineDiagnosticsArtifactFileSystem,
): Promise<PipelineDiagnosticsArtifact> => {
    try {
        const value: unknown = JSON.parse(await fileSystem.readFile(filePath));
        if (
            isRecord(value) &&
            "version" in value &&
            value.version !== PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION
        ) {
            throw new RalphieError({
                message: `Pipeline diagnostics at ${filePath} use unsupported version ${String(value.version)}; expected version ${String(PIPELINE_DIAGNOSTICS_ARTIFACT_VERSION)}.`,
                cause: value,
            });
        }
        return pipelineDiagnosticsArtifactSchema.parse(
            value,
        ) as PipelineDiagnosticsArtifact;
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: `Pipeline diagnostics at ${filePath} are invalid or unreadable.`,
            cause,
        });
    }
};

export const makePipelineDiagnosticsStore = (
    scope: IssueArtifactScope,
    options: PipelineDiagnosticsStoreOptions = {},
): PipelineDiagnosticsStoreService => {
    const filePath = pipelineDiagnosticsPath(scope);
    const fileSystem = options.fileSystem ?? liveFileSystem;
    return {
        path: filePath,
        write: async (value, signal) =>
            await writePipelineDiagnostics(scope, value, options, signal),
        read: async () => await readPipelineDiagnostics(filePath, fileSystem),
    };
};