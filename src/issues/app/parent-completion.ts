import {
    isDecomposedParent,
    parseDecompositionMarker,
} from "../domain/decomposition-markdown.ts";
import { withDisclaimer } from "../domain/hand-off.ts";
import type { ParentCompletionService } from "../ports.ts";
import type { GitHubIssue } from "../../github/domain.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssueRelationshipService,
    GitHubIssuesService,
} from "../../github/ports.ts";

const PARENT_COMPLETED_MARKER = "<!-- ralphie:parent-completed -->";

const renderParentCompletedComment = (
    children: ReadonlyArray<GitHubIssue>,
): string =>
    withDisclaimer(
        `Every sub-issue of this issue is now closed, so Ralphie is closing it as completed.\n\n${children
            .map((child) => `- #${child.number} ${child.title}`)
            .join("\n")}\n\n${PARENT_COMPLETED_MARKER}`,
    );

const hasCompletionComment = (parent: GitHubIssue): boolean =>
    (parent.comments ?? []).some((comment) =>
        comment.body.includes(PARENT_COMPLETED_MARKER),
    );

/**
 * Only parents Ralphie decomposed are closed (a human-managed epic has no
 * child carrying a marker that names it), and only once every child is closed.
 */
const isFinishedRalphieDecomposition = (
    parent: GitHubIssue,
    children: ReadonlyArray<GitHubIssue>,
): boolean =>
    children.some(
        (child) =>
            parseDecompositionMarker(child.body)?.parentIssueNumber ===
            parent.number,
    ) && children.every((child) => child.state === "closed");

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
        if (!isFinishedRalphieDecomposition(parent, children)) return false;
        // The comment goes first and is skipped when a crashed earlier attempt
        // already posted it, so a retry never duplicates it.
        if (!hasCompletionComment(parent)) {
            await mutations.comment(
                repository,
                parentIssueNumber,
                renderParentCompletedComment(children),
            );
        }
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