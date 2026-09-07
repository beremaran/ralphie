/**
 * Runtime assembly for a failed pipeline observation.
 *
 * The service keeps collection, log retrieval, durable storage, and prompt
 * projection in one explicit operation. GitHub-facing pieces remain read-only
 * and are injectable; the only mutation is the local atomic artifact write.
 */
import type { IssueArtifactScope } from "../issues/artifacts.ts";
import type {
    PipelineDiagnosticsCollectorInput,
    PipelineDiagnosticsCollectionResult,
} from "./pipeline-diagnostics-collector.ts";
import type { JobContext } from "./pipeline-diagnostics-contracts.ts";
import {
    makePipelineDiagnosticsService as makeCollectorService,
    type PipelineDiagnosticsCollectorService,
} from "./pipeline-diagnostics-collector.ts";
import type {
    JobLogExcerptJob,
    JobLogExcerptsResult,
    JobLogExcerptsService,
} from "./pipeline-diagnostics-logs.ts";
import { makePipelineDiagnosticsLogsService } from "./pipeline-diagnostics-logs.ts";
import {
    buildPipelineDiagnosticsBoundary,
    type PipelineDiagnosticsBoundary,
    type PipelineDiagnosticsBoundaryOptions,
} from "./pipeline-diagnostics-boundary.ts";
import {
    createPipelineDiagnosticsArtifact,
    makePipelineDiagnosticsStore,
    type PipelineDiagnosticsArtifact,
    type PipelineDiagnosticsStoreService,
} from "./pipeline-diagnostics-artifact.ts";

export type PipelineDiagnosticsServiceDependencies = {
    /** Preassembled collector, primarily for deterministic acceptance tests. */
    readonly collector?: PipelineDiagnosticsCollectorService;
    /** Preassembled bounded log service, primarily for deterministic tests. */
    readonly logs?: JobLogExcerptsService;
    /** A fixed store is useful for a single-run test seam. */
    readonly store?: PipelineDiagnosticsStoreService;
};

export type PipelineDiagnosticsServiceInput =
    PipelineDiagnosticsCollectorInput & {
        readonly scope: IssueArtifactScope;
        /** Override the jobs inferred from the collected workflow-run records. */
        readonly jobs?: ReadonlyArray<JobLogExcerptJob>;
        readonly boundaryOptions?: PipelineDiagnosticsBoundaryOptions;
    };

export type PipelineDiagnosticsServiceResult = {
    readonly collection: PipelineDiagnosticsCollectionResult;
    readonly logs: JobLogExcerptsResult;
    readonly artifact: PipelineDiagnosticsArtifact;
    readonly boundary: PipelineDiagnosticsBoundary;
    readonly path: string;
};

export type PipelineDiagnosticsService = {
    readonly collectAndStore: (
        input: PipelineDiagnosticsServiceInput,
    ) => Promise<PipelineDiagnosticsServiceResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasRunAttempt = (
    value: JobContext,
): value is JobContext & { readonly runAttempt: string | number } =>
    typeof value.runAttempt === "string" ||
    (typeof value.runAttempt === "number" &&
        Number.isSafeInteger(value.runAttempt));

const jobsFromCollection = (
    collection: PipelineDiagnosticsCollectionResult,
): ReadonlyArray<JobLogExcerptJob> =>
    collection.jobs.records.flatMap((record) => {
        if (
            !isRecord(record) ||
            record.kind !== "job" ||
            !isRecord(record.value)
        )
            return [];
        const value = record.value as JobContext;
        return hasRunAttempt(value) ? [value as JobLogExcerptJob] : [];
    });

/** Assemble the collector -> logs -> artifact -> boundary runtime path. */
export const makePipelineDiagnosticsService = (
    dependencies: PipelineDiagnosticsServiceDependencies = {},
): PipelineDiagnosticsService => {
    const collector = dependencies.collector ?? makeCollectorService();
    const logs = dependencies.logs ?? makePipelineDiagnosticsLogsService();

    const collectAndStore = async (
        input: PipelineDiagnosticsServiceInput,
    ): Promise<PipelineDiagnosticsServiceResult> => {
        input.signal?.throwIfAborted();
        const collection = await collector.collect(input);
        input.signal?.throwIfAborted();
        const jobs = input.jobs ?? jobsFromCollection(collection);
        const logResult = await logs.collect({
            request: collection.request,
            jobs,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        input.signal?.throwIfAborted();
        const artifact = createPipelineDiagnosticsArtifact({
            collection,
            logs: logResult,
        });
        const store =
            dependencies.store ?? makePipelineDiagnosticsStore(input.scope);
        await store.write(artifact, input.signal);
        input.signal?.throwIfAborted();
        const boundary = buildPipelineDiagnosticsBoundary(
            artifact,
            input.boundaryOptions,
        );
        return {
            collection,
            logs: logResult,
            artifact,
            boundary,
            path: store.path,
        };
    };

    return { collectAndStore };
};