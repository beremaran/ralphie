import { IssueArtifactKind } from "../issues/artifacts.ts";
import type { IssueArtifactStoreService } from "../issues/artifacts.ts";
import type { IssueCheckpoint } from "./issue-checkpoint.ts";
import type { GitIssueCheckpointService } from "./issue-checkpoint.ts";
import { RalphieError } from "../shared/error.ts";

export type IssuePreparationInput = {
    readonly issueNumber: number;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly signal?: AbortSignal;
};

export type GitIssuePreparationService = {
    /** Capture and persist the clean issue base before agent work starts. */
    readonly prepare: (
        input: IssuePreparationInput,
    ) => Promise<IssueCheckpoint>;
};

export const makeGitIssuePreparationService = (
    checkpoints: GitIssueCheckpointService,
    artifactStores: IssueArtifactStoreService,
): GitIssuePreparationService => ({
    prepare: async (input) => {
        const checkpoint = await checkpoints.capture(
            input.repositoryPath,
            input.branch,
        );
        const artifacts = await artifactStores.forIssue(
            input.issueNumber,
            undefined,
            input.signal,
        );
        if (artifacts.has(IssueArtifactKind.IssueCheckpoint)) {
            const existing = await artifacts.read(
                IssueArtifactKind.IssueCheckpoint,
            );
            if (
                existing.branch !== checkpoint.branch ||
                existing.sha.toLowerCase() !== checkpoint.sha.toLowerCase()
            ) {
                throw new RalphieError({
                    message: `Issue ${input.issueNumber} already has a different clean issue-base checkpoint.`,
                });
            }
            return checkpoint;
        }
        await artifacts.write(
            IssueArtifactKind.IssueCheckpoint,
            checkpoint,
            input.signal,
        );
        return checkpoint;
    },
});

export const GitIssuePreparationLive = makeGitIssuePreparationService;