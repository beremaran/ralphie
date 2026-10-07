import type { CommandRunnerService } from "../../process/ports.ts";
import { requireSuccess } from "../../process/require-success.ts";
import { RalphieError } from "../../shared/error.ts";
import type { GitHubViewerService } from "../ports.ts";
import { githubAuthenticationEnvironment } from "./session.ts";

const unresolvedOwner =
    "Could not read the authenticated gh login to complete a bare repository name. Pass owner/repo, or set defaultOwner in the config file.";

/** Reads the login `gh` is authenticated as, honoring GH_TOKEN/GITHUB_TOKEN. */
export const makeGitHubViewerService = (
    runner: CommandRunnerService,
): GitHubViewerService => ({
    login: async () => {
        const result = await requireSuccess(
            runner,
            "gh",
            ["api", "user", "--jq", ".login"],
            unresolvedOwner,
            { env: githubAuthenticationEnvironment() },
        );
        const login = result.stdout.trim();
        if (login.length === 0) {
            throw new RalphieError({ message: unresolvedOwner });
        }
        return login;
    },
});