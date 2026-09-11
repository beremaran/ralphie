import { describe, expect, test } from "bun:test";

import { makeGitRemoteSafetyService } from "../../src/git/adapters/remote-safety.ts";
import { GitRemoteSafetyError } from "../../src/git/ports.ts";
import {
    type CommandResult,
    type CommandRunnerService,
} from "../../src/process/ports.ts";

const REPOSITORY = "owner/repository";
const REPOSITORY_PATH = "/work/repository";
const ORIGIN_URL = "https://github.com/owner/repository.git";
const BASE = "a".repeat(40);
const PRIOR_HEAD = "b".repeat(40);
const EXPECTED_COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);

type RunnerOptions = {
    readonly origin?: string;
    readonly branch?: string;
    readonly head?: string;
    /** Parent the created revision is observed to carry via `rev-parse HEAD^`. */
    readonly commitParent?: string;
    /** Raw `git ls-remote` output for refs/heads/<branch>. */
    readonly remote?: string;
    /** Raw `git rev-list --left-right --count` output. */
    readonly counts?: string;
};

const result = (stdout: string, exitCode = 0): CommandResult => ({
    stdout,
    exitCode,
    stderr: "",
});

const respond = (
    args: ReadonlyArray<string>,
    options: RunnerOptions,
): CommandResult => {
    const joined = args.join(" ");
    if (joined.includes("remote get-url origin")) {
        return result(options.origin ?? ORIGIN_URL);
    }
    if (joined.includes("symbolic-ref --short HEAD")) {
        return result(options.branch ?? "develop");
    }
    if (joined.endsWith("rev-parse HEAD^")) {
        return result(options.commitParent ?? PRIOR_HEAD);
    }
    if (joined.includes("rev-parse HEAD")) {
        return result(options.head ?? PRIOR_HEAD);
    }
    if (joined.includes("ls-remote")) {
        return result(options.remote ?? "");
    }
    if (joined.includes("rev-list --left-right --count")) {
        return result(options.counts ?? "0 0");
    }
    return result("");
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

const remoteAt = (sha: string, branch = "develop"): string =>
    `${sha}\trefs/heads/${branch}`;

describe("direct-push safety regression", () => {
    test("passes a clean direct push with the expected one-commit head", async () => {
        const { run } = makeRunner({
            branch: "develop",
            head: EXPECTED_COMMIT,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        const report = await service.verifyDirectPush({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: "develop",
            intendedBaseSha: BASE,
            expectedCommitSha: EXPECTED_COMMIT,
        });
        expect(report).toEqual({
            repository: "owner/repository",
            branch: "develop",
            origin: ORIGIN_URL,
            commitsBehindBase: 0,
            commitsAheadBase: 1,
            pushMode: "non-force",
        });
    });

    test("refuses a force direct push", async () => {
        const { run } = makeRunner();
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                pushMode: "force",
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "invalid-push-mode",
                policy: "non-force-only",
            }),
        );
    });

    test("refuses a remote base that moved away from both the intended base and expected commit", async () => {
        const { run } = makeRunner({
            branch: "develop",
            head: EXPECTED_COMMIT,
            remote: remoteAt(OTHER),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "diverged-base",
                policy: "require-expected-base",
            }),
        );
    });

    test("keeps the exact one-commit expectation for direct pushes", async () => {
        const { run: tooMany } = makeRunner({
            branch: "develop",
            head: EXPECTED_COMMIT,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run: tooMany });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "diverged-base",
            }),
        );

        const { run: behind } = makeRunner({
            branch: "develop",
            head: EXPECTED_COMMIT,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "1 1",
        });
        const behindService = makeGitRemoteSafetyService({ run: behind });
        await expect(
            behindService.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "diverged-base",
            }),
        );
    });

    test("refuses a local HEAD that does not match the expected commit", async () => {
        const { run } = makeRunner({
            branch: "develop",
            head: BASE,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "diverged-base",
            }),
        );
    });

    test("refuses a checkout on the wrong branch", async () => {
        const { run } = makeRunner({
            branch: "main",
            head: EXPECTED_COMMIT,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "origin-mismatch",
                policy: "require-owned-origin",
            }),
        );
    });

    test("refuses an origin that does not match the requested repository", async () => {
        const { run } = makeRunner({
            origin: "https://github.com/other/repository.git",
            branch: "develop",
            head: EXPECTED_COMMIT,
            remote: remoteAt(EXPECTED_COMMIT),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                expectedCommitSha: EXPECTED_COMMIT,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "origin-mismatch",
            }),
        );
    });

    test("refuses an empty intended base", async () => {
        const { run } = makeRunner();
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: "",
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: "GitRemoteSafetyError",
                kind: "diverged-base",
                policy: "require-expected-base",
            }),
        );
    });

    test("exposes typed safety errors for callers to distinguish", () => {
        expect(GitRemoteSafetyError).toBeTypeOf("function");
    });
});