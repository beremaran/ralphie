import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import type { GitHubIssue } from "./issues.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Reasons accepted by GitHub when closing an issue. */
export enum GitHubIssueCloseReason {
    Completed = "completed",
    NotPlanned = "not_planned",
    Duplicate = "duplicate",
}

export enum GitHubMutationRecoveryOutcome {
    RecoveryRequired = "recovery-required",
}

/** A mutation may have reached GitHub even though its response was lost. */
export class GitHubMutationRecoveryError extends RalphieError {
    override readonly _tag = "GitHubMutationRecoveryError";
    readonly outcome = GitHubMutationRecoveryOutcome.RecoveryRequired;
    readonly operation: string;

    constructor(input: {
        readonly message: string;
        readonly operation: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitHubMutationRecoveryError";
        this.operation = input.operation;
    }
}

export type CreateGitHubIssueInput = {
    readonly title: string;
    readonly body: string;
};

export type UpdateGitHubIssueInput = {
    readonly title?: string;
    readonly body?: string;
};

export type GitHubIssueMutationService = {
    readonly create: (
        client: Octokit,
        repository: string,
        input: CreateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly update: (
        client: Octokit,
        repository: string,
        issueNumber: number,
        input: UpdateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly close: (
        client: Octokit,
        repository: string,
        issueNumber: number,
        reason: GitHubIssueCloseReason,
    ) => Promise<GitHubIssue>;
};

const mapIssue = (issue: {
    readonly number: number;
    readonly title: string;
    readonly html_url: string;
    readonly body?: string | null;
    readonly labels?: ReadonlyArray<
        | string
        | {
              readonly name?: string | null;
          }
    >;
}): GitHubIssue => ({
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    body: issue.body ?? null,
    labels:
        issue.labels?.flatMap((label) => {
            if (typeof label === "string") return [label];
            return label.name ? [label.name] : [];
        }) ?? [],
});

const repositoryParameters = (repository: string) => {
    const { slug } = parseRepositorySlug(repository);
    const [owner, repo] = slug.split("/") as [string, string];
    return { owner, repo };
};

const mutationError = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

const updateAndReconcileClose = async (
    client: Octokit,
    parameters: ReturnType<typeof repositoryParameters> & {
        readonly issue_number: number;
    },
    reason: GitHubIssueCloseReason,
): Promise<GitHubIssue> => {
    try {
        const response = await client.rest.issues.update({
            ...parameters,
            state: "closed",
            state_reason: reason,
        });
        return mapIssue(response.data);
    } catch (cause) {
        // The update may have reached GitHub even when its response was lost.
        const reconciled = await client.rest.issues.get(parameters);
        if (
            reconciled.data.state === "closed" &&
            reconciled.data.state_reason === reason
        ) {
            return mapIssue(reconciled.data);
        }
        throw cause;
    }
};

const closeIssue = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    reason: GitHubIssueCloseReason,
): Promise<GitHubIssue> => {
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
    };
    const current = await client.rest.issues.get(parameters);
    if (current.data.state === "closed") {
        if (current.data.state_reason !== reason) {
            throw new RalphieError({
                message: `Issue #${issueNumber} is already closed with reason ${current.data.state_reason ?? "unknown"}, not ${reason}.`,
            });
        }
        return mapIssue(current.data);
    }
    return updateAndReconcileClose(client, parameters, reason);
};

export const makeGitHubIssueMutationsService =
    (): GitHubIssueMutationService => ({
        create: async (client, repository, input) => {
            try {
                const response = await client.rest.issues.create({
                    ...repositoryParameters(repository),
                    title: input.title,
                    body: input.body,
                });
                return mapIssue(response.data);
            } catch (cause) {
                throw mutationError(
                    `Failed to create an issue in ${repository}.`,
                    cause,
                );
            }
        },

        update: async (client, repository, issueNumber, input) => {
            try {
                if (input.title === undefined && input.body === undefined) {
                    throw new RalphieError({
                        message: "Issue update requires a title or body.",
                    });
                }

                const response = await client.rest.issues.update({
                    ...repositoryParameters(repository),
                    issue_number: issueNumber,
                    ...(input.title === undefined
                        ? {}
                        : { title: input.title }),
                    ...(input.body === undefined ? {} : { body: input.body }),
                });
                return mapIssue(response.data);
            } catch (cause) {
                throw mutationError(
                    `Failed to update issue #${issueNumber} in ${repository}.`,
                    cause,
                );
            }
        },

        close: async (client, repository, issueNumber, reason) => {
            try {
                return await closeIssue(
                    client,
                    repository,
                    issueNumber,
                    reason,
                );
            } catch (cause) {
                throw mutationError(
                    `Failed to close issue #${issueNumber} in ${repository}.`,
                    cause,
                );
            }
        },
    });

export const GitHubIssueMutationsLive = makeGitHubIssueMutationsService;