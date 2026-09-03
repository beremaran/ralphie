import { describe, expect, test } from "bun:test";

import { makeGitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { RalphieError } from "../../src/shared/error.ts";

const CHECKPOINT = { branch: "develop", sha: "a".repeat(40) };
const REPOSITORY = "/work/repository";

type RunnerOptions = {
    readonly branch?: string;
    readonly head?: string;
    readonly status?: string;
    readonly stagedPatch?: string;
    readonly unstagedPatch?: string;
    readonly untrackedPaths?: ReadonlyArray<string>;
    readonly untrackedPatch?: string;
};

const result = (stdout: string, exitCode = 0): CommandResult => ({
    stdout,
    exitCode,
    stderr: "",
});

type CommandMatch = {
    readonly pattern: string;
    readonly exitCode?: number;
    readonly stdout: (options: RunnerOptions) => string;
};

const MATCHES: ReadonlyArray<CommandMatch> = [
    {
        pattern: "--abbrev-ref",
        stdout: (options) => options.branch ?? CHECKPOINT.branch,
    },
    { pattern: "status", stdout: (options) => options.status ?? "" },
    {
        pattern: "ls-files",
        stdout: (options) => {
            const paths = options.untrackedPaths ?? [];
            return paths.length === 0 ? "" : `${paths.join("\0")}\0`;
        },
    },
    {
        pattern: "--no-index",
        stdout: (options) => options.untrackedPatch ?? "",
        exitCode: 1,
    },
    {
        pattern: "diff --cached",
        stdout: (options) => options.stagedPatch ?? "",
    },
    { pattern: "diff", stdout: (options) => options.unstagedPatch ?? "" },
    {
        pattern: "rev-parse",
        stdout: (options) => options.head ?? CHECKPOINT.sha,
    },
];

const respond = (
    args: ReadonlyArray<string>,
    options: RunnerOptions,
): CommandResult => {
    const joined = args.join(" ");
    const match = MATCHES.find(({ pattern }) => joined.includes(pattern));
    return result(
        match === undefined ? "" : match.stdout(options),
        match?.exitCode ?? 0,
    );
};

const makeRunner = (
    options: RunnerOptions = {},
): {
    readonly run: CommandRunnerService["run"];
    readonly commands: string[];
} => {
    const commands: string[] = [];
    const run: CommandRunnerService["run"] = async (_command, args) => {
        commands.push(args.join(" "));
        return respond(args, options);
    };
    return { run, commands };
};

describe("git issue checkpoint restoration", () => {
    test("restores the exact checkpoint by removing staged, unstaged, and untracked changes", async () => {
        const { run, commands } = makeRunner({});
        const service = makeGitIssueCheckpointService({ run });
        await service.restore(REPOSITORY, CHECKPOINT);

        const resetIndex = commands.findIndex((command) =>
            command.includes("reset --hard"),
        );
        expect(resetIndex).toBeGreaterThan(-1);
        expect(commands[resetIndex]).toContain(
            `reset --hard ${CHECKPOINT.sha}`,
        );
        expect(
            commands.findIndex((command) => command.includes("clean -fd")),
        ).toBeGreaterThan(resetIndex);
        // Reset discards staged and unstaged edits; clean -fd removes
        // untracked files. The service then verifies the restored HEAD and a
        // clean porcelain status before reporting success.
        expect(commands.at(-1)).toContain("status --porcelain=v1");
        expect(commands.at(-2)).toContain("rev-parse HEAD");
    });

    test("refuses to report success while staged, unstaged, or untracked changes remain", async () => {
        const { run } = makeRunner({ status: " M file.ts\n?? new-file.ts\n" });
        const service = makeGitIssueCheckpointService({ run });
        await expect(service.restore(REPOSITORY, CHECKPOINT)).rejects.toEqual(
            expect.objectContaining({
                _tag: "RalphieError",
                message: expect.stringContaining(
                    "did not produce the expected clean state",
                ),
            }),
        );
    });

    test("refuses to restore a checkpoint on a different branch", async () => {
        const { run, commands } = makeRunner({ branch: "main" });
        const service = makeGitIssueCheckpointService({ run });
        await expect(
            service.restore(REPOSITORY, CHECKPOINT),
        ).rejects.toBeInstanceOf(RalphieError);
        expect(
            commands.findIndex((command) => command.includes("reset --hard")),
        ).toBe(-1);
    });

    test("captures staged, unstaged, and untracked changes without mutating the checkout", async () => {
        const { run, commands } = makeRunner({
            stagedPatch: "staged.patch\n",
            unstagedPatch: "unstaged.patch\n",
            untrackedPaths: ["a.txt", "b.txt"],
            untrackedPatch: "untracked.patch\n",
        });
        const service = makeGitIssueCheckpointService({ run });
        const patch = await service.createPatch(REPOSITORY);

        expect(patch).toContain("staged.patch");
        expect(patch).toContain("unstaged.patch");
        expect(patch).toContain("untracked.patch");
        const untrackedDiffs = commands.filter((command) =>
            command.includes("--no-index"),
        );
        expect(untrackedDiffs).toHaveLength(2);
        expect(untrackedDiffs[0]).toContain("/dev/null a.txt");
        expect(
            commands.findIndex((command) => command.includes("ls-files")),
        ).toBeGreaterThan(-1);
    });
});