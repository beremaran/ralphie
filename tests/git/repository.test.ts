import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { makeGitRepositoryService } from "../../src/git/repository.ts";

const result = (stdout = ""): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
});

test("prepares an existing repository through the command runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-repository-"));
    try {
        const repositoryPath = join(workspace, "owner", "repository");
        await mkdir(repositoryPath, { recursive: true });
        const operations: ReadonlyArray<string>[] = [];
        const signal = new AbortController().signal;
        const signals: Array<AbortSignal | undefined> = [];
        const runner: CommandRunnerService = {
            run: async (command, args, options) => {
                expect(command).toBe("git");
                signals.push(options?.signal);
                const operation = args.slice(2);
                operations.push(operation);
                if (operation.join(" ") === "rev-parse --is-inside-work-tree")
                    return result("true\n");
                if (operation.join(" ") === "remote get-url origin")
                    return result("https://github.com/owner/repository.git\n");
                if (operation.join(" ") === "status --porcelain")
                    return result(" M src/file.ts\n");
                if (
                    operation.join(" ") ===
                    "rev-parse --verify refs/remotes/origin/main"
                )
                    return result("a".repeat(40));
                if (operation.join(" ") === "rev-parse --abbrev-ref HEAD")
                    return result("feature\n");
                return result();
            },
        };

        const prepared = await makeGitRepositoryService(runner).prepare(
            "owner/repository",
            undefined,
            workspace,
            undefined,
            signal,
        );

        expect(prepared).toEqual({
            path: repositoryPath,
            branch: "main",
            cloned: false,
            branchChanged: true,
            cleaned: true,
        });
        expect(operations).toEqual([
            ["rev-parse", "--is-inside-work-tree"],
            ["remote", "get-url", "origin"],
            ["fetch", "--prune", "origin"],
            ["status", "--porcelain"],
            ["reset", "--hard"],
            ["clean", "-fd"],
            ["rev-parse", "--verify", "refs/remotes/origin/main"],
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ["checkout", "main"],
            ["reset", "--hard", "origin/main"],
            ["clean", "-fd"],
        ]);
        expect(signals.every((received) => received === signal)).toBe(true);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});