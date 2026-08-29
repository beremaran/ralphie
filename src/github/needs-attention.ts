import type { Octokit } from "octokit";

import {
    GroundingDisposition,
    needsAttentionDecisionSchema,
    type NeedsAttentionReason,
} from "../issues/decisions.ts";
import { GitHubMutationRecoveryError } from "./issue-mutations.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export type NeedsAttentionNotificationInput = {
    readonly reason: NeedsAttentionReason;
    readonly summary: string;
    readonly evidence: ReadonlyArray<string>;
    readonly questions: ReadonlyArray<string>;
    readonly labelName?: string;
};

export type GitHubNeedsAttentionNotificationInput =
    NeedsAttentionNotificationInput;

export type NeedsAttentionNotificationResult = {
    readonly comment: "created" | "updated" | "unchanged";
    readonly label: "applied" | "not-configured";
};

export type GitHubNeedsAttentionNotificationRecoveryInput = {
    readonly message: string;
    readonly operation: string;
    readonly cause?: unknown;
    readonly commentPublished: boolean;
};

/** A notification may have been written even though a later response was lost. */
export class GitHubNeedsAttentionNotificationRecoveryError extends GitHubMutationRecoveryError {
    readonly commentPublished: boolean;

    constructor(input: GitHubNeedsAttentionNotificationRecoveryInput) {
        super(input);
        this.name = "GitHubNeedsAttentionNotificationRecoveryError";
        this.commentPublished = input.commentPublished;
    }
}

export type GitHubNeedsAttentionNotificationService = {
    readonly notify: (
        client: Octokit,
        repository: string,
        sourceIssueNumber: number,
        input: NeedsAttentionNotificationInput,
        labelName?: string,
    ) => Promise<NeedsAttentionNotificationResult>;
};

export const NEEDS_ATTENTION_MARKER = "ralphie:needs-attention";

export const needsAttentionMarker = (sourceIssueNumber: number): string =>
    `<!-- ${NEEDS_ATTENTION_MARKER} issue=${sourceIssueNumber} -->`;

export const needsAttentionMarkerEnd = "<!-- /ralphie:needs-attention -->";

const repositoryParameters = (repository: string) => {
    const { owner, name } = parseRepositorySlug(repository);
    return { owner, repo: name };
};

export const renderNeedsAttentionComment = (
    sourceIssueNumber: number,
    input: NeedsAttentionNotificationInput,
): string =>
    [
        needsAttentionMarker(sourceIssueNumber),
        "### Ralphie needs attention",
        "",
        "```json",
        JSON.stringify(
            {
                reason: input.reason,
                summary: input.summary,
                evidence: input.evidence,
                questions: input.questions,
            },
            null,
            2,
        ),
        "```",
        needsAttentionMarkerEnd,
    ].join("\n");

type IssueComment = {
    readonly id: number;
    readonly body?: string | null;
};

type IssueLabel =
    | string
    | {
          readonly name?: string | null;
      };

const labelNames = (labels: ReadonlyArray<IssueLabel> | undefined): string[] =>
    (labels ?? []).flatMap((label) =>
        typeof label === "string"
            ? [label]
            : label.name === undefined || label.name === null
              ? []
              : [label.name],
    );

const validateInput = (
    sourceIssueNumber: number,
    input: NeedsAttentionNotificationInput,
): void => {
    if (!Number.isSafeInteger(sourceIssueNumber) || sourceIssueNumber <= 0) {
        throw new RalphieError({
            message: `Invalid source issue number: ${sourceIssueNumber}.`,
        });
    }

    const parsed = needsAttentionDecisionSchema.safeParse({
        disposition: GroundingDisposition.NeedsAttention,
        reason: input.reason,
        summary: input.summary,
        evidence: input.evidence,
        questions: input.questions,
    });
    if (!parsed.success) {
        throw new RalphieError({
            message: "Invalid needs-attention notification payload.",
            cause: parsed.error,
        });
    }
    if (input.labelName !== undefined && input.labelName.trim().length === 0) {
        throw new RalphieError({
            message: "A needs-attention label name cannot be blank.",
        });
    }
};

const commentParameters = (repository: string, sourceIssueNumber: number) => ({
    ...repositoryParameters(repository),
    issue_number: sourceIssueNumber,
});

const matchingComments = async (
    client: Octokit,
    parameters: ReturnType<typeof commentParameters>,
    sourceIssueNumber: number,
): Promise<ReadonlyArray<IssueComment>> => {
    const openingMarker = needsAttentionMarker(sourceIssueNumber);
    const comments = await client.paginate(client.rest.issues.listComments, {
        ...parameters,
        per_page: 100,
    });
    return comments.filter(
        (comment) =>
            typeof comment.id === "number" &&
            typeof comment.body === "string" &&
            comment.body.includes(openingMarker),
    );
};

const recoveryError = (
    message: string,
    operation: string,
    cause: unknown,
    commentPublished: boolean,
): GitHubNeedsAttentionNotificationRecoveryError =>
    new GitHubNeedsAttentionNotificationRecoveryError({
        message,
        operation,
        cause,
        commentPublished,
    });

const ambiguousMarkerError = (
    repository: string,
    sourceIssueNumber: number,
    count: number,
): GitHubNeedsAttentionNotificationRecoveryError =>
    recoveryError(
        `Found ${count} needs-attention comments for issue #${sourceIssueNumber} in ${repository}; marker ownership is ambiguous. Remove the ambiguity and retry without creating another comment.`,
        "discover needs-attention comment",
        undefined,
        false,
    );

const reconcileComment = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly parameters: ReturnType<typeof commentParameters>;
    readonly sourceIssueNumber: number;
    readonly desiredBody: string;
    readonly operation: string;
    readonly cause: unknown;
}): Promise<void> => {
    let comments: ReadonlyArray<IssueComment>;
    try {
        comments = await matchingComments(
            input.client,
            input.parameters,
            input.sourceIssueNumber,
        );
    } catch (cause) {
        throw recoveryError(
            `Could not reconcile the needs-attention comment for issue #${input.sourceIssueNumber} in ${input.repository}; the mutation result is uncertain. Retry only after authoritative comment discovery succeeds.`,
            input.operation,
            cause,
            false,
        );
    }

    if (comments.length === 1 && comments[0]?.body === input.desiredBody)
        return;
    if (comments.length === 0) {
        throw recoveryError(
            `The needs-attention comment for issue #${input.sourceIssueNumber} in ${input.repository} is missing after an uncertain mutation; retry after restoring authoritative comment discovery.`,
            input.operation,
            input.cause,
            false,
        );
    }
    if (comments.length > 1) {
        throw recoveryError(
            `The needs-attention comment for issue #${input.sourceIssueNumber} in ${input.repository} is ambiguous after an uncertain mutation (${comments.length} matching markers); remove the ambiguity before retrying.`,
            input.operation,
            input.cause,
            false,
        );
    }
    throw recoveryError(
        `The needs-attention marker for issue #${input.sourceIssueNumber} in ${input.repository} has a different body after an uncertain mutation; do not create another comment before reconciliation.`,
        input.operation,
        input.cause,
        false,
    );
};

const ensureComment = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly sourceIssueNumber: number;
    readonly body: string;
}): Promise<"created" | "updated" | "unchanged"> => {
    const parameters = commentParameters(
        input.repository,
        input.sourceIssueNumber,
    );
    const comments = await matchingComments(
        input.client,
        parameters,
        input.sourceIssueNumber,
    );
    if (comments.length > 1) {
        throw ambiguousMarkerError(
            input.repository,
            input.sourceIssueNumber,
            comments.length,
        );
    }

    const existing = comments[0];
    if (existing !== undefined) {
        if (existing.body === input.body) return "unchanged";
        try {
            await input.client.rest.issues.updateComment({
                ...repositoryParameters(input.repository),
                comment_id: existing.id,
                body: input.body,
            });
            return "updated";
        } catch (cause) {
            await reconcileComment({
                client: input.client,
                repository: input.repository,
                parameters,
                sourceIssueNumber: input.sourceIssueNumber,
                desiredBody: input.body,
                operation: "update needs-attention comment",
                cause,
            });
            return "updated";
        }
    }

    try {
        await input.client.rest.issues.createComment({
            ...parameters,
            body: input.body,
        });
        return "created";
    } catch (cause) {
        await reconcileComment({
            client: input.client,
            repository: input.repository,
            parameters,
            sourceIssueNumber: input.sourceIssueNumber,
            desiredBody: input.body,
            operation: "create needs-attention comment",
            cause,
        });
        return "created";
    }
};

const ensureLabel = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly sourceIssueNumber: number;
    readonly labelName: string;
}): Promise<"applied"> => {
    const parameters = {
        ...repositoryParameters(input.repository),
        issue_number: input.sourceIssueNumber,
    };
    try {
        await input.client.rest.issues.addLabels({
            ...parameters,
            labels: [input.labelName],
        });
        return "applied";
    } catch (cause) {
        try {
            const issue = await input.client.rest.issues.get(parameters);
            if (labelNames(issue.data.labels).includes(input.labelName)) {
                return "applied";
            }
        } catch (reconciliationCause) {
            throw recoveryError(
                `The needs-attention comment for issue #${input.sourceIssueNumber} was published, but label ${JSON.stringify(input.labelName)} could not be reconciled in ${input.repository}; retry the same notification.`,
                "add needs-attention label",
                reconciliationCause,
                true,
            );
        }
        throw recoveryError(
            `The needs-attention comment for issue #${input.sourceIssueNumber} was published, but label ${JSON.stringify(input.labelName)} was not confirmed in ${input.repository}; retry the same notification.`,
            "add needs-attention label",
            cause,
            true,
        );
    }
};

const notificationError = (
    repository: string,
    sourceIssueNumber: number,
    cause: unknown,
): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({
              message: `Failed to publish the needs-attention notification for issue #${sourceIssueNumber} in ${repository}.`,
              cause,
          });

export const makeGitHubNeedsAttentionNotificationService =
    (): GitHubNeedsAttentionNotificationService => ({
        notify: async (
            client,
            repository,
            sourceIssueNumber,
            input,
            labelName,
        ) => {
            try {
                const notification =
                    labelName === undefined ? input : { ...input, labelName };
                validateInput(sourceIssueNumber, notification);
                const body = renderNeedsAttentionComment(
                    sourceIssueNumber,
                    notification,
                );
                const comment = await ensureComment({
                    client,
                    repository,
                    sourceIssueNumber,
                    body,
                });
                const label =
                    notification.labelName === undefined
                        ? "not-configured"
                        : await ensureLabel({
                              client,
                              repository,
                              sourceIssueNumber,
                              labelName: notification.labelName,
                          });
                return { comment, label };
            } catch (cause) {
                throw notificationError(repository, sourceIssueNumber, cause);
            }
        },
    });

export const GitHubNeedsAttentionNotificationLive =
    makeGitHubNeedsAttentionNotificationService;

export type GitHubNeedsAttentionService =
    GitHubNeedsAttentionNotificationService;
export const makeGitHubNeedsAttentionService =
    makeGitHubNeedsAttentionNotificationService;
export const GitHubNeedsAttentionLive =
    makeGitHubNeedsAttentionNotificationService;