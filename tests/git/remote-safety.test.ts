import { describe, expect, test } from "bun:test";

import {
    GitManagedRevisionSafetyError,
    GitRemoteSafetyError,
    makeGitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";

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

describe("managed feature-branch revision safety", () => {
    test("allows a missing remote branch only for the first delivery and reports the base as the prior head", async () => {
        const { run, commands } = makeRunner({
            branch: "ralphie/issue-42",
            head: BASE,
            counts: "0 0",
        });
        const service = makeGitRemoteSafetyService({ run });
        const report = await service.verifyManagedRevisionPush({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: "ralphie/issue-42",
            baseSha: BASE,
            expectedPriorHeadSha: BASE,
            isFirstDelivery: true,
        });

        expect(report).toEqual({
            repository: "owner/repository",
            branch: "ralphie/issue-42",
            origin: ORIGIN_URL,
            baseSha: BASE,
            expectedPriorHeadSha: BASE,
            commitsBehindBase: 0,
            commitsAheadBase: 0,
            pushMode: "non-force",
        });
        const lsRemote = commands.find((command) =>
            command.includes("ls-remote"),
        );
        expect(lsRemote).toContain("refs/heads/ralphie/issue-42");
    });

    test("accepts a first delivery whose remote branch already exists at the base", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: BASE,
            remote: remoteAt(BASE, "ralphie/issue-42"),
            counts: "0 0",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: BASE,
                isFirstDelivery: true,
            }),
        ).resolves.toMatchObject({
            expectedPriorHeadSha: BASE,
            commitsAheadBase: 0,
        });
    });

    test("accepts a later revision whose local HEAD and remote branch are at the last delivered head", async () => {
        const { run, commands } = makeRunner({
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run });
        const report = await service.verifyManagedRevisionPush({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: "ralphie/issue-42",
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            isFirstDelivery: false,
        });

        expect(report).toMatchObject({
            expectedPriorHeadSha: PRIOR_HEAD,
            commitsBehindBase: 0,
            commitsAheadBase: 2,
        });
        expect(
            commands.find((command) =>
                command.includes("rev-list --left-right --count"),
            ),
        ).toContain(`${BASE}...${PRIOR_HEAD}`);
    });

    test("compares ancestry to the original base without requiring exactly one commit ahead", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 3",
        });
        const service = makeGitRemoteSafetyService({ run });
        const report = await service.verifyManagedRevisionPush({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: "ralphie/issue-42",
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            isFirstDelivery: false,
        });
        expect(report.commitsAheadBase).toBe(3);
    });

    test("refuses a moved remote head before delivery as external remote movement", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            remote: remoteAt(OTHER, "ralphie/issue-42"),
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "remote-moved",
                policy: "require-expected-remote-head",
            }),
        );
    });

    test("refuses a missing remote branch for a revision that is not the first delivery", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "remote-moved",
            }),
        );
    });

    test("refuses a stale local head instead of following or resetting over it", async () => {
        const { run, commands } = makeRunner({
            branch: "ralphie/issue-42",
            head: OTHER,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "stale-prior-head",
                policy: "require-expected-prior-head",
            }),
        );
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull/.test(command),
            ),
        ).toBe(false);
    });

    test("distinguishes an invalid managed checkout on origin, branch, and base ancestry", async () => {
        const originMismatch = makeRunner({
            origin: "https://github.com/other/repository.git",
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 2",
        });
        const service = makeGitRemoteSafetyService({ run: originMismatch.run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-managed-checkout",
                policy: "require-valid-managed-checkout",
            }),
        );

        const wrongBranch = makeRunner({
            branch: "main",
            head: PRIOR_HEAD,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 2",
        });
        const branchService = makeGitRemoteSafetyService({
            run: wrongBranch.run,
        });
        await expect(
            branchService.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-managed-checkout",
            }),
        );

        const unanchored = makeRunner({
            branch: "ralphie/issue-42",
            head: PRIOR_HEAD,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "1 1",
        });
        const ancestryService = makeGitRemoteSafetyService({
            run: unanchored.run,
        });
        await expect(
            ancestryService.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-managed-checkout",
            }),
        );
    });

    test("refuses a force push mode for a managed revision", async () => {
        const { run } = makeRunner();
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                isFirstDelivery: false,
                pushMode: "force",
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-push-mode",
                policy: "non-force-only",
            }),
        );
    });
});

describe("managed revision pre-push re-check", () => {
    test("accepts the created revision head, its prior parent, and an unchanged remote head", async () => {
        const { run, commands } = makeRunner({
            branch: "ralphie/issue-42",
            head: EXPECTED_COMMIT,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        const report = await service.verifyManagedRevisionPrePush({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: "ralphie/issue-42",
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedLocalHeadSha: EXPECTED_COMMIT,
            isFirstDelivery: false,
        });

        expect(report).toMatchObject({
            expectedPriorHeadSha: PRIOR_HEAD,
            commitsBehindBase: 0,
            commitsAheadBase: 1,
            pushMode: "non-force",
        });
        expect(
            commands.some((command) => command.endsWith("rev-parse HEAD^")),
        ).toBe(true);
    });

    test("allows the missing remote branch only for the first delivery at the re-check", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: EXPECTED_COMMIT,
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: true,
            }),
        ).resolves.toMatchObject({
            expectedPriorHeadSha: PRIOR_HEAD,
        });
    });

    test("refuses a local HEAD that is not the created revision before pushing", async () => {
        const { run, commands } = makeRunner({
            branch: "ralphie/issue-42",
            head: OTHER,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "stale-prior-head",
                policy: "require-expected-prior-head",
            }),
        );
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull/.test(command),
            ),
        ).toBe(false);
    });

    test("refuses a revision whose parent is not the expected prior head", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: EXPECTED_COMMIT,
            commitParent: OTHER,
            remote: remoteAt(PRIOR_HEAD, "ralphie/issue-42"),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "stale-prior-head",
            }),
        );
    });

    test("refuses a moved remote head at the re-check before pushing", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: EXPECTED_COMMIT,
            remote: remoteAt(OTHER, "ralphie/issue-42"),
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "remote-moved",
                policy: "require-expected-remote-head",
            }),
        );
    });

    test("refuses a missing remote branch at the re-check for a later revision", async () => {
        const { run } = makeRunner({
            branch: "ralphie/issue-42",
            head: EXPECTED_COMMIT,
            counts: "0 1",
        });
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "remote-moved",
            }),
        );
    });

    test("refuses a force push mode at the re-check", async () => {
        const { run } = makeRunner();
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: EXPECTED_COMMIT,
                isFirstDelivery: false,
                pushMode: "force",
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-push-mode",
                policy: "non-force-only",
            }),
        );
    });

    test("refuses an invalid created head sha at the re-check", async () => {
        const { run } = makeRunner();
        const service = makeGitRemoteSafetyService({ run });
        await expect(
            service.verifyManagedRevisionPrePush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "ralphie/issue-42",
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedLocalHeadSha: "not-a-sha",
                isFirstDelivery: false,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitManagedRevisionSafetyError",
                kind: "invalid-managed-checkout",
                policy: "require-valid-managed-checkout",
            }),
        );
    });
});

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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
                kind: "diverged-base",
                policy: "require-expected-base",
            }),
        );
    });

    test("allows a missing remote branch only when explicitly permitted", async () => {
        const { run: denied } = makeRunner({
            branch: "develop",
            head: BASE,
            counts: "0 0",
        });
        const service = makeGitRemoteSafetyService({ run: denied });
        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                _tag: "GitRemoteSafetyError",
                kind: "diverged-base",
            }),
        );

        const { run: allowed } = makeRunner({
            branch: "develop",
            head: BASE,
            counts: "0 0",
        });
        const allowedService = makeGitRemoteSafetyService({ run: allowed });
        await expect(
            allowedService.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: "develop",
                intendedBaseSha: BASE,
                allowMissingRemoteBranch: true,
            }),
        ).resolves.toMatchObject({
            commitsAheadBase: 0,
        });
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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
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
                _tag: "GitRemoteSafetyError",
                kind: "diverged-base",
                policy: "require-expected-base",
            }),
        );
    });

    test("exposes typed safety errors for callers to distinguish", () => {
        expect(GitRemoteSafetyError).toBeTypeOf("function");
        expect(GitManagedRevisionSafetyError).toBeTypeOf("function");
    });
});