import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import { mapGitHubIssue, type GitHubIssue } from "./issues.ts";
import { parseRepositorySlug } from "./repository.ts";

/**
 * Deterministic GitHub domain service for native issue hierarchy and
 * dependencies. Decomposition uses these operations to attach generated
 * children as native sub-issues and to represent `dependsOn` edges with
 * native `blocked_by` relationships instead of body-only links.
 *
 * The underlying REST endpoints require the numeric issue id (not the issue
 * number), so every mutation resolves the id from a deterministic GET before
 * posting. Unsupported servers (for example GitHub Enterprise without the
 * feature) or insufficient permissions produce actionable errors; nothing
 * silently degrades to body-link semantics.
 */
export type GitHubIssueRelationshipService = {
    /** List the native sub-issues currently attached to an issue. */
    readonly listSubIssues: (
        client: Octokit,
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /** The native parent of an issue, or `undefined` when it has none. */
    readonly parentOf: (
        client: Octokit,
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue | undefined>;
    /**
     * Attach a child to a parent as a native sub-issue. Idempotent when the
     * child is already attached to the same parent; a child attached to a
     * different parent fails closed instead of being silently reparented.
     */
    readonly attachSubIssue: (
        client: Octokit,
        repository: string,
        parentIssueNumber: number,
        childIssueNumber: number,
    ) => Promise<void>;
    /** List the native issues blocking the given issue. */
    readonly listBlockedBy: (
        client: Octokit,
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /**
     * Add a native `blocked_by` relationship. Idempotent when the dependency
     * already exists.
     */
    readonly addBlockedBy: (
        client: Octokit,
        repository: string,
        issueNumber: number,
        blockerIssueNumber: number,
    ) => Promise<void>;
};

const repositoryParameters = (repository: string) => {
    const { slug } = parseRepositorySlug(repository);
    const [owner, repo] = slug.split("/") as [string, string];
    return { owner, repo };
};

const relationshipError = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

const isNotFound = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404;

/** Resolve the numeric GitHub issue id required by the relationship APIs. */
const issueId = async (
    client: Octokit,
    parameters: ReturnType<typeof repositoryParameters>,
    issueNumber: number,
): Promise<number> => {
    try {
        const response = await client.rest.issues.get({
            ...parameters,
            issue_number: issueNumber,
        });
        if (!Number.isInteger(response.data.id)) {
            throw new RalphieError({
                message: `GitHub returned issue #${issueNumber} without a numeric id.`,
            });
        }
        return response.data.id;
    } catch (cause) {
        throw relationshipError(
            `Failed to resolve the GitHub identifier for issue #${issueNumber}.`,
            cause,
        );
    }
};

const parentOf = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
): Promise<GitHubIssue | undefined> => {
    const parameters = repositoryParameters(repository);
    try {
        const response = await client.request(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
            {
                ...parameters,
                issue_number: issueNumber,
            },
        );
        return mapGitHubIssue(response.data);
    } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw relationshipError(
            `Failed to read the native parent of issue #${issueNumber}; this requires GitHub sub-issues support.`,
            cause,
        );
    }
};

const listSubIssues = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
): Promise<ReadonlyArray<GitHubIssue>> => {
    const parameters = repositoryParameters(repository);
    try {
        const response = await client.request(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
            {
                ...parameters,
                issue_number: issueNumber,
                per_page: 100,
            },
        );
        const records = response.data as ReadonlyArray<
            Parameters<typeof mapGitHubIssue>[0]
        >;
        return records.map((record) => mapGitHubIssue(record));
    } catch (cause) {
        throw relationshipError(
            `Failed to list the native sub-issues of #${issueNumber}; this requires GitHub sub-issues support.`,
            cause,
        );
    }
};

const attachSubIssue = async (
    client: Octokit,
    repository: string,
    parentIssueNumber: number,
    childIssueNumber: number,
): Promise<void> => {
    const parameters = repositoryParameters(repository);
    const current = await parentOf(client, repository, childIssueNumber);
    if (current !== undefined) {
        if (current.number === parentIssueNumber) return;
        throw new RalphieError({
            message: `Issue #${childIssueNumber} is already a native sub-issue of #${current.number}, not #${parentIssueNumber}.`,
        });
    }
    const childId = await issueId(client, parameters, childIssueNumber);
    try {
        await client.request(
            "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
            {
                ...parameters,
                issue_number: parentIssueNumber,
                sub_issue_id: childId,
            },
        );
    } catch (cause) {
        // The request may have reached GitHub even when its response was lost.
        let reconciled: GitHubIssue | undefined;
        try {
            reconciled = await parentOf(client, repository, childIssueNumber);
        } catch {
            reconciled = undefined;
        }
        if (reconciled?.number === parentIssueNumber) return;
        throw relationshipError(
            `Failed to attach issue #${childIssueNumber} as a native sub-issue of #${parentIssueNumber}; this requires GitHub sub-issues support and issue write permission.`,
            cause,
        );
    }
};

const listBlockedBy = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
): Promise<ReadonlyArray<GitHubIssue>> => {
    const parameters = repositoryParameters(repository);
    try {
        const response = await client.request(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
            {
                ...parameters,
                issue_number: issueNumber,
                per_page: 100,
            },
        );
        const records = response.data as ReadonlyArray<
            Parameters<typeof mapGitHubIssue>[0]
        >;
        return records.map((record) => mapGitHubIssue(record));
    } catch (cause) {
        throw relationshipError(
            `Failed to list the native dependencies blocking #${issueNumber}; this requires GitHub issue-dependencies support.`,
            cause,
        );
    }
};

const addBlockedBy = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    blockerIssueNumber: number,
): Promise<void> => {
    const parameters = repositoryParameters(repository);
    const existing = await listBlockedBy(client, repository, issueNumber);
    if (existing.some((issue) => issue.number === blockerIssueNumber)) return;
    const blockerId = await issueId(client, parameters, blockerIssueNumber);
    try {
        await client.request(
            "POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
            {
                ...parameters,
                issue_number: issueNumber,
                issue_id: blockerId,
            },
        );
    } catch (cause) {
        // The request may have reached GitHub even when its response was lost.
        let reconciled: ReadonlyArray<GitHubIssue> = [];
        try {
            reconciled = await listBlockedBy(client, repository, issueNumber);
        } catch {
            reconciled = [];
        }
        if (reconciled.some((issue) => issue.number === blockerIssueNumber)) {
            return;
        }
        throw relationshipError(
            `Failed to mark issue #${issueNumber} as blocked by #${blockerIssueNumber}; this requires GitHub issue-dependencies support and issue write permission.`,
            cause,
        );
    }
};

export const makeGitHubIssueRelationshipService =
    (): GitHubIssueRelationshipService => ({
        listSubIssues,
        parentOf,
        attachSubIssue,
        listBlockedBy,
        addBlockedBy,
    });

export const GitHubIssueRelationshipsLive = makeGitHubIssueRelationshipService;