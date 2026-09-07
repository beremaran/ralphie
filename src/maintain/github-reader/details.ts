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
    createMaintenanceComment,
    createMaintenanceCommentThread,
    createMaintenanceIssue,
    type MaintenanceCommentThread,
    type MaintenanceIssue,
    type MaintenanceSkip,
} from "../snapshot.ts";
import {
    maintenanceCommentInputFromRest,
    maintenanceIssueInputFromRest,
} from "./translate.ts";
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
    readonly issue: MaintenanceIssue;
    readonly thread: MaintenanceCommentThread;
    readonly threadProjection: ThreadPromptProjectionResult;
};

export type MaintainIssueDetail = MaintainableIssueDetail;

export type MaintainReaderDetails = {
    readonly details: ReadonlyArray<MaintainableIssueDetail>;
    readonly issues: ReadonlyArray<MaintenanceIssue>;
    readonly skips: ReadonlyArray<MaintenanceSkip>;
};

export type MaintainableDetailCollection = MaintainReaderDetails;

export type MaintainableSelectedThread = MaintenanceCommentThread;
export type MaintainableIssue = MaintenanceIssue;
export type MaintainableSkip = MaintenanceSkip;

const uniqueIssueNumbers = (
    issueNumbers: ReadonlyArray<number>,
): ReadonlyArray<number> =>
    Object.freeze(
        [...new Set(issueNumbers)]
            .filter((number) => Number.isSafeInteger(number) && number > 0)
            .sort((left, right) => left - right),
    );

const skipThread = (skip: MaintenanceSkip): MaintenanceCommentThread =>
    createMaintenanceCommentThread({
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
    thread: MaintenanceCommentThread,
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
    skip: MaintenanceSkip,
): MaintainableIssueDetail => {
    const thread = skipThread(skip);
    const issue = createMaintenanceIssue({
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
    | { readonly kind: "skip"; readonly skip: MaintenanceSkip }
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
): Promise<MaintenanceCommentThread> => {
    const endpoint = endpointFor(client, "issues", "listComments", repository);
    const endpointName = `repos/{owner}/{repo}/issues/${String(issueNumber)}/comments`;
    let reportedTotal: number | undefined;
    const comments = await paginateMaintainReaderGet({
        repository,
        endpoint: endpointName,
        requestEndpoint: endpoint,
        parameters: { owner, repo, issue_number: issueNumber },
        signal,
        map: (value) =>
            createMaintenanceComment(maintenanceCommentInputFromRest(value)),
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
    return createMaintenanceCommentThread({
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
    readonly skip?: MaintenanceSkip;
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

    const detailInput = maintenanceIssueInputFromRest(
        result.value,
        issueNumber,
    );
    let thread: MaintenanceCommentThread;
    let threadSkip: MaintenanceSkip | undefined;
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
    const issue = createMaintenanceIssue({
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
    const skips: MaintenanceSkip[] = [];
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