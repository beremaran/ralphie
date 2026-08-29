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
import { parseRepositorySlug } from "./repository.ts";

const PAGE_SIZE = 100;

type Endpoint = (parameters: Record<string, unknown>) => Promise<unknown>;

type PageResponse = {
    readonly data?: unknown;
};

type PageMapper = (
    response: PageResponse,
    done?: () => void,
) => ReadonlyArray<JsonValue>;

type Paginate = (
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    map: PageMapper,
) => Promise<ReadonlyArray<JsonValue>>;

type SourceDefinition = {
    readonly source: string;
    readonly request: PipelineSnapshotRequest;
    readonly kind: PipelineObservationKind;
    readonly responseKey: string;
    readonly namespace: "checks" | "repos" | "actions";
    readonly endpointName:
        | "listForRef"
        | "listSuitesForRef"
        | "getCombinedStatusForRef"
        | "listWorkflowRunsForRepo";
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
    if (source.kind !== "status-context") return undefined;
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
    kind: PipelineObservationKind,
    envelope: JsonObject | undefined,
): JsonValue => {
    if (!isRecord(value)) return serializeJson(value);
    const record = serializedRecord(value);
    if (kind !== "status-context" || envelope === undefined)
        return { ...record, kind };

    return {
        ...record,
        kind,
        sha: statusShaFor(record, envelope),
        ...(hasOwn(record, "branch") || !hasOwn(envelope, "branch")
            ? {}
            : { branch: serializeJson(envelope.branch) }),
    };
};

const mapPage = (response: unknown, source: SourceDefinition): MappedPage => {
    const data = responseData(response);
    if (Array.isArray(data)) {
        return source.kind === "status-context"
            ? {
                  observations: [],
                  issue: `${source.source} response did not contain a combined-status envelope.`,
              }
            : {
                  observations: data.map((value) =>
                      observationFor(value, source.kind, undefined),
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
            observationFor(value, source.kind, envelope),
        ),
    };
};

const endpointFor = (client: Octokit, source: SourceDefinition): unknown => {
    const rest = (client as unknown as { readonly rest?: unknown }).rest;
    const namespace = isRecord(rest) ? rest[source.namespace] : undefined;
    const endpoint = isRecord(namespace)
        ? namespace[source.endpointName]
        : undefined;
    if (endpoint === undefined || endpoint === null)
        throw new Error(`${source.source} endpoint is unavailable.`);
    return endpoint;
};

const totalCountFor = (response: unknown): number | undefined => {
    const data = responseData(response);
    if (!isRecord(data) || typeof data.total_count !== "number")
        return undefined;
    return Number.isSafeInteger(data.total_count) && data.total_count >= 0
        ? data.total_count
        : undefined;
};

const hasNextPage = (
    page: number,
    count: number,
    response: unknown,
): boolean => {
    const totalCount = totalCountFor(response);
    if (totalCount !== undefined) return page * PAGE_SIZE < totalCount;
    return count === PAGE_SIZE;
};

const paginateDirect = async (
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    source: SourceDefinition,
): Promise<ReadonlyArray<JsonValue>> => {
    const observations: JsonValue[] = [];
    for (let page = 1; page <= 10_000; page += 1) {
        const response = await endpoint({ ...parameters, page });
        const mapped = mapPage(response, source);
        if (mapped.issue !== undefined) throw new Error(mapped.issue);
        observations.push(...mapped.observations);
        if (!hasNextPage(page, mapped.observations.length, response))
            return observations;
    }
    throw new Error(`${source.source} pagination exceeded the safety limit.`);
};

const isOctokitEndpoint = (value: unknown): value is Endpoint =>
    typeof value === "function" &&
    typeof (value as { readonly defaults?: unknown }).defaults === "function";

const paginateSource = async (
    client: Octokit,
    endpoint: unknown,
    parameters: Record<string, unknown>,
    source: SourceDefinition,
): Promise<ReadonlyArray<JsonValue>> => {
    // Calling the real REST method directly keeps Octokit's original envelope.
    // Its paginate plugin normalizes object envelopes before map callbacks run,
    // which would discard the combined-status envelope SHA. Lightweight fakes
    // commonly expose only an endpoint token, so those use paginate below.
    if (isOctokitEndpoint(endpoint))
        return paginateDirect(endpoint, parameters, source);
    if (typeof client.paginate !== "function") {
        if (typeof endpoint === "function")
            return paginateDirect(endpoint as Endpoint, parameters, source);
        throw new Error(`${source.source} endpoint is not callable.`);
    }

    const pageIssues: string[] = [];
    let mapperCalls = 0;
    const paginate = client.paginate as unknown as Paginate;
    const returned = await paginate(
        endpoint as Endpoint,
        parameters,
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
            ? [observationFor(value, source.kind, undefined)]
            : [value];
    });

    if (pageIssues.length > 0)
        throw new Error([...new Set(pageIssues)].join(" "));
    return hasReturnedEnvelope || mapperCalls === 0 ? observations : values;
};

const errorMessage = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

const sourceError = (source: string, cause: unknown): PipelineSourceError => ({
    source,
    message: errorMessage(cause),
    rawValues: serializeJson(
        cause instanceof Error
            ? { name: cause.name, message: cause.message }
            : cause,
    ),
});

const collectSource = async (
    client: Octokit,
    source: SourceDefinition,
): Promise<SourceResult> => {
    try {
        const endpoint = endpointFor(client, source);
        return {
            observations: await paginateSource(
                client,
                endpoint,
                source.parameters,
                source,
            ),
            errors: [],
        };
    } catch (cause) {
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
        endpointName: "listForRef",
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
        endpointName: "listSuitesForRef",
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
        endpointName: "getCombinedStatusForRef",
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
        endpointName: "listWorkflowRunsForRepo",
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
): Promise<PipelineSnapshot> => {
    const { owner, name } = parseRepositorySlug(request.repository);
    const sources = sourceDefinitions(owner, name, request);
    const results = await Promise.all(
        sources.map((source) => collectSource(client, source)),
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

export type PipelineSnapshotCollectorOperation = {
    (
        client: Octokit,
        request: PipelineSnapshotRequest,
    ): Promise<PipelineSnapshot>;
    (
        client: Octokit,
        repository: string,
        branch: string,
        commitSha: ExactCommitSha,
    ): Promise<PipelineSnapshot>;
};

export function collectPipelineSnapshot(
    client: Octokit,
    request: PipelineSnapshotRequest,
): Promise<PipelineSnapshot>;
export function collectPipelineSnapshot(
    client: Octokit,
    repository: string,
    branch: string,
    commitSha: ExactCommitSha,
): Promise<PipelineSnapshot>;
export function collectPipelineSnapshot(
    client: Octokit,
    requestOrRepository: PipelineSnapshotRequest | string,
    branch?: string,
    commitSha?: ExactCommitSha,
): Promise<PipelineSnapshot> {
    return collectSnapshot(
        client,
        requestForArguments(requestOrRepository, branch, commitSha),
    );
}

export type PipelineSnapshotCollectorService = {
    readonly collect: PipelineSnapshotCollectorOperation;
    readonly read: PipelineSnapshotCollectorOperation;
};

export type GitHubPipelineSnapshotService = PipelineSnapshotCollectorService;

export const makePipelineSnapshotCollectorService =
    (): PipelineSnapshotCollectorService => ({
        collect: collectPipelineSnapshot,
        read: collectPipelineSnapshot,
    });

export const makeGitHubPipelineSnapshotService =
    makePipelineSnapshotCollectorService;
export const makePipelineSnapshotService = makePipelineSnapshotCollectorService;
export const makePipelineSnapshotCollector =
    makePipelineSnapshotCollectorService;
export const GitHubPipelineSnapshotLive = makePipelineSnapshotCollectorService;
export const PipelineSnapshotCollectorLive =
    makePipelineSnapshotCollectorService;

export type {
    ExactCommitSha,
    PipelineSnapshot,
    PipelineSnapshotRequest,
} from "./pipeline-snapshot.ts";