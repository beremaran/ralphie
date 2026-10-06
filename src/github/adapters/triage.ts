import type { Octokit } from "octokit";

import {
    type GitHubTriageCommentResult,
    type GitHubTriageService,
} from "../ports.ts";
import { RalphieError } from "../../shared/error.ts";
import { repositoryParameters, replaceStateLabel } from "./hand-off.ts";
import type { GitHubSession } from "./session.ts";

const BRIEF_MARKER = "ralphie:agent-brief";
const IMPLEMENTED_MARKER = "ralphie:already-implemented";

const markerText = (marker: string, issueNumber: number): string =>
    `<!-- ${marker} issue=${issueNumber} -->`;

/**
 * Post a comment unless the latest comment carrying the same marker already
 * has this exact text. Changed text posts a new comment: the newest brief wins.
 */
const postOnce = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    marker: string,
    text: string,
): Promise<GitHubTriageCommentResult["comment"]> => {
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
    };
    const tag = markerText(marker, issueNumber);
    const body = `${text.trimEnd()}\n\n${tag}`;
    const latest = (
        await client.paginate(client.rest.issues.listComments, {
            ...parameters,
            per_page: 100,
        })
    )
        .filter(
            (comment) =>
                typeof comment.body === "string" && comment.body.includes(tag),
        )
        .at(-1);
    if (latest?.body === body) return "unchanged";
    await client.rest.issues.createComment({ ...parameters, body });
    return "created";
};

const failure = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

export const makeGitHubTriageService = (
    session: GitHubSession,
): GitHubTriageService => ({
    promote: async (repository, issueNumber, input) => {
        const client = session.client();
        try {
            if (input.body.trim().length === 0 || input.label.trim() === "") {
                throw new RalphieError({
                    message: "A promotion needs a brief and a label.",
                });
            }
            const comment = await postOnce(
                client,
                repository,
                issueNumber,
                BRIEF_MARKER,
                input.body,
            );
            await replaceStateLabel(client, repository, issueNumber, input);
            return { comment };
        } catch (cause) {
            throw failure(
                `Failed to promote issue #${issueNumber} in ${repository}.`,
                cause,
            );
        }
    },

    explainImplemented: async (repository, issueNumber, body) => {
        const client = session.client();
        try {
            if (body.trim().length === 0) {
                throw new RalphieError({
                    message: "An already-implemented comment cannot be blank.",
                });
            }
            return {
                comment: await postOnce(
                    client,
                    repository,
                    issueNumber,
                    IMPLEMENTED_MARKER,
                    body,
                ),
            };
        } catch (cause) {
            throw failure(
                `Failed to comment on issue #${issueNumber} in ${repository}.`,
                cause,
            );
        }
    },
});