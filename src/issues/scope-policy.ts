import type { GitHubIssue } from "../github/issues.ts";
import { RalphieError } from "../shared/error.ts";

const licenseFileChange = /^diff --git a\/(?:LICENSE|COPYING)(?:\s|$)/im;
const licenseMetadataChange = /^\+\s*"license"\s*:\s*"([^"]+)"/im;
const licenseText =
    /^\+\s*(MIT License|Apache License|GNU GENERAL PUBLIC LICENSE)/im;

/** Fail closed when a change makes a protected maintainer policy decision. */
export const assertProtectedDecisionsAuthorized = (
    issue: GitHubIssue,
    stagedDiff: string,
): void => {
    if (
        !licenseFileChange.test(stagedDiff) &&
        !licenseMetadataChange.test(stagedDiff)
    ) {
        return;
    }
    const selected =
        licenseMetadataChange.exec(stagedDiff)?.[1] ??
        licenseText.exec(stagedDiff)?.[1];
    const issueText = `${issue.title}\n${issue.body ?? ""}`;
    if (
        selected !== undefined &&
        issueText.toLowerCase().includes(selected.toLowerCase())
    ) {
        return;
    }
    throw new RalphieError({
        message:
            "The staged change selects a project license without explicit authorization for that exact license in the issue. Defer for a maintainer decision.",
    });
};