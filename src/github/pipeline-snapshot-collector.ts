/** Read-only Octokit collection for the pure pipeline snapshot normalizer. */
import type { Octokit } from "octokit";

import {
    normalizePipelineSnapshot,
    type ExactCommitSha,
    type JsonObject,
    type JsonValue,
    type PipelineObservationKind,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
    type PipelineSourceError,
} from "./pipeline-snapshot.ts";
import { rateLimitFromUnknown } from "./rate-limit.ts";
import { parseRepositorySlug } from "./repository.ts";

const PAGE_SIZE = 100;

type Endpoint = (parameters: Record<string, unknown>) => Promise<unknown>;

type PageMapper = (
    response: unknown,
    done?: () => void,
) => ReadonlyArray<JsonValue>;

type Paginate = (
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    map: PageMapper,
) => Promise<ReadonlyArray<JsonValue>>;

/** Injectable transport used by collectors and deadline-aware observers. */
export type PipelineSnapshotRequestExecutor = (
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
) => Promise<unknown>;

export type PipelineSnapshotCollectorDependencies = {
    readonly request?: PipelineSnapshotRequestExecutor;
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

type SourceDefinition = {
    readonly source: string;
    readonly request: PipelineSnapshotRequest;
    readonly kind: PipelineObservationKind;
    readonly responseKey: string;
    readonly namespace: "checks" | "repos" | "actions";
    readonly endpointNames: ReadonlyArray<
        | "listForRef"
        | "listSuitesForRef"
        | "listCommitStatusesForRef"
        | "getCombinedStatusForRef"
        | "listWorkflowRunsForRepo"
    >;
    /** Combined status responses carry scope; list-status responses do not. */
    readonly requiresStatusEnvelope?: boolean;
    readonly parameters: Record<string, unknown>;
};

type SourceResult = {
    readonly observations: ReadonlyArray<JsonValue>;
    readonly errors: ReadonlyArray<PipelineSourceError>;
};

type MappedPage = {
    readonly observations: ReadonlyArray<JsonValue>;
    readonly issue?: string;
};

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const serializeJson = (
    value: unknown,
    seen: Set<object> = new Set(),
): JsonValue => {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : String(value);
    if (typeof value === "undefined") return null;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value))
        return value.map((entry) => serializeJson(entry, seen));

    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value))
        result[key] = serializeJson(
            (value as Record<string, unknown>)[key],
            seen,
        );
    seen.delete(value);
    return result;
};

const serializedRecord = (value: unknown): JsonObject => {
    const result = serializeJson(value);
    return isRecord(result) ? result : { value: result };
};

const responseData = (response: unknown): unknown =>
    isRecord(response) && hasOwn(response, "data") ? response.data : response;

const shaMatches = (
    left: JsonValue | undefined,
    right: JsonValue | undefined,
): boolean =>
    typeof left === "string" &&
    typeof right === "string" &&
    left.trim().toLowerCase() === right.trim().toLowerCase();

const statusShaFor = (record: JsonObject, envelope: JsonObject): JsonValue => {
    if (!hasOwn(envelope, "sha")) return null;
    const envelopeSha = serializeJson(envelope.sha);
    const recordSha = hasOwn(record, "sha") ? record.sha : undefined;
    if (recordSha === undefined || shaMatches(recordSha, envelopeSha))
        return envelopeSha;
    return [recordSha, envelopeSha];
};

const statusEnvelopeIssue = (
    envelope: JsonObject,
    source: SourceDefinition,
): string | undefined => {
    if (source.kind !== "status-context" || !source.requiresStatusEnvelope)
        return undefined;
    if (!hasOwn(envelope, "sha"))
        return `${source.source} response is missing its envelope SHA.`;
    if (typeof envelope.sha !== "string" || envelope.sha.trim().length === 0)
        return `${source.source} response has a malformed envelope SHA.`;
    if (!shaMatches(envelope.sha, source.request.commitSha))
        return `${source.source} envelope SHA does not match the requested exact SHA.`;

    const branchValues = ["branch", "branchName", "headBranch", "head_branch"]
        .filter((key) => hasOwn(envelope, key))
        .map((key) => envelope[key]);
    if (branchValues.length === 0) return undefined;
    if (
        branchValues.some(
            (value) => typeof value !== "string" || value.trim().length === 0,
        )
    )
        return `${source.source} response has a malformed envelope branch.`;
    const branches = [
        ...new Set(
            branchValues.map((value) =>
                (value as string).trim().replace(/^refs\/heads\//i, ""),
            ),
        ),
    ];
    if (branches.length > 1)
        return `${source.source} response has an ambiguous envelope branch.`;
    if (
        branches[0] !==
        source.request.branch.trim().replace(/^refs\/heads\//i, "")
    )
        return `${source.source} envelope branch does not match the requested branch.`;
    return undefined;
};

const observationFor = (
    value: unknown,
    source: SourceDefinition,
    envelope: JsonObject | undefined,
): JsonValue => {
    if (!isRecord(value)) return serializeJson(value);
    const record = serializedRecord(value);
    if (source.kind !== "status-context")
        return { ...record, kind: source.kind };
    const hasScopeEnvelope =
        envelope !== undefined &&
        (source.requiresStatusEnvelope === true ||
            hasOwn(envelope, "sha") ||
            ["branch", "branchName", "headBranch", "head_branch"].some((key) =>
                hasOwn(envelope, key),
            ));
    if (!hasScopeEnvelope)
        return {
            ...record,
            kind: source.kind,
            sha: record.sha ?? source.request.commitSha,
            ...(hasOwn(record, "branch")
                ? {}
                : { branch: source.request.branch }),
        };

    return {
        ...record,
        kind: source.kind,
        sha: statusShaFor(record, envelope),
        ...(hasOwn(record, "branch")
            ? {}
            : {
                  branch: hasOwn(envelope, "branch")
                      ? serializeJson(envelope.branch)
                      : source.request.branch,
              }),
    };
};

const mapPage = (response: unknown, source: SourceDefinition): MappedPage => {
    const data = responseData(response);
    if (Array.isArray(data)) {
        return source.kind === "status-context" && source.requiresStatusEnvelope
            ? {
                  observations: [],
                  issue: `${source.source} response did not contain a combined-status envelope.`,
              }
            : {
                  observations: data.map((value) =>
                      observationFor(value, source, undefined),
                  ),
              };
    }
    if (!isRecord(data)) {
        return {
            observations: [],
            issue: `${source.source} response was not a JSON object or array.`,
        };
    }

    const envelope = serializedRecord(data);
    const scopeIssue = statusEnvelopeIssue(envelope, source);
    if (scopeIssue !== undefined)
        return { observations: [], issue: scopeIssue };
    const values = envelope[source.responseKey];
    if (!Array.isArray(values)) {
        return {
            observations: [],
            issue: `${source.source} response did not contain ${source.responseKey}.`,
        };
    }
    return {
        observations: values.map((value) =>
            observationFor(value, source, envelope),
        ),
    };
};

type EndpointSelection = {
    readonly endpoint: unknown;
    readonly source: SourceDefinition;
};

const endpointFor = (
    client: Octokit,
    source: SourceDefinition,
): EndpointSelection => {
    const rest = (client as unknown as { readonly rest?: unknown }).rest;
    const namespace = isRecord(rest) ? rest[source.namespace] : undefined;
    const selected = isRecord(namespace)
        ? source.endpointNames
              .map((name) => ({ name, endpoint: namespace[name] }))
              .find(
                  ({ endpoint }) => endpoint !== undefined && endpoint !== null,
              )
        : undefined;
    if (selected === undefined)
        throw new Error(`${source.source} endpoint is unavailable.`);
    return {
        endpoint: selected.endpoint,
        source: {
            ...source,
            requiresStatusEnvelope:
                source.kind === "status-context" &&
                selected.name === "getCombinedStatusForRef",
        },
    };
};

const totalCountFor = (response: unknown): number | undefined => {
    const data = responseData(response);
    if (!isRecord(data) || typeof data.total_count !== "number")
        return undefined;
    return Number.isSafeInteger(data.total_count) && data.total_count >= 0
        ? data.total_count
        : undefined;
};

const nextLinkFor = (response: unknown): boolean | undefined => {
    if (!isRecord(response)) return undefined;
    const headers = response.headers;
    if (headers === undefined || headers === null) return undefined;
    const link =
        typeof (headers as { get?: unknown }).get === "function"
            ? (headers as { get: (name: string) => unknown }).get("link")
            : isRecord(headers)
              ? Object.entries(headers).find(
                    ([key]) => key.toLowerCase() === "link",
                )?.[1]
              : undefined;
    if (typeof link !== "string") return undefined;
    return /rel=[\"']next[\"']/i.test(link);
};

const hasNextPage = (
    page: number,
    count: number,
    response: unknown,
): boolean => {
    const nextLink = nextLinkFor(response);
    if (nextLink !== undefined) return nextLink;
    const totalCount = totalCountFor(response);
    if (totalCount !== undefined) return page * PAGE_SIZE < totalCount;
    return count === PAGE_SIZE;
};

const pageCountFor = (response: unknown, source: SourceDefinition): number => {
    const data = responseData(response);
    if (Array.isArray(data)) return data.length;
    if (!isRecord(data)) return 0;
    const values = data[source.responseKey];
    return Array.isArray(values) ? values.length : 0;
};

const paginateDirect = async (
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    source: SourceDefinition,
    request: PipelineSnapshotRequestExecutor,
    signal?: AbortSignal,
): Promise<ReadonlyArray<JsonValue>> => {
    const observations: JsonValue[] = [];
    for (let page = 1; page <= 10_000; page += 1) {
        const response = await request(
            endpoint,
            { ...parameters, page },
            signal,
        );
        const mapped = mapPage(response, source);
        if (mapped.issue !== undefined) throw new Error(mapped.issue);
        observations.push(...mapped.observations);
        if (!hasNextPage(page, pageCountFor(response, source), response))
            return observations;
    }
    throw new Error(`${source.source} pagination exceeded the safety limit.`);
};

const paginateSource = async (
    client: Octokit,
    endpoint: unknown,
    parameters: Record<string, unknown>,
    source: SourceDefinition,
    request: PipelineSnapshotRequestExecutor,
    signal?: AbortSignal,
): Promise<ReadonlyArray<JsonValue>> => {
    // Real Octokit endpoints are callable. Calling them directly keeps the
    // original response envelope, including the combined-status scope fields.
    if (typeof endpoint === "function")
        return paginateDirect(
            endpoint as Endpoint,
            parameters,
            source,
            request,
            signal,
        );
    if (typeof client.paginate !== "function")
        throw new Error(`${source.source} endpoint is not callable.`);

    const pageIssues: string[] = [];
    let mapperCalls = 0;
    const paginate = client.paginate as unknown as Paginate;
    const returned = await paginate(
        endpoint as Endpoint,
        {
            ...parameters,
            ...(signal === undefined ? {} : { request: { signal } }),
        },
        (response) => {
            mapperCalls += 1;
            const mapped = mapPage(response, source);
            if (mapped.issue !== undefined) pageIssues.push(mapped.issue);
            return mapped.observations;
        },
    );

    const values = Array.isArray(returned) ? returned : [returned];
    const hasReturnedEnvelope = values.some(
        (value) => isRecord(value) && hasOwn(value, source.responseKey),
    );
    const observations = values.flatMap((value) => {
        if (isRecord(value) && hasOwn(value, source.responseKey)) {
            const mapped = mapPage(value, source);
            if (mapped.issue !== undefined) pageIssues.push(mapped.issue);
            return [...mapped.observations];
        }
        return mapperCalls === 0
            ? [observationFor(value, source, undefined)]
            : [value];
    });

    if (pageIssues.length > 0)
        throw new Error([...new Set(pageIssues)].join(" "));
    return hasReturnedEnvelope || mapperCalls === 0 ? observations : values;
};

const errorMessage = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

const errorValues = (cause: unknown): unknown => {
    if (!(cause instanceof Error)) return cause;
    const response = (cause as Error & { readonly response?: unknown })
        .response;
    return response === undefined
        ? { name: cause.name, message: cause.message }
        : { name: cause.name, message: cause.message, response };
};

const headersForCause = (
    cause: unknown,
): Readonly<Record<string, unknown>> | undefined => {
    if (!isRecord(cause)) return undefined;
    const responseHeaders = isRecord(cause.response)
        ? cause.response.headers
        : undefined;
    const headers = responseHeaders ?? cause.headers;
    return isRecord(headers) ? headers : undefined;
};

const sourceError = (source: string, cause: unknown): PipelineSourceError => {
    const headers = headersForCause(cause);
    const headerRateLimit =
        headers === undefined ? undefined : rateLimitFromUnknown({ headers });
    const rateLimit =
        headerRateLimit === undefined
            ? rateLimitFromUnknown(cause)
            : { headers };
    return {
        source,
        message: errorMessage(cause),
        rawValues: serializeJson(errorValues(cause)),
        ...(rateLimit === undefined ? {} : { rateLimit }),
    };
};

const collectSource = async (
    client: Octokit,
    source: SourceDefinition,
    request: PipelineSnapshotRequestExecutor,
    signal?: AbortSignal,
): Promise<SourceResult> => {
    try {
        const selection = endpointFor(client, source);
        return {
            observations: await paginateSource(
                client,
                selection.endpoint,
                selection.source.parameters,
                selection.source,
                request,
                signal,
            ),
            errors: [],
        };
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        return {
            observations: [],
            errors: [sourceError(source.source, cause)],
        };
    }
};

const sourceDefinitions = (
    owner: string,
    repo: string,
    request: PipelineSnapshotRequest,
): ReadonlyArray<SourceDefinition> => [
    {
        source: "checks",
        request,
        kind: "check-run",
        responseKey: "check_runs",
        namespace: "checks",
        endpointNames: ["listForRef"],
        parameters: {
            owner,
            repo,
            ref: request.commitSha,
            filter: "all",
            per_page: PAGE_SIZE,
        },
    },
    {
        source: "suites",
        request,
        kind: "check-suite",
        responseKey: "check_suites",
        namespace: "checks",
        endpointNames: ["listSuitesForRef"],
        parameters: {
            owner,
            repo,
            ref: request.commitSha,
            per_page: PAGE_SIZE,
        },
    },
    {
        source: "statuses",
        request,
        kind: "status-context",
        responseKey: "statuses",
        namespace: "repos",
        endpointNames: ["listCommitStatusesForRef"],
        parameters: {
            owner,
            repo,
            ref: request.commitSha,
            per_page: PAGE_SIZE,
        },
    },
    {
        source: "workflow-runs",
        request,
        kind: "workflow-run",
        responseKey: "workflow_runs",
        namespace: "actions",
        endpointNames: ["listWorkflowRunsForRepo"],
        parameters: {
            owner,
            repo,
            branch: request.branch,
            head_sha: request.commitSha,
            per_page: PAGE_SIZE,
        },
    },
];

const collectSnapshot = async (
    client: Octokit,
    request: PipelineSnapshotRequest,
    signal: AbortSignal | undefined,
    requestExecutor: PipelineSnapshotRequestExecutor,
    checksOnly: boolean,
): Promise<PipelineSnapshot> => {
    const { owner, name } = parseRepositorySlug(request.repository);
    const allSources = sourceDefinitions(owner, name, request);
    const sources = checksOnly
        ? allSources.filter(
              ({ source }) => source === "checks" || source === "statuses",
          )
        : allSources;
    const results = await Promise.all(
        sources.map((source) =>
            collectSource(client, source, requestExecutor, signal),
        ),
    );
    return normalizePipelineSnapshot({
        ...request,
        observations: results.flatMap((result) => result.observations),
        sourceErrors: results.flatMap((result) => result.errors),
    });
};

const requestForArguments = (
    requestOrRepository: PipelineSnapshotRequest | string,
    branch?: string,
    commitSha?: ExactCommitSha,
): PipelineSnapshotRequest =>
    typeof requestOrRepository === "string"
        ? {
              repository: requestOrRepository,
              branch: branch ?? "",
              commitSha: commitSha ?? "",
          }
        : requestOrRepository;

const isAbortSignal = (value: unknown): value is AbortSignal =>
    isRecord(value) && typeof value.aborted === "boolean";

const collectOperation = (
    requestExecutor: PipelineSnapshotRequestExecutor,
    checksOnly: boolean,
): PipelineSnapshotCollectorOperation => {
    const collect = (
        client: Octokit,
        requestOrRepository: PipelineSnapshotRequest | string,
        branchOrSignal?: string | AbortSignal,
        commitSha?: ExactCommitSha,
        signal?: AbortSignal,
    ): Promise<PipelineSnapshot> => {
        const objectSignal =
            typeof requestOrRepository !== "string" &&
            isAbortSignal(branchOrSignal)
                ? branchOrSignal
                : signal;
        const branch =
            typeof branchOrSignal === "string" ? branchOrSignal : undefined;
        return collectSnapshot(
            client,
            requestForArguments(requestOrRepository, branch, commitSha),
            objectSignal,
            requestExecutor,
            checksOnly,
        );
    };
    return collect;
};

export type PipelineSnapshotCollectorOperation = {
    (
        client: Octokit,
        request: PipelineSnapshotRequest,
        signal?: AbortSignal,
    ): Promise<PipelineSnapshot>;
    (
        client: Octokit,
        repository: string,
        branch: string,
        commitSha: ExactCommitSha,
        signal?: AbortSignal,
    ): Promise<PipelineSnapshot>;
};

export function collectPipelineSnapshot(
    client: Octokit,
    request: PipelineSnapshotRequest,
    signal?: AbortSignal,
): Promise<PipelineSnapshot>;
export function collectPipelineSnapshot(
    client: Octokit,
    repository: string,
    branch: string,
    commitSha: ExactCommitSha,
    signal?: AbortSignal,
): Promise<PipelineSnapshot>;
export function collectPipelineSnapshot(
    client: Octokit,
    requestOrRepository: PipelineSnapshotRequest | string,
    branchOrSignal?: string | AbortSignal,
    commitSha?: ExactCommitSha,
    signal?: AbortSignal,
): Promise<PipelineSnapshot> {
    const objectSignal =
        typeof requestOrRepository !== "string" && isAbortSignal(branchOrSignal)
            ? branchOrSignal
            : signal;
    const branch =
        typeof branchOrSignal === "string" ? branchOrSignal : undefined;
    return collectSnapshot(
        client,
        requestForArguments(requestOrRepository, branch, commitSha),
        objectSignal,
        requestDirectly,
        false,
    );
}

export type PipelineSnapshotCollectorService = {
    readonly collect: PipelineSnapshotCollectorOperation;
    readonly read: PipelineSnapshotCollectorOperation;
};

export type GitHubPipelineSnapshotService = PipelineSnapshotCollectorService;

export type PipelineChecksSnapshotCollectorService = {
    readonly collect: PipelineSnapshotCollectorOperation;
    readonly read: PipelineSnapshotCollectorOperation;
};

export const makePipelineSnapshotCollectorService = (
    dependencies: PipelineSnapshotCollectorDependencies = {},
): PipelineSnapshotCollectorService => {
    const request = dependencies.request ?? requestDirectly;
    const collect = collectOperation(request, false);
    return { collect, read: collect };
};

export const makePipelineChecksSnapshotCollectorService = (
    dependencies: PipelineSnapshotCollectorDependencies = {},
): PipelineChecksSnapshotCollectorService => {
    const request = dependencies.request ?? requestDirectly;
    const collect = collectOperation(request, true);
    return { collect, read: collect };
};

export const collectPipelineChecksSnapshot: PipelineSnapshotCollectorOperation =
    collectOperation(requestDirectly, true);

export const makeGitHubPipelineSnapshotService =
    makePipelineSnapshotCollectorService;
export const makePipelineSnapshotService = makePipelineSnapshotCollectorService;
export const makePipelineSnapshotCollector =
    makePipelineSnapshotCollectorService;
export const makeGitHubChecksSnapshotService =
    makePipelineChecksSnapshotCollectorService;
export const makePipelineCheckSnapshotService =
    makePipelineChecksSnapshotCollectorService;
export const GitHubPipelineSnapshotLive = makePipelineSnapshotCollectorService;
export const PipelineSnapshotCollectorLive =
    makePipelineSnapshotCollectorService;

export type {
    ExactCommitSha,
    PipelineSnapshot,
    PipelineSnapshotRequest,
} from "./pipeline-snapshot.ts";