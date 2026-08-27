import { Octokit } from "octokit";

import {
    CommandRunnerLive,
    requireSuccess,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type GitHubClientService = {
    readonly initialize: () => Promise<Octokit>;
};

export const makeGitHubClientService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitHubClientService => ({
    initialize: async () => {
        await requireSuccess(
            runner,
            "gh",
            ["auth", "status"],
            "GitHub authentication check failed. Run `gh auth login` and try again.",
        );

        const tokenResult = await requireSuccess(
            runner,
            "gh",
            ["auth", "token"],
            "Could not retrieve the GitHub authentication token.",
        );
        const authToken = tokenResult.stdout.trim();
        if (!authToken) {
            throw new RalphieError({
                message: "GitHub CLI returned an empty authentication token.",
            });
        }

        try {
            return new Octokit({ auth: authToken });
        } catch (cause) {
            throw new RalphieError({
                message: "Failed to initialize Octokit.",
                cause,
            });
        }
    },
});

export const GitHubClientLive = makeGitHubClientService;