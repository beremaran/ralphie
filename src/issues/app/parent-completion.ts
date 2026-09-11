import {
    isDecomposedParent,
    parseDecompositionMarker,
} from "../domain/decomposition-markdown.ts";
import type { ParentCompletionService } from "../ports.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssueRelationshipService,
    GitHubIssuesService,
} from "../../github/ports.ts";

export const makeParentCompletionService = (input: {
    readonly issues: GitHubIssuesService;
    readonly relationships: GitHubIssueRelationshipService;
    readonly mutations: GitHubIssueMutationService;
}): ParentCompletionService => {
    const { issues, relationships, mutations } = input;

    const reconcileParent = async (
        repository: string,
        parentIssueNumber: number,
    ): Promise<boolean> => {
        const parent = await issues.refresh(repository, parentIssueNumber);
        if (parent.state === "closed") return true;
        if (!isDecomposedParent(parent)) return false;
        const children = await relationships.listSubIssues(
            repository,
            parentIssueNumber,
        );
        // A parent without native attachments is still mid-recovery; never
        // complete it while the attachment state is unresolved.
        if (children.length === 0) return false;
        if (children.some((child) => child.state !== "closed")) return false;
        await mutations.close(repository, parentIssueNumber, "completed");
        return true;
    };

    const reconcileAfterChildCompletion = async (
        repository: string,
        childIssueNumber: number,
        childBody: string | null,
    ): Promise<boolean> => {
        const native = await relationships.parentOf(
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
        return reconcileParent(repository, parentIssueNumber);
    };

    return { reconcileParent, reconcileAfterChildCompletion };
};