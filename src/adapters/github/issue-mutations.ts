import type { Octokit } from "octokit";

import { RalphieError } from "../../shared/error.ts";
import { mapGitHubIssue } from "./issues.ts";
import type { GitHubIssue } from "../../core/domain/github.ts";
import type {
    GitHubIssueCloseReason,
    GitHubIssueMutationService,
} from "../../core/ports/github.ts";
import { parseRepositorySlug } from "../../core/domain/repository.ts";

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
        return mapGitHubIssue(response.data);
    } catch (cause) {
        // The update may have reached GitHub even when its response was lost.
        const reconciled = await client.rest.issues.get(parameters);
        if (
            reconciled.data.state === "closed" &&
            reconciled.data.state_reason === reason
        ) {
            return mapGitHubIssue(reconciled.data);
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
        return mapGitHubIssue(current.data);
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
                return mapGitHubIssue(response.data);
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
                return mapGitHubIssue(response.data);
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