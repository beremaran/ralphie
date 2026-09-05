/**
 * Read-only selected-issue detail and comment-thread collection for the
 * maintenance snapshot reader.
 *
 * Detail requests are intentionally sequential and use the same injected
 * Octokit client as the list phase. A record-level 301/410/403/404 is retained
 * as a typed issue skip; diagnostics and aborts still fail the operation.
 */
import type { Octokit } from "octokit";

import {
    MaintainGitHubReaderDiagnosticError,
    paginateMaintainReaderGet,
    throwIfAborted,
    type MaintainReaderEndpoint,
} from "./diagnostics.ts";
import {
    classifyPullRequestRecord,
    classifyRecordUnavailable,
} from "./skips.ts";
import {
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    type MaintainableIssue,
    type MaintainableSkip,
    type MaintainableSelectedThread,
} from "../../maintain-issues-snapshot.ts";
import {
    projectThreadPrompt,
    type ThreadPromptProjectionResult,
} from "../../maintain-thread-projection.ts";
import { parseRepositorySlug } from "../../github/repository.ts";

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const statusFrom = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const nested = isRecord(value.response) ? value.response.status : undefined;
    const status = nested ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

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

const detailInputFor = (
    value: RecordLike,
    fallbackNumber: number,
): RecordLike => ({
    number: value.number ?? fallbackNumber,
    nodeId: value.node_id ?? value.nodeId,
    title: value.title,
    body: value.body,
    url: value.html_url ?? value.htmlUrl ?? value.url,
    state: value.state,
    author: value.user ?? value.author ?? null,
    authorAssociation: value.author_association ?? value.authorAssociation,
    labels: value.labels,
    assignees: value.assignees,
    milestone: value.milestone,
    locked: value.locked,
    createdAt: value.created_at ?? value.createdAt,
    updatedAt: value.updated_at ?? value.updatedAt,
});

const commentInputFor = (value: unknown): RecordLike => {
    const source = isRecord(value) ? value : {};
    return {
        id: source.id ?? source.database_id ?? source.databaseId,
        nodeId: source.node_id ?? source.nodeId,
        url: source.html_url ?? source.htmlUrl ?? source.url,
        author: source.user ?? source.author ?? null,
        authorAssociation:
            source.author_association ?? source.authorAssociation,
        body: source.body ?? source.content,
        content: source.body ?? source.content,
        createdAt: source.created_at ?? source.createdAt,
        updatedAt: source.updated_at ?? source.updatedAt,
    };
};

const responseData = (
    response: unknown,
    repository: string,
    endpoint: string,
    page?: number,
): unknown => {
    if (!isRecord(response) || !hasOwn(response, "data")) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint,
            ...(page === undefined ? {} : { page }),
            message: "response did not contain a JSON data envelope.",
            cause: response,
        });
    }
    const status = statusFrom(response);
    if (status !== undefined && status >= 400) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint,
            ...(page === undefined ? {} : { page }),
            message: `GitHub returned HTTP ${String(status)}.`,
            cause: response,
        });
    }
    return response.data;
};

export type MaintainReaderDetailOptions = {
    readonly commentPromptLimit?: number;
    readonly threadPromptLimit?: number;
    readonly aggregatePromptLimit?: number;
};

export const DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT = 4_000;
export const DEFAULT_MAINTAIN_THREAD_PROMPT_LIMIT = 32_000;
export const DEFAULT_MAINTAIN_AGGREGATE_PROMPT_LIMIT = 2_000;

export type MaintainableIssueDetail = {
    readonly issue: MaintainableIssue;
    readonly thread: MaintainableSelectedThread;
    readonly threadProjection: ThreadPromptProjectionResult;
};

export type MaintainIssueDetail = MaintainableIssueDetail;

export type MaintainReaderDetails = {
    readonly details: ReadonlyArray<MaintainableIssueDetail>;
    readonly issues: ReadonlyArray<MaintainableIssue>;
    readonly skips: ReadonlyArray<MaintainableSkip>;
};

export type MaintainableDetailCollection = MaintainReaderDetails;

const uniqueIssueNumbers = (
    issueNumbers: ReadonlyArray<number>,
): ReadonlyArray<number> =>
    Object.freeze(
        [...new Set(issueNumbers)]
            .filter((number) => Number.isSafeInteger(number) && number > 0)
            .sort((left, right) => left - right),
    );

const skipThread = (skip: MaintainableSkip): MaintainableSelectedThread =>
    createMaintainableThread({
        comments: [],
        totalCount: 0,
        complete: false,
        availability: {
            kind: "unavailable",
            reason: skip.reason,
            detail: skip.detail,
        },
    });

const project = (
    thread: MaintainableSelectedThread,
    options: MaintainReaderDetailOptions,
): ThreadPromptProjectionResult =>
    projectThreadPrompt({
        thread,
        commentPromptLimit:
            options.commentPromptLimit ?? DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT,
        threadPromptLimit:
            options.threadPromptLimit ?? DEFAULT_MAINTAIN_THREAD_PROMPT_LIMIT,
        aggregatePromptLimit:
            options.aggregatePromptLimit ??
            DEFAULT_MAINTAIN_AGGREGATE_PROMPT_LIMIT,
    });

const skippedDetail = (
    issueNumber: number,
    skip: MaintainableSkip,
): MaintainableIssueDetail => {
    const thread = skipThread(skip);
    const issue = createMaintainableIssue({
        number: issueNumber,
        skip,
        selectedThread: thread,
    });
    return {
        issue,
        thread: issue.selectedThread,
        threadProjection: project(issue.selectedThread, {}),
    };
};

const readDetailRecord = async (
    endpoint: MaintainReaderEndpoint,
    repository: string,
    owner: string,
    repo: string,
    issueNumber: number,
    signal: AbortSignal | undefined,
): Promise<
    | { readonly kind: "record"; readonly value: RecordLike }
    | { readonly kind: "skip"; readonly skip: MaintainableSkip }
> => {
    const endpointName = `repos/{owner}/{repo}/issues/${String(issueNumber)}`;
    let response: unknown;
    try {
        response = await endpoint({
            owner,
            repo,
            issue_number: issueNumber,
            ...(signal === undefined ? {} : { request: { signal } }),
        });
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        const skip = classifyRecordUnavailable(cause, issueNumber, repository);
        return { kind: "skip", skip };
    }
    throwIfAborted(signal);
    const status = statusFrom(response);
    if (status !== undefined && status >= 400) {
        return {
            kind: "skip",
            skip: classifyRecordUnavailable(response, issueNumber, repository),
        };
    }
    const data = responseData(response, repository, endpointName);
    if (!isRecord(data)) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint: endpointName,
            message: "response data was not an issue object.",
            cause: data,
        });
    }
    const pullRequestSkip = classifyPullRequestRecord(data, issueNumber);
    return pullRequestSkip === undefined
        ? { kind: "record", value: data }
        : { kind: "skip", skip: pullRequestSkip };
};

const readComments = async (
    client: Octokit,
    repository: string,
    owner: string,
    repo: string,
    issueNumber: number,
    signal: AbortSignal | undefined,
): Promise<MaintainableSelectedThread> => {
    const endpoint = endpointFor(client, "issues", "listComments", repository);
    const endpointName = `repos/{owner}/{repo}/issues/${String(issueNumber)}/comments`;
    let reportedTotal: number | undefined;
    const comments = await paginateMaintainReaderGet({
        repository,
        endpoint: endpointName,
        requestEndpoint: endpoint,
        parameters: { owner, repo, issue_number: issueNumber },
        signal,
        map: (value) => createMaintainableComment(commentInputFor(value)),
        onPage: ({ totalCount }) => {
            if (totalCount !== undefined) reportedTotal = totalCount;
        },
    });
    const totalCount = reportedTotal ?? comments.length;
    if (totalCount < comments.length) {
        throw new MaintainGitHubReaderDiagnosticError({
            repository,
            endpoint: endpointName,
            message: "comment total_count was smaller than fetched comments.",
        });
    }
    return createMaintainableThread({
        comments,
        totalCount,
        complete: true,
    });
};

const collectOneDetail = async (
    client: Octokit,
    repository: string,
    owner: string,
    repo: string,
    issueNumber: number,
    signal: AbortSignal | undefined,
    options: MaintainReaderDetailOptions,
): Promise<{
    readonly detail: MaintainableIssueDetail;
    readonly skip?: MaintainableSkip;
}> => {
    throwIfAborted(signal);
    const detailEndpoint = endpointFor(client, "issues", "get", repository);
    const result = await readDetailRecord(
        detailEndpoint,
        repository,
        owner,
        repo,
        issueNumber,
        signal,
    );
    if (result.kind === "skip") {
        return {
            detail: skippedDetail(issueNumber, result.skip),
            skip: result.skip,
        };
    }

    const detailInput = detailInputFor(result.value, issueNumber);
    let thread: MaintainableSelectedThread;
    let threadSkip: MaintainableSkip | undefined;
    try {
        thread = await readComments(
            client,
            repository,
            owner,
            repo,
            issueNumber,
            signal,
        );
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        threadSkip = classifyRecordUnavailable(cause, issueNumber, repository);
        thread = skipThread(threadSkip);
    }
    const issue = createMaintainableIssue({
        ...detailInput,
        selectedThread: thread,
        ...(threadSkip === undefined ? {} : { skip: threadSkip }),
    });
    throwIfAborted(signal);
    return {
        detail: {
            issue,
            thread: issue.selectedThread,
            threadProjection: project(issue.selectedThread, options),
        },
        ...(threadSkip === undefined ? {} : { skip: threadSkip }),
    };
};

/** Collect selected issue details and complete comment threads in one pass. */
export const collectMaintainReaderDetails = async (
    client: Octokit,
    repository: string,
    issueNumbers: ReadonlyArray<number>,
    signal?: AbortSignal,
    options: MaintainReaderDetailOptions = {},
): Promise<MaintainReaderDetails> => {
    const { owner, name } = parseRepositorySlug(repository);
    const details: MaintainableIssueDetail[] = [];
    const skips: MaintainableSkip[] = [];
    for (const issueNumber of uniqueIssueNumbers(issueNumbers)) {
        const result = await collectOneDetail(
            client,
            repository,
            owner,
            name,
            issueNumber,
            signal,
            options,
        );
        details.push(result.detail);
        if (result.skip !== undefined) skips.push(result.skip);
        throwIfAborted(signal);
    }
    return Object.freeze({
        details: Object.freeze(details),
        issues: Object.freeze(details.map((detail) => detail.issue)),
        skips: Object.freeze(skips),
    });
};

export const loadMaintainReaderDetails = collectMaintainReaderDetails;
export const collectMaintainableDetails = collectMaintainReaderDetails;