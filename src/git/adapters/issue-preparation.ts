import { IssueArtifactKind } from "../../issues/app/artifacts.ts";
import { type IssueArtifactStoreService } from "../../issues/app/artifacts.ts";
import {
    type GitIssueCheckpointService,
    type GitIssuePreparationService,
} from "../ports.ts";
import { RalphieError } from "../../shared/error.ts";

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