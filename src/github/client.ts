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

/** Current GitHub REST contract; 2022-11-28 retires on 2028-03-10. */
export const GITHUB_REST_API_VERSION = "2026-03-10";

const githubAuthenticationContract =
    "Set GH_TOKEN (preferred) or GITHUB_TOKEN for github.com; interactive `gh auth login` and a mounted GitHub CLI profile are not required.";

const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.length === 0 ? undefined : value;

/**
 * Normalize the GitHub.com token aliases at the process boundary. The token
 * remains an environment value; it is never added to the gh argument list.
 */
export const githubAuthenticationEnvironment = (
    environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> => {
    const token =
        nonEmpty(environment.GH_TOKEN) ?? nonEmpty(environment.GITHUB_TOKEN);
    return token === undefined ? {} : { GH_TOKEN: token };
};

export const makeGitHubClientService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitHubClientService => {
    return {
        initialize: async () => {
            const authOptions = {
                env: githubAuthenticationEnvironment(),
            };
            await requireSuccess(
                runner,
                "gh",
                ["auth", "status"],
                `GitHub authentication check failed. ${githubAuthenticationContract}`,
                authOptions,
            );

            const tokenResult = await requireSuccess(
                runner,
                "gh",
                ["auth", "token"],
                `Could not retrieve the GitHub authentication token. ${githubAuthenticationContract}`,
                authOptions,
            );
            const authToken = tokenResult.stdout.trim();
            if (!authToken) {
                throw new RalphieError({
                    message: `GitHub CLI returned an empty authentication token. ${githubAuthenticationContract}`,
                });
            }

            try {
                return new Octokit({
                    auth: authToken,
                    request: {
                        headers: {
                            "x-github-api-version": GITHUB_REST_API_VERSION,
                        },
                    },
                });
            } catch (cause) {
                throw new RalphieError({
                    message: "Failed to initialize Octokit.",
                    cause,
                });
            }
        },
    };
};

export const GitHubClientLive = makeGitHubClientService;