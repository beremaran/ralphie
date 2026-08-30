import type { Octokit } from "octokit";

import {
    isDecomposedParent,
    parseDecompositionMarker,
} from "./decomposition-markdown.ts";
import type { GitHubIssueMutationService } from "./issue-mutations.ts";
import type { GitHubIssueRelationshipService } from "./issue-relationships.ts";
import type { GitHubIssuesService } from "./issues.ts";

export type ParentCompletionService = {
    /**
     * Close a decomposed parent as `completed` when every native sub-issue is
     * closed. Returns true when the parent is completed (possibly already),
     * false when it must stay open. Parents without native sub-issue
     * attachments or without a Ralphie tracking marker are left untouched so
     * recovery can finish attaching children first.
     */
    readonly reconcileParent: (
        client: Octokit,
        repository: string,
        parentIssueNumber: number,
    ) => Promise<boolean>;
    /**
     * Reconcile the parent of a just-completed child. The parent is resolved
     * from the native sub-issue relationship, falling back to the child's
     * stable decomposition marker.
     */
    readonly reconcileAfterChildCompletion: (
        client: Octokit,
        repository: string,
        childIssueNumber: number,
        childBody: string | null,
    ) => Promise<boolean>;
};

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

export const ParentCompletionLive = makeParentCompletionService;