import { requireSuccess } from "../../process/require-success.ts";
import type { CommandRunnerService } from "../../process/ports.ts";
import type { GitRepositoryFactsService } from "../ports.ts";

/** Most tracked paths listed before the list is cut off. */
export const REPOSITORY_FACTS_PATH_LIMIT = 400;
const RECENT_COMMIT_COUNT = 10;

/** Read the Git facts a shell-less read-only session cannot look up itself. */
export const makeGitRepositoryFactsService = (
    runner: CommandRunnerService,
): GitRepositoryFactsService => ({
    read: async (repositoryPath, signal) => {
        const run = async (args: ReadonlyArray<string>): Promise<string> =>
            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, ...args],
                    `Failed to read Git facts of ${repositoryPath}.`,
                    signal === undefined ? {} : { signal },
                )
            ).stdout;
        const head = await run(["rev-parse", "HEAD"]);
        const branch = await run(["branch", "--show-current"]);
        const log = await run([
            "log",
            `-${RECENT_COMMIT_COUNT}`,
            "--format=%h %s",
        ]);
        const status = await run(["status", "--short"]);
        const paths = (await run(["ls-files"]))
            .split("\n")
            .filter((path) => path !== "");
        const shown = paths.slice(0, REPOSITORY_FACTS_PATH_LIMIT);
        const omitted = paths.length - shown.length;
        const more =
            omitted > 0
                ? `\n... ${omitted} more not listed; use your file-search tools`
                : "";
        return [
            `HEAD: ${head}`,
            `Branch: ${branch === "" ? "(detached)" : branch}`,
            `Working tree status (git status --short):\n${status === "" ? "(clean)" : status}`,
            `Recent commits (git log):\n${log}`,
            `Tracked files (git ls-files, ${paths.length} total):\n${shown.join("\n")}${more}`,
        ].join("\n\n");
    },
});