import { requireSuccess } from "../../process/require-success.ts";
import type { CommandRunnerService } from "../../process/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import type { GitHubLoginService } from "../../config/ports.ts";
import { githubAuthenticationEnvironment } from "./session.ts";

/** Resolve the authenticated user's login through the GitHub CLI. */
export const makeGitHubLoginService = (
    runner: CommandRunnerService,
): GitHubLoginService => ({
    currentLogin: async () => {
        const result = await requireSuccess(
            runner,
            "gh",
            ["api", "user", "--jq", ".login"],
            "Could not determine the authenticated GitHub user. Authenticate gh, set defaultOwner in the configuration, or pass owner/repo.",
            { env: githubAuthenticationEnvironment() },
        );
        const login = result.stdout.trim();
        if (login === "") {
            throw new RalphieError({
                message:
                    "GitHub CLI returned an empty login. Set defaultOwner in the configuration or pass owner/repo.",
            });
        }
        return login;
    },
});