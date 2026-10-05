import type { Octokit } from "octokit";

import {
    GitHubMutationRecoveryError,
    type GitHubHandOffInput,
    type GitHubHandOffResult,
    type GitHubHandOffService,
} from "../ports.ts";
import { RalphieError } from "../../shared/error.ts";
import { parseRepositorySlug } from "../repository.ts";
import type { GitHubSession } from "./session.ts";

export const HAND_OFF_MARKER = "ralphie:hand-off";

export const handOffMarker = (issueNumber: number): string =>
    `<!-- ${HAND_OFF_MARKER} issue=${issueNumber} -->`;

/** The comment body as posted: the caller's text, then a hidden marker. */
export const renderHandOffBody = (issueNumber: number, body: string): string =>
    `${body.trimEnd()}\n\n${handOffMarker(issueNumber)}`;

const repositoryParameters = (repository: string) => {
    const { owner, name } = parseRepositorySlug(repository);
    return { owner, repo: name };
};

const validateInput = (
    issueNumber: number,
    input: GitHubHandOffInput,
): void => {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new RalphieError({
            message: `Invalid hand-off issue number: ${issueNumber}.`,
        });
    }
    if (input.label.trim().length === 0) {
        throw new RalphieError({
            message: "A hand-off label name cannot be blank.",
        });
    }
    if (input.body.trim().length === 0) {
        throw new RalphieError({
            message: "A hand-off comment cannot be blank.",
        });
    }
};

const ensureComment = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    body: string,
): Promise<GitHubHandOffResult["comment"]> => {
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
    };
    const marker = handOffMarker(issueNumber);
    const comments = (
        await client.paginate(client.rest.issues.listComments, {
            ...parameters,
            per_page: 100,
        })
    ).filter(
        (comment) =>
            typeof comment.body === "string" && comment.body.includes(marker),
    );
    if (comments.length > 1) {
        throw new GitHubMutationRecoveryError({
            message: `Found ${comments.length} hand-off comments for issue #${issueNumber} in ${repository}; marker ownership is ambiguous. Remove the extra comments and retry.`,
            operation: "discover hand-off comment",
        });
    }
    const existing = comments[0];
    if (existing === undefined) {
        await client.rest.issues.createComment({ ...parameters, body });
        return "created";
    }
    if (existing.body === body) return "unchanged";
    await client.rest.issues.updateComment({
        ...repositoryParameters(repository),
        comment_id: existing.id,
        body,
    });
    return "updated";
};

const isNotFound = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { readonly status?: unknown }).status === 404;

/** Leave the issue with exactly one triage state label: the target. */
const replaceStateLabel = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    input: GitHubHandOffInput,
): Promise<void> => {
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
    };
    await client.rest.issues.addLabels({
        ...parameters,
        labels: [input.label],
    });
    for (const name of new Set(input.replaceLabels)) {
        if (name === input.label) continue;
        try {
            await client.rest.issues.removeLabel({ ...parameters, name });
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }
};

export const makeGitHubHandOffService = (
    session: GitHubSession,
): GitHubHandOffService => ({
    handOff: async (repository, issueNumber, input) => {
        const client = session.client();
        try {
            validateInput(issueNumber, input);
            const comment = await ensureComment(
                client,
                repository,
                issueNumber,
                renderHandOffBody(issueNumber, input.body),
            );
            await replaceStateLabel(client, repository, issueNumber, input);
            return { comment };
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to hand off issue #${issueNumber} in ${repository}.`,
                cause,
            });
        }
    },
});