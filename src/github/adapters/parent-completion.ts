import type { Octokit } from "octokit";

import {
    isDecomposedParent,
    parseDecompositionMarker,
} from "../../issues/domain/decomposition-markdown.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssueRelationshipService,
    GitHubIssuesService,
    ParentCompletionService,
} from "../ports.ts";

export const makeParentCompletionService = (input: {
    readonly issues: GitHubIssuesService;
    readonly relationships: GitHubIssueRelationshipService;
    readonly mutations: GitHubIssueMutationService;
}): ParentCompletionService => {
    const { issues, relationships, mutations } = input;

    const reconcileParent = async (
        client: Octokit,
        repository: string,
        parentIssueNumber: number,
    ): Promise<boolean> => {
        const parent = await issues.refresh(
            client,
            repository,
            parentIssueNumber,
        );
        if (parent.state === "closed") return true;
        if (!isDecomposedParent(parent)) return false;
        const children = await relationships.listSubIssues(
            client,
            repository,
            parentIssueNumber,
        );
        // A parent without native attachments is still mid-recovery; never
        // complete it while the attachment state is unresolved.
        if (children.length === 0) return false;
        if (children.some((child) => child.state !== "closed")) return false;
        await mutations.close(
            client,
            repository,
            parentIssueNumber,
            "completed",
        );
        return true;
    };

    const reconcileAfterChildCompletion = async (
        client: Octokit,
        repository: string,
        childIssueNumber: number,
        childBody: string | null,
    ): Promise<boolean> => {
        const native = await relationships.parentOf(
            client,
            repository,
            childIssueNumber,
        );
        const parentIssueNumber =
            native?.number ??
            parseDecompositionMarker(childBody)?.parentIssueNumber;
        if (
            parentIssueNumber === undefined ||
            parentIssueNumber === childIssueNumber
        ) {
            return false;
        }
        return reconcileParent(client, repository, parentIssueNumber);
    };

    return { reconcileParent, reconcileAfterChildCompletion };
};