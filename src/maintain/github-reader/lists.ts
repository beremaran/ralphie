/**
 * Read-only repository, label-catalog, and open-issue-summary collection for
 * the maintenance snapshot reader.
 *
 * This module owns exactly one list phase. It resolves each endpoint once,
 * sends every request through the diagnostics pagination boundary, and keeps
 * the result independent from the small issue queue service in
 * `src/github/issues.ts`.
 */
import type { Octokit } from "octokit";

import {
    MaintainGitHubReaderDiagnosticError,
    paginateMaintainReaderGet,
    throwIfAborted,
    type MaintainReaderEndpoint,
} from "./diagnostics.ts";
import {
    normalizeMaintainableActor,
    normalizeMaintainableIssueState,
    normalizeMaintainableLabel,
    type MaintainableActor,
    type MaintainableIssueState,
    type MaintainableLabel,
} from "../../maintain-issues-snapshot.ts";
import { parseRepositorySlug } from "../../github/repository.ts";

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

const numberValue = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : 0;

const cloneAndFreeze = <T>(
    value: T,
    seen = new WeakMap<object, unknown>(),
): T => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value) as T;
    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        seen.set(value, copy);
        for (const entry of value) copy.push(cloneAndFreeze(entry, seen));
        return Object.freeze(copy) as T;
    }
    const copy: RecordLike = {};
    seen.set(value, copy);
    for (const key of Object.keys(value))
        copy[key] = cloneAndFreeze((value as RecordLike)[key], seen);
    return Object.freeze(copy) as T;
};

const frozenRaw = (value: unknown): Readonly<Record<string, unknown>> =>
    isRecord(value)
        ? cloneAndFreeze(value)
        : Object.freeze({ value: cloneAndFreeze(value) });

export type MaintainRepositoryIdentity = {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly htmlUrl: string;
    /** The unmodified REST `default_branch` value, including unknown shapes. */
    readonly rawDefaultBranch: unknown;
    /** A deep-frozen copy retaining every unknown REST response field. */
    readonly raw: Readonly<Record<string, unknown>>;
};

export type MaintainableRepositoryIdentity = MaintainRepositoryIdentity;

export const mapMaintainRepositoryIdentity = (
    value: unknown,
    repository = "",
): MaintainRepositoryIdentity => {
    const source = isRecord(value) ? value : {};
    const rawDefaultBranch = source.default_branch;
    const defaultBranch = text(rawDefaultBranch);
    const fullName =
        text(source.full_name) || text(source.fullName) || text(repository);
    const htmlUrl = text(source.html_url) || text(source.htmlUrl);
    return Object.freeze({
        fullName,
        defaultBranch,
        htmlUrl,
        rawDefaultBranch: cloneAndFreeze(rawDefaultBranch),
        raw: frozenRaw(source),
    });
};

export const normalizeMaintainRepositoryIdentity =
    mapMaintainRepositoryIdentity;
export const mapRepositoryIdentity = mapMaintainRepositoryIdentity;

export type MaintainableIssueSummary = {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly url: string;
    readonly htmlUrl: string;
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly author: MaintainableActor | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly commentCount: number;
    readonly state: MaintainableIssueState;
    readonly isOpen: boolean;
    /** Deep-frozen REST evidence, including fields not used by comparisons. */
    readonly raw: Readonly<Record<string, unknown>>;
};

export type MaintainIssueSummary = MaintainableIssueSummary;

const sortedLabels = (value: unknown): ReadonlyArray<MaintainableLabel> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const labels = value.map((entry) => normalizeMaintainableLabel(entry));
    labels.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    return Object.freeze(labels);
};

export const mapMaintainableIssueSummary = (
    value: unknown,
): MaintainableIssueSummary => {
    const source = isRecord(value) ? value : {};
    const state = normalizeMaintainableIssueState(source.state);
    return Object.freeze({
        number: numberValue(source.number),
        nodeId: text(source.node_id) || text(source.nodeId),
        title: text(source.title),
        url: text(source.html_url) || text(source.url),
        htmlUrl:
            text(source.html_url) || text(source.htmlUrl) || text(source.url),
        labels: sortedLabels(source.labels),
        author: normalizeMaintainableActor(
            source.user ?? source.author ?? null,
        ),
        createdAt: text(source.created_at) || text(source.createdAt),
        updatedAt: text(source.updated_at) || text(source.updatedAt),
        commentCount: numberValue(source.comments),
        state,
        isOpen: state === "open",
        raw: frozenRaw(source),
    });
};

export const normalizeMaintainableIssueSummary = mapMaintainableIssueSummary;
export const mapIssueSummary = mapMaintainableIssueSummary;

export type MaintainReaderLists = {
    readonly repository: MaintainRepositoryIdentity;
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly openIssueSummaries: ReadonlyArray<MaintainableIssueSummary>;
};

export type MaintainableListCollection = MaintainReaderLists;
export type MaintainRepositoryLists = MaintainReaderLists;

const endpointFor = (
    client: Octokit,
    namespace: string,
    name: string,
    repository: string,
): MaintainReaderEndpoint => {
    const rest = (client as unknown as RecordLike).rest;
    const group = isRecord(rest) ? rest[namespace] : undefined;
    const endpoint = isRecord(group) ? group[name] : undefined;
    if (typeof endpoint !== "function") {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint: `${namespace}.${name}`,
            message: "endpoint is not callable.",
        });
    }
    return endpoint.bind(group) as MaintainReaderEndpoint;
};

const dataFrom = (
    response: unknown,
    repository: string,
    endpoint: string,
): unknown => {
    if (!isRecord(response) || !hasOwn(response, "data")) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint,
            message: "response did not contain a JSON data envelope.",
            cause: response,
        });
    }
    const status = response.status;
    if (typeof status === "number" && status >= 400) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint,
            message: `GitHub returned HTTP ${String(status)}.`,
            cause: response,
        });
    }
    return response.data;
};

const readRepository = async (
    client: Octokit,
    repository: string,
    signal: AbortSignal | undefined,
): Promise<MaintainRepositoryIdentity> => {
    const { owner, name } = parseRepositorySlug(repository);
    const endpointName = "repos/{owner}/{repo}";
    const endpoint = endpointFor(client, "repos", "get", repository);
    let response: unknown;
    try {
        throwIfAborted(signal);
        response = await endpoint({
            owner,
            repo: name,
            ...(signal === undefined ? {} : { request: { signal } }),
        });
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        if (cause instanceof MaintainGitHubReaderDiagnosticError) throw cause;
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint: endpointName,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
        });
    }
    throwIfAborted(signal);
    const data = dataFrom(response, repository, endpointName);
    if (!isRecord(data)) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint: endpointName,
            message: "response data was not an object.",
            cause: data,
        });
    }
    return mapMaintainRepositoryIdentity(data, repository);
};

const sortedCatalog = (
    labels: ReadonlyArray<MaintainableLabel>,
): ReadonlyArray<MaintainableLabel> =>
    Object.freeze(
        [...labels].sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
    );

const deduplicateSummaries = (
    values: ReadonlyArray<MaintainableIssueSummary>,
): ReadonlyArray<MaintainableIssueSummary> => {
    const byNumber = new Map<number, MaintainableIssueSummary>();
    for (const value of values) {
        if (!byNumber.has(value.number)) byNumber.set(value.number, value);
    }
    return Object.freeze(
        [...byNumber.values()].sort(
            (left, right) => left.number - right.number,
        ),
    );
};

/**
 * Run the complete list phase once. The three REST resources are intentionally
 * collected in sequence so aborts and request counts are observable at each
 * phase boundary.
 */
export const collectMaintainReaderLists = async (
    client: Octokit,
    repository: string,
    signal?: AbortSignal,
): Promise<MaintainReaderLists> => {
    const { owner, name } = parseRepositorySlug(repository);
    const identity = await readRepository(client, repository, signal);
    throwIfAborted(signal);

    const labelsEndpoint = endpointFor(
        client,
        "issues",
        "listLabelsForRepo",
        repository,
    );
    const labels = await paginateMaintainReaderGet({
        repository,
        endpoint: "repos/{owner}/{repo}/labels",
        requestEndpoint: labelsEndpoint,
        parameters: { owner, repo: name },
        signal,
        map: (value) => normalizeMaintainableLabel(value),
    });
    throwIfAborted(signal);

    const issueEndpoint = endpointFor(
        client,
        "issues",
        "listForRepo",
        repository,
    );
    const issueValues = await paginateMaintainReaderGet({
        repository,
        endpoint: "repos/{owner}/{repo}/issues",
        requestEndpoint: issueEndpoint,
        parameters: { owner, repo: name, state: "open" },
        signal,
    });
    const summaries = issueValues
        .filter((value) => !(isRecord(value) && hasOwn(value, "pull_request")))
        .map((value) => mapMaintainableIssueSummary(value));
    throwIfAborted(signal);
    return Object.freeze({
        repository: identity,
        labels: sortedCatalog(labels),
        openIssueSummaries: deduplicateSummaries(summaries),
    });
};

export const loadMaintainReaderLists = collectMaintainReaderLists;
export const collectMaintainableLists = collectMaintainReaderLists;