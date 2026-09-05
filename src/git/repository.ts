import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    parseRepositorySlug,
    type RepositorySlug,
} from "../github/repository.ts";
import {
    CommandRunnerLive,
    requireSuccess,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

export type PreparedRepository = {
    readonly path: string;
    readonly branch: string;
    readonly cloned: boolean;
    readonly branchChanged: boolean;
    readonly cleaned: boolean;
};

export type GitRepositoryService = {
    readonly verifyInstalled: () => Promise<void>;
    readonly prepare: (
        repository: string,
        branch: string | undefined,
        workspace: string,
        destinationPath?: string,
        signal?: AbortSignal,
    ) => Promise<PreparedRepository>;
};

const pathExists = async (path: string): Promise<boolean> => {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
};

const parseRepository = (repository: string): RepositorySlug => {
    try {
        return parseRepositorySlug(repository);
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: `Invalid GitHub repository: ${repository}.`,
            cause,
        });
    }
};

const prepareRepositoryPath = async (
    parsed: RepositorySlug,
    workspace: string,
    destinationPath: string | undefined,
): Promise<{ readonly path: string; readonly exists: boolean }> => {
    const workspacePath = resolveWorkspacePath(workspace);
    const repositoryPath =
        destinationPath ?? join(workspacePath, parsed.owner, parsed.name);

    try {
        await mkdir(dirname(repositoryPath), { recursive: true });
        return {
            path: repositoryPath,
            exists: await pathExists(repositoryPath),
        };
    } catch (cause) {
        throw new RalphieError({
            message: `Failed to prepare workspace: ${workspacePath}`,
            cause,
        });
    }
};

const cloneRepository = async (
    runner: CommandRunnerService,
    parsed: RepositorySlug,
    repositoryPath: string,
    signal: AbortSignal | undefined,
): Promise<void> => {
    const clone = await runner.run(
        "gh",
        ["repo", "clone", parsed.slug, repositoryPath],
        signal === undefined ? undefined : { signal },
    );
    if (clone.exitCode !== 0) {
        const detail = clone.stderr ? `\n${clone.stderr}` : "";
        throw new RalphieError({
            message: `Failed to clone ${parsed.slug}.${detail}`,
        });
    }
};

const runGit = (
    runner: CommandRunnerService,
    repositoryPath: string,
    args: ReadonlyArray<string>,
    signal?: AbortSignal,
) =>
    runner.run(
        "git",
        ["-C", repositoryPath, ...args],
        signal === undefined ? undefined : { signal },
    );

const requireGit = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
    signal?: AbortSignal,
) =>
    await requireSuccess(
        runner,
        "git",
        ["-C", repositoryPath, ...args],
        failureMessage,
        signal === undefined ? undefined : { signal },
    );

const selectBranch = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string | undefined,
    signal: AbortSignal | undefined,
): Promise<string> => {
    if (branch !== undefined) return branch;
    const main = await runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--verify", "refs/remotes/origin/main"],
        signal,
    );
    if (main.exitCode === 0) return "main";
    const master = await runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--verify", "refs/remotes/origin/master"],
        signal,
    );
    if (master.exitCode === 0) return "master";
    throw new Error("Neither origin/main nor origin/master exists.");
};

const prepareRepositoryState = async (
    runner: CommandRunnerService,
    parsed: RepositorySlug,
    repositoryPath: string,
    branch: string | undefined,
    exists: boolean,
    signal: AbortSignal | undefined,
): Promise<Omit<PreparedRepository, "path" | "cloned">> => {
    try {
        const repositoryCheck = await runGit(
            runner,
            repositoryPath,
            ["rev-parse", "--is-inside-work-tree"],
            signal,
        );
        if (
            repositoryCheck.exitCode !== 0 ||
            repositoryCheck.stdout.trim() !== "true"
        ) {
            throw new Error(`${repositoryPath} is not a Git repository.`);
        }

        const origin = await runGit(
            runner,
            repositoryPath,
            ["remote", "get-url", "origin"],
            signal,
        );
        const originUrl = origin.exitCode === 0 ? origin.stdout.trim() : "";
        if (!originUrl) {
            throw new Error(`${repositoryPath} has no origin remote.`);
        }

        const originSlug = parseRepositorySlug(originUrl).slug;
        if (originSlug.toLowerCase() !== parsed.slug.toLowerCase()) {
            throw new Error(
                `${repositoryPath} contains ${originSlug}, not ${parsed.slug}.`,
            );
        }

        if (exists)
            await requireGit(
                runner,
                repositoryPath,
                ["fetch", "--prune", "origin"],
                `Failed to fetch ${parsed.slug}.`,
                signal,
            );

        const status = await requireGit(
            runner,
            repositoryPath,
            ["status", "--porcelain"],
            `Failed to inspect ${parsed.slug}.`,
            signal,
        );
        const cleaned = exists && status.stdout.trim().length > 0;
        if (cleaned) {
            await requireGit(
                runner,
                repositoryPath,
                ["reset", "--hard"],
                `Failed to clean ${parsed.slug}.`,
                signal,
            );
            await requireGit(
                runner,
                repositoryPath,
                ["clean", "-fd"],
                `Failed to clean ${parsed.slug}.`,
                signal,
            );
        }

        const selectedBranch = await selectBranch(
            runner,
            repositoryPath,
            branch,
            signal,
        );
        const currentBranch = (
            await requireGit(
                runner,
                repositoryPath,
                ["rev-parse", "--abbrev-ref", "HEAD"],
                `Failed to read the current branch for ${parsed.slug}.`,
                signal,
            )
        ).stdout.trim();
        const branchChanged = currentBranch !== selectedBranch;
        if (branchChanged)
            await requireGit(
                runner,
                repositoryPath,
                ["checkout", selectedBranch],
                `Failed to select branch ${selectedBranch} for ${parsed.slug}.`,
                signal,
            );

        if (cleaned) {
            await requireGit(
                runner,
                repositoryPath,
                ["reset", "--hard", `origin/${selectedBranch}`],
                `Failed to reset ${parsed.slug} to origin/${selectedBranch}.`,
                signal,
            );
            await requireGit(
                runner,
                repositoryPath,
                ["clean", "-fd"],
                `Failed to clean ${parsed.slug}.`,
                signal,
            );
        }

        return {
            branch: selectedBranch,
            branchChanged,
            cleaned,
        };
    } catch (cause) {
        throw new RalphieError({
            message: `Failed to prepare ${parsed.slug} on branch ${branch}.`,
            cause,
        });
    }
};

export const makeGitRepositoryService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitRepositoryService => ({
    verifyInstalled: async () => {
        await requireSuccess(
            runner,
            "git",
            ["--version"],
            "Git is not installed or is not available on PATH.",
        );
    },

    prepare: async (repository, branch, workspace, destinationPath, signal) => {
        const parsed = parseRepository(repository);
        const { path: repositoryPath, exists } = await prepareRepositoryPath(
            parsed,
            workspace,
            destinationPath,
        );

        if (!exists) {
            await cloneRepository(runner, parsed, repositoryPath, signal);
        }

        const repositoryState = await prepareRepositoryState(
            runner,
            parsed,
            repositoryPath,
            branch,
            exists,
            signal,
        );

        return {
            path: repositoryPath,
            cloned: !exists,
            ...repositoryState,
        };
    },
});

export const GitRepositoryLive = makeGitRepositoryService;