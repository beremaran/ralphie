import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import simpleGit from "simple-git";

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
): Promise<void> => {
    const clone = await runner.run("gh", [
        "repo",
        "clone",
        parsed.slug,
        repositoryPath,
    ]);
    if (clone.exitCode !== 0) {
        const detail = clone.stderr ? `\n${clone.stderr}` : "";
        throw new RalphieError({
            message: `Failed to clone ${parsed.slug}.${detail}`,
        });
    }
};

const selectBranch = async (
    git: ReturnType<typeof simpleGit>,
    branch: string | undefined,
): Promise<string> => {
    if (branch !== undefined) return branch;
    try {
        await git.revparse(["--verify", "refs/remotes/origin/main"]);
        return "main";
    } catch {
        await git.revparse(["--verify", "refs/remotes/origin/master"]);
        return "master";
    }
};

const prepareRepositoryState = async (
    parsed: RepositorySlug,
    repositoryPath: string,
    branch: string | undefined,
    exists: boolean,
): Promise<Omit<PreparedRepository, "path" | "cloned">> => {
    try {
        const git = simpleGit(repositoryPath);
        if (!(await git.checkIsRepo())) {
            throw new Error(`${repositoryPath} is not a Git repository.`);
        }

        const remotes = await git.getRemotes(true);
        const origin = remotes.find((remote) => remote.name === "origin");
        const originUrl = origin?.refs.fetch;
        if (!originUrl) {
            throw new Error(`${repositoryPath} has no origin remote.`);
        }

        const originSlug = parseRepositorySlug(originUrl).slug;
        if (originSlug.toLowerCase() !== parsed.slug.toLowerCase()) {
            throw new Error(
                `${repositoryPath} contains ${originSlug}, not ${parsed.slug}.`,
            );
        }

        if (exists) await git.raw(["fetch", "--prune", "origin"]);

        const status = await git.status();
        const cleaned = exists && !status.isClean();
        if (cleaned) {
            await git.raw(["reset", "--hard"]);
            await git.raw(["clean", "-fd"]);
        }

        const selectedBranch = await selectBranch(git, branch);
        const currentBranch = (
            await git.revparse(["--abbrev-ref", "HEAD"])
        ).trim();
        const branchChanged = currentBranch !== selectedBranch;
        if (branchChanged) await git.checkout(selectedBranch);

        if (cleaned) {
            await git.raw(["reset", "--hard", `origin/${selectedBranch}`]);
            await git.raw(["clean", "-fd"]);
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

    prepare: async (repository, branch, workspace, destinationPath) => {
        const parsed = parseRepository(repository);
        const { path: repositoryPath, exists } = await prepareRepositoryPath(
            parsed,
            workspace,
            destinationPath,
        );

        if (!exists) {
            await cloneRepository(runner, parsed, repositoryPath);
        }

        const repositoryState = await prepareRepositoryState(
            parsed,
            repositoryPath,
            branch,
            exists,
        );

        return {
            path: repositoryPath,
            cloned: !exists,
            ...repositoryState,
        };
    },
});

export const GitRepositoryLive = makeGitRepositoryService;