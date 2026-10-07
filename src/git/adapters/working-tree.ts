import { createHash } from "node:crypto";

import { requireSuccess } from "../../process/require-success.ts";
import type { CommandRunnerService } from "../../process/ports.ts";
import type { GitWorkingTreeService } from "../ports.ts";

/** Hash everything a session could change: HEAD, index, tracked and untracked files. */
export const makeGitWorkingTreeService = (
    runner: CommandRunnerService,
): GitWorkingTreeService => ({
    fingerprint: async (repositoryPath, signal) => {
        const options = signal === undefined ? {} : { signal };
        const git = async (
            args: ReadonlyArray<string>,
            stdin?: string,
        ): Promise<string> =>
            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, ...args],
                    `Failed to inspect the working tree of ${repositoryPath}.`,
                    {
                        ...options,
                        trimStdout: false,
                        ...(stdin === undefined ? {} : { stdin }),
                    },
                )
            ).stdout;
        const untracked = await git([
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ]);
        const untrackedHashes =
            untracked === ""
                ? ""
                : await git(
                      ["hash-object", "--stdin-paths"],
                      untracked.split("\0").filter(Boolean).join("\n") + "\n",
                  );
        const parts = [
            await git(["rev-parse", "HEAD"]),
            await git(["ls-files", "--stage", "-z"]),
            await git(["diff", "--binary", "--no-ext-diff"]),
            untracked,
            untrackedHashes,
        ];
        const hash = createHash("sha256");
        for (const part of parts) hash.update(`${part.length}:${part}`);
        return hash.digest("hex");
    },
});