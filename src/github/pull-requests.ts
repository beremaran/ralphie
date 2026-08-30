import type { Octokit } from "octokit";

import {
    gitObjectIdSchema,
    pullRequestReviewAttemptSchema,
    type PullRequestReviewAttempt,
} from "../issues/pull-request-review.ts";
import type { ReviewAttempt } from "../issues/recovery.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export type CreateGitHubPullRequestInput = {
    readonly title: string;
    readonly body?: string;
    readonly issueNumber: number;
    /** Defaults to true. Supporting cross-repository PRs only reference the issue. */
    readonly closesIssue?: boolean;
    readonly issueRepository?: string;
    readonly head: string;
    readonly base: string;
};

export type PullRequestSnapshot = {
    readonly number: number;
    readonly url: string;
    readonly baseSha: string;
    readonly headSha: string;
};

export type GitHubPullRequest = {
    readonly number: number;
    readonly url: string;
    readonly merged: boolean;
    readonly headSha: string;
    /** Present when the authoritative response surfaced the PR state. */
    readonly state?: "open" | "closed";
};

export type GitHubPullRequestService = {
    /** Find a matching pull request, creating it only when none exists. */
    readonly createOrFind: (
        client: Octokit,
        repository: string,
        input: CreateGitHubPullRequestInput,
    ) => Promise<GitHubPullRequest>;
    /** Read the authoritative state of a pull request. */
    readonly read: (
        client: Octokit,
        repository: string,
        pullRequestNumber: number,
    ) => Promise<GitHubPullRequest>;
    /** Read immutable review inputs and verify this is still the same PR/base. */
    readonly readSnapshot: (
        client: Octokit,
        repository: string,
        pullRequestNumber: number,
    ) => Promise<PullRequestSnapshot>;
    readonly rereadMatchingSnapshot: (
        client: Octokit,
        repository: string,
        snapshot: PullRequestSnapshot,
    ) => Promise<PullRequestSnapshot>;
    /** Publish head-scoped PR review evidence idempotently. */
    readonly publishPullRequestReviewAttempts: (
        client: Octokit,
        repository: string,
        attempts: ReadonlyArray<PullRequestReviewAttempt>,
    ) => Promise<void>;
    /** Publish each review attempt at most once using its deterministic marker. */
    readonly publishReviewAttempts: (
        client: Octokit,
        repository: string,
        pullRequestNumber: number,
        attempts: ReadonlyArray<ReviewAttempt>,
    ) => Promise<void>;
    /** Merge a pull request when needed and verify the authoritative merged state. */
    readonly merge: (
        client: Octokit,
        repository: string,
        pullRequestNumber: number,
        expectedHeadSha: string,
    ) => Promise<GitHubPullRequest>;
};

const repositoryParameters = (repository: string) => {
    const { owner, name } = parseRepositorySlug(repository);
    return { owner, repo: name };
};

const mutationError = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

const isMerged = (pullRequest: {
    readonly merged?: boolean | null;
    readonly merged_at?: string | null;
}): boolean => pullRequest.merged === true || pullRequest.merged_at != null;

type PullRequestResponse = {
    readonly number: number;
    readonly html_url: string;
    readonly state?: "open" | "closed" | null;
    readonly base?: {
        readonly ref?: string | null;
        readonly sha?: string | null;
    } | null;
    readonly merged?: boolean | null;
    readonly merged_at?: string | null;
    readonly head?: { readonly sha?: string | null } | null;
};

const mapPullRequest = (
    pullRequest: PullRequestResponse,
): GitHubPullRequest | undefined => {
    const headSha = pullRequest.head?.sha?.trim();
    if (!headSha) return undefined;
    return {
        number: pullRequest.number,
        url: pullRequest.html_url,
        merged: isMerged(pullRequest),
        headSha,
        state: pullRequest.state === "closed" ? "closed" : "open",
    };
};

const mapPullRequestSnapshot = (
    pullRequest: PullRequestResponse,
): PullRequestSnapshot | undefined => {
    const baseSha = gitObjectIdSchema.safeParse(pullRequest.base?.sha);
    const headSha = gitObjectIdSchema.safeParse(pullRequest.head?.sha);
    if (!baseSha.success || !headSha.success) return undefined;
    return {
        number: pullRequest.number,
        url: pullRequest.html_url,
        baseSha: baseSha.data,
        headSha: headSha.data,
    };
};

const requirePullRequestSnapshot = (
    pullRequest: PullRequestResponse,
): PullRequestSnapshot => {
    const snapshot = mapPullRequestSnapshot(pullRequest);
    if (snapshot) return snapshot;
    throw new RalphieError({
        message: `Pull request #${pullRequest.number} has no unambiguous base/head SHA.`,
    });
};

const requireMappedPullRequest = (
    pullRequest: PullRequestResponse,
): GitHubPullRequest => {
    const mapped = mapPullRequest(pullRequest);
    if (mapped) return mapped;
    throw new RalphieError({
        message: `Pull request #${pullRequest.number} has no unambiguous head SHA.`,
    });
};

const issueReference = (input: CreateGitHubPullRequestInput): string => {
    const issue = input.issueRepository
        ? `${parseRepositorySlug(input.issueRepository).slug}#${input.issueNumber}`
        : `#${input.issueNumber}`;
    return input.closesIssue === false ? `Tracks ${issue}` : `Closes ${issue}`;
};

const pullRequestBody = (input: CreateGitHubPullRequestInput): string => {
    const body = input.body?.trim() ?? "";
    const reference = issueReference(input);
    if (body.includes(reference)) return body;
    return body.length === 0 ? reference : `${body}\n\n${reference}`;
};

export const pullRequestReviewMarker = (
    pullRequestNumber: number,
    reviewedHeadSha: string,
    attempt: number,
): string =>
    `<!-- ralphie:pr-review pr=${pullRequestNumber} head=${reviewedHeadSha} attempt=${attempt} -->`;

const pullRequestReviewCommentBody = (
    attempt: PullRequestReviewAttempt,
): string =>
    `${pullRequestReviewMarker(attempt.pullRequestNumber, attempt.reviewedHeadSha, attempt.attempt)}\n### Ralphie PR review attempt ${attempt.attempt}\n\n\`\`\`json\n${JSON.stringify(attempt, null, 2)}\n\`\`\``;

const pullRequestReviewFromComment = (
    body: string | null | undefined,
): PullRequestReviewAttempt | undefined => {
    const match = body?.match(
        /<!-- ralphie:pr-review pr=(\d+) head=([0-9a-f]{40}(?:[0-9a-f]{24})?) attempt=(\d+) -->\s*[\s\S]*?```json\s*([\s\S]*?)\s*```/i,
    );
    if (!match) return undefined;
    try {
        const parsed = pullRequestReviewAttemptSchema.parse(
            JSON.parse(match[4] ?? ""),
        );
        return parsed.pullRequestNumber === Number(match[1]) &&
            parsed.reviewedHeadSha.toLowerCase() === match[2]?.toLowerCase() &&
            parsed.attempt === Number(match[3])
            ? parsed
            : undefined;
    } catch {
        return undefined;
    }
};

/** The marker is stable for an attempt, making retries safe after a lost response. */
export const reviewAttemptMarker = (attempt: number): string =>
    `<!-- ralphie:review-attempt=${attempt} -->`;

const reviewCommentBody = (attempt: ReviewAttempt): string =>
    `${reviewAttemptMarker(attempt.attempt)}\n### Ralphie review attempt ${attempt.attempt}\n\n\`\`\`json\n${JSON.stringify(attempt, null, 2)}\n\`\`\``;

const reviewAttemptFromComment = (
    body: string | null | undefined,
): number | undefined => {
    const match = body?.match(/<!-- ralphie:review-attempt=(\d+) -->/);
    if (!match) return undefined;
    const attempt = Number(match[1]);
    return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
};

const findMatchingPullRequest = (
    pullRequests: ReadonlyArray<{
        readonly number: number;
        readonly html_url: string;
        readonly merged?: boolean | null;
        readonly merged_at?: string | null;
        readonly head?: {
            readonly ref?: string | null;
            readonly sha?: string | null;
        } | null;
        readonly base?: { readonly ref?: string | null } | null;
    }>,
    input: CreateGitHubPullRequestInput,
) =>
    pullRequests.find(
        (pullRequest) =>
            pullRequest.head?.ref === input.head &&
            pullRequest.base?.ref === input.base,
    );

type ReviewAttemptParameters = ReturnType<typeof repositoryParameters> & {
    readonly issue_number: number;
};

const isSamePullRequestReview = (
    published: PullRequestReviewAttempt,
    expected: PullRequestReviewAttempt,
): boolean =>
    published.pullRequestNumber === expected.pullRequestNumber &&
    published.baseSha.toLowerCase() === expected.baseSha.toLowerCase() &&
    published.reviewedHeadSha.toLowerCase() ===
        expected.reviewedHeadSha.toLowerCase() &&
    published.attempt === expected.attempt &&
    published.sessionID === expected.sessionID &&
    JSON.stringify(published.decision) === JSON.stringify(expected.decision);

const hasPublishedPullRequestReview = async (
    client: Octokit,
    parameters: ReviewAttemptParameters,
    attempt: PullRequestReviewAttempt,
): Promise<boolean> => {
    const comments = await client.paginate(client.rest.issues.listComments, {
        ...parameters,
        per_page: 100,
    });
    return comments.some((comment) => {
        const published = pullRequestReviewFromComment(comment.body);
        return published ? isSamePullRequestReview(published, attempt) : false;
    });
};

const publishPullRequestReview = async (
    client: Octokit,
    parameters: ReviewAttemptParameters,
    attempt: PullRequestReviewAttempt,
): Promise<void> => {
    if (await hasPublishedPullRequestReview(client, parameters, attempt))
        return;
    try {
        await client.rest.issues.createComment({
            ...parameters,
            body: pullRequestReviewCommentBody(attempt),
        });
    } catch (cause) {
        if (await hasPublishedPullRequestReview(client, parameters, attempt))
            return;
        throw cause;
    }
};

const hasPublishedReviewAttempt = async (
    client: Octokit,
    parameters: ReviewAttemptParameters,
    attempt: ReviewAttempt,
): Promise<boolean> => {
    const comments = await client.paginate(client.rest.issues.listComments, {
        ...parameters,
        per_page: 100,
    });
    return comments.some(
        (comment) => reviewAttemptFromComment(comment.body) === attempt.attempt,
    );
};

const publishReviewAttempt = async (
    client: Octokit,
    parameters: ReviewAttemptParameters,
    attempt: ReviewAttempt,
): Promise<void> => {
    try {
        await client.rest.issues.createComment({
            ...parameters,
            body: reviewCommentBody(attempt),
        });
    } catch (cause) {
        if (await hasPublishedReviewAttempt(client, parameters, attempt))
            return;
        throw cause;
    }
};

type PullRequestParameters = ReturnType<typeof repositoryParameters> & {
    readonly pull_number: number;
};

const requireExpectedHead = (
    pullRequest: PullRequestResponse,
    expectedHeadSha: string,
): GitHubPullRequest => {
    const mapped = requireMappedPullRequest(pullRequest);
    if (mapped.headSha !== expectedHeadSha) {
        throw new RalphieError({
            message: `Pull request #${mapped.number} head changed from ${expectedHeadSha} to ${mapped.headSha}.`,
        });
    }
    return mapped;
};

const mergePullRequest = async (
    client: Octokit,
    parameters: PullRequestParameters,
    pullRequestNumber: number,
    expectedHeadSha: string,
): Promise<GitHubPullRequest> => {
    if (!expectedHeadSha.trim()) {
        throw new RalphieError({
            message: `Pull request #${pullRequestNumber} cannot be merged without an expected head SHA.`,
        });
    }
    const current = await client.rest.pulls.get(parameters);
    if (isMerged(current.data)) return requireMappedPullRequest(current.data);
    if (current.data.state !== "open") {
        throw new RalphieError({
            message: `Pull request #${pullRequestNumber} is closed but not merged.`,
        });
    }
    requireExpectedHead(current.data, expectedHeadSha);
    if (current.data.mergeable !== true) {
        throw new RalphieError({
            message: `Pull request #${pullRequestNumber} is not definitively mergeable.`,
        });
    }

    try {
        await client.rest.pulls.merge({ ...parameters, sha: expectedHeadSha });
    } catch (cause) {
        const reconciled = await client.rest.pulls.get(parameters);
        if (isMerged(reconciled.data))
            return requireMappedPullRequest(reconciled.data);
        throw cause;
    }

    const merged = await client.rest.pulls.get(parameters);
    if (!isMerged(merged.data)) {
        throw new RalphieError({
            message: `Pull request #${pullRequestNumber} did not reach the merged state.`,
        });
    }
    return requireMappedPullRequest(merged.data);
};

export const makeGitHubPullRequestService = (): GitHubPullRequestService => ({
    createOrFind: async (client, repository, input) => {
        try {
            const parameters = repositoryParameters(repository);
            const listMatching = async () => {
                const pullRequests = await client.paginate(
                    client.rest.pulls.list,
                    {
                        ...parameters,
                        state: "all",
                        head: `${parameters.owner}:${input.head}`,
                        base: input.base,
                        per_page: 100,
                    },
                );
                return findMatchingPullRequest(pullRequests, input);
            };

            const readByNumber = async (pullRequestNumber: number) =>
                requireMappedPullRequest(
                    (
                        await client.rest.pulls.get({
                            ...parameters,
                            pull_number: pullRequestNumber,
                        })
                    ).data,
                );
            const resolvePullRequest = (pullRequest: PullRequestResponse) =>
                mapPullRequest(pullRequest) ?? readByNumber(pullRequest.number);

            const matching = await listMatching();
            if (matching) return resolvePullRequest(matching);

            try {
                const created = await client.rest.pulls.create({
                    ...parameters,
                    title: input.title,
                    body: pullRequestBody(input),
                    head: input.head,
                    base: input.base,
                });
                return resolvePullRequest(created.data);
            } catch (cause) {
                const reconciled = await listMatching();
                if (reconciled) return resolvePullRequest(reconciled);
                throw cause;
            }
        } catch (cause) {
            throw mutationError(
                `Failed to create or find a pull request in ${repository}.`,
                cause,
            );
        }
    },

    read: async (client, repository, pullRequestNumber) => {
        try {
            const response = await client.rest.pulls.get({
                ...repositoryParameters(repository),
                pull_number: pullRequestNumber,
            });
            return requireMappedPullRequest(response.data);
        } catch (cause) {
            throw mutationError(
                `Failed to read pull request #${pullRequestNumber} in ${repository}.`,
                cause,
            );
        }
    },

    readSnapshot: async (client, repository, pullRequestNumber) => {
        try {
            const response = await client.rest.pulls.get({
                ...repositoryParameters(repository),
                pull_number: pullRequestNumber,
            });
            return requirePullRequestSnapshot(response.data);
        } catch (cause) {
            throw mutationError(
                `Failed to read pull request #${pullRequestNumber} snapshot in ${repository}.`,
                cause,
            );
        }
    },

    rereadMatchingSnapshot: async (client, repository, snapshot) => {
        const response = await client.rest.pulls.get({
            ...repositoryParameters(repository),
            pull_number: snapshot.number,
        });
        const current = requirePullRequestSnapshot(response.data);
        if (
            current.number !== snapshot.number ||
            current.baseSha !== snapshot.baseSha
        ) {
            throw new RalphieError({
                message: `Pull request #${snapshot.number} no longer matches its captured base.`,
            });
        }
        return current;
    },

    publishPullRequestReviewAttempts: async (client, repository, attempts) => {
        try {
            for (const rawAttempt of attempts) {
                const attempt =
                    pullRequestReviewAttemptSchema.parse(rawAttempt);
                const parameters = {
                    ...repositoryParameters(repository),
                    issue_number: attempt.pullRequestNumber,
                };
                await publishPullRequestReview(client, parameters, attempt);
            }
        } catch (cause) {
            throw mutationError(
                "Failed to publish pull request review evidence.",
                cause,
            );
        }
    },

    publishReviewAttempts: async (
        client,
        repository,
        pullRequestNumber,
        attempts,
    ) => {
        try {
            const parameters = {
                ...repositoryParameters(repository),
                issue_number: pullRequestNumber,
            };
            const comments = await client.paginate(
                client.rest.issues.listComments,
                {
                    ...parameters,
                    per_page: 100,
                },
            );
            const published = new Set(
                comments
                    .map((comment) => reviewAttemptFromComment(comment.body))
                    .filter(
                        (attempt): attempt is number => attempt !== undefined,
                    ),
            );

            for (const attempt of attempts) {
                if (published.has(attempt.attempt)) continue;
                await publishReviewAttempt(client, parameters, attempt);
                published.add(attempt.attempt);
            }
        } catch (cause) {
            throw mutationError(
                `Failed to publish review attempts on pull request #${pullRequestNumber} in ${repository}.`,
                cause,
            );
        }
    },

    merge: async (client, repository, pullRequestNumber, expectedHeadSha) => {
        try {
            const parameters = {
                ...repositoryParameters(repository),
                pull_number: pullRequestNumber,
            };
            return await mergePullRequest(
                client,
                parameters,
                pullRequestNumber,
                expectedHeadSha,
            );
        } catch (cause) {
            throw mutationError(
                `Failed to merge pull request #${pullRequestNumber} in ${repository}.`,
                cause,
            );
        }
    },
});

export const GitHubPullRequestsLive = makeGitHubPullRequestService;