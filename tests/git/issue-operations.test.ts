import { describe, expect, test } from "bun:test";

import {
    GitRevisionCommitError,
    makeGitRevisionCommitService,
} from "../../src/git/revision-commit.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";

const REPOSITORY = "owner/repository";
const REPOSITORY_PATH = "/work/repository";
const BRANCH = "ralphie/issue-42";
const BASE = "a".repeat(40);
const PRIOR_HEAD = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const BASE_TREE = "d".repeat(40);
const PRIOR_TREE = "e".repeat(40);
const APPROVED_TREE = "f".repeat(40);
const OTHER_TREE = "g".repeat(40);
const OTHER = "h".repeat(40);

const COMMIT_MESSAGE = {
    subject: "Fix: address review findings",
    body: "Applies the approved revision.",
};

type RunnerOptions = {
    readonly branch?: string;
    readonly head?: string;
    readonly status?: string;
    /** `git diff --cached --quiet` fails when the index is not clean. */
    readonly preStaged?: boolean;
    /** `git write-tree` output while staging the revision. */
    readonly stagedTree?: string;
    /** Tree of the expected prior head read via `rev-parse <sha>^{tree}`. */
    readonly priorTree?: string;
    /** Tree the created commit is observed to carry. */
    readonly commitTree?: string;
    /** Parent the created commit is observed to carry. */
    readonly commitParent?: string;
    /** `git rev-list --count <prior>..HEAD` output after the commit. */
    readonly commitCount?: string;
    /** Porcelain status the checkout shows after the commit. */
    readonly postCommitStatus?: string;
};

const result = (stdout: string, exitCode = 0): CommandResult => ({
    stdout,
    exitCode,
    stderr: "",
});

const makeRunner = (
    options: RunnerOptions = {},
): {
    readonly run: CommandRunnerService["run"];
    readonly commands: string[];
} => {
    const commands: string[] = [];
    const state = {
        head: options.head ?? PRIOR_HEAD,
        status: options.status ?? "",
    };
    const commit = (joined: string): CommandResult | undefined => {
        state.head = NEW_HEAD;
        state.status = options.postCommitStatus ?? "";
        return joined.includes("commit -m") ? result("") : undefined;
    };
    const priorTree = (joined: string): CommandResult | undefined => {
        if (!joined.endsWith("^{tree}")) return undefined;
        const sha = joined.slice(
            joined.indexOf("rev-parse ") + "rev-parse ".length,
            joined.length - "^{tree}".length,
        );
        return result(
            sha === BASE ? BASE_TREE : (options.priorTree ?? PRIOR_TREE),
        );
    };
    const matches: ReadonlyArray<{
        readonly match: (joined: string) => boolean;
        readonly respond: (joined: string) => CommandResult | undefined;
    }> = [
        {
            match: (joined) => joined.includes("rev-parse --abbrev-ref HEAD"),
            respond: () => result(options.branch ?? BRANCH),
        },
        {
            match: (joined) =>
                joined.includes("rev-parse --verify HEAD^{commit}"),
            respond: () => result(state.head),
        },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD^"),
            respond: () => result(options.commitParent ?? PRIOR_HEAD),
        },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD^{tree}"),
            respond: () => result(options.commitTree ?? APPROVED_TREE),
        },
        { match: (joined) => joined.endsWith("^{tree}"), respond: priorTree },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD"),
            respond: () => result(state.head),
        },
        {
            match: (joined) => joined.includes("status --porcelain=v1"),
            respond: () => result(state.status),
        },
        {
            match: (joined) => joined.includes("diff --cached --quiet"),
            respond: () => result("", options.preStaged === true ? 1 : 0),
        },
        {
            match: (joined) => joined.includes("add --all"),
            respond: () => result(""),
        },
        {
            match: (joined) => joined.includes("write-tree"),
            respond: () => result(options.stagedTree ?? APPROVED_TREE),
        },
        {
            match: (joined) => joined.includes("reset"),
            respond: () => result(""),
        },
        {
            match: (joined) => joined.includes("commit -m"),
            respond: commit,
        },
        {
            match: (joined) => joined.includes("rev-list --count"),
            respond: () => result(options.commitCount ?? "1"),
        },
    ];
    const run: CommandRunnerService["run"] = async (_command, args) => {
        const joined = args.join(" ");
        commands.push(joined);
        const matched = matches.find(({ match }) => match(joined));
        const response =
            matched === undefined ? undefined : matched.respond(joined);
        return response ?? result("");
    };
    return { run, commands };
};

const expectErrorKind = async (
    promise: Promise<unknown>,
    kind: GitRevisionCommitError["kind"],
): Promise<GitRevisionCommitError> => {
    let outcome: unknown;
    try {
        outcome = await promise;
    } catch (error) {
        outcome = error;
    }
    expect(outcome).toBeInstanceOf(GitRevisionCommitError);
    expect((outcome as GitRevisionCommitError).kind).toBe(kind);
    return outcome as GitRevisionCommitError;
};

describe("git revision commit operations", () => {
    test("commits the first revision on the exact prior head with the deterministic staged tree", async () => {
        const { run, commands } = makeRunner({
            head: BASE,
            status: " M src/index.ts",
            commitParent: BASE,
        });
        const service = makeGitRevisionCommitService({ run });

        const commit = await service.commitRevision({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            expectedPriorHeadSha: BASE,
            expectedStagedTreeSha: APPROVED_TREE,
            message: COMMIT_MESSAGE,
        });

        expect(commit).toEqual({
            headSha: NEW_HEAD,
            parentSha: BASE,
            treeSha: APPROVED_TREE,
        });
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("write-tree"))).toBe(
            true,
        );
        expect(
            commands.some((command) =>
                command.includes(`rev-parse ${BASE}^{tree}`),
            ),
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.includes(
                    "commit -m Fix: address review findings -m Applies the approved revision.",
                ),
            ),
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.includes("rev-parse --verify HEAD^{commit}"),
            ),
        ).toBe(true);
        expect(
            commands.some((command) => command.includes("rev-parse HEAD^")),
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.includes("rev-parse HEAD^{tree}"),
            ),
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.includes(`rev-list --count ${BASE}..HEAD`),
            ),
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.includes("status --porcelain=v1"),
            ),
        ).toBe(true);
        expect(commands.some((command) => command.includes("reset"))).toBe(
            false,
        );
    });

    test("commits a subsequent revision on the last delivered feature head", async () => {
        const { run, commands } = makeRunner({ status: "?? lib/new.ts" });
        const service = makeGitRevisionCommitService({ run });

        const commit = await service.commitRevision({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedStagedTreeSha: APPROVED_TREE,
            message: COMMIT_MESSAGE,
        });

        expect(commit).toEqual({
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
        });
        expect(commands.some((command) => command.includes("reset"))).toBe(
            false,
        );
        const destructive = commands.filter(
            (command) =>
                command.includes("--hard") ||
                command.includes("push") ||
                command.includes("checkout") ||
                command.includes("branch") ||
                command.includes("clean") ||
                command.includes("fetch") ||
                command.includes("force"),
        );
        expect(destructive).toEqual([]);
    });

    test("rejects a stale local head before any index mutation", async () => {
        const { run, commands } = makeRunner({ head: OTHER });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "stale-prior-head",
        );

        expect(error.message).toContain(OTHER);
        expect(error.message).toContain(PRIOR_HEAD);
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
        expect(commands.some((command) => command.includes("commit"))).toBe(
            false,
        );
    });

    test("rejects a checkout on a different branch", async () => {
        const { run, commands } = makeRunner({ branch: "main" });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "invalid-managed-checkout",
        );

        expect(error.message).toContain("on main");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
    });

    test("rejects an empty revision before staging", async () => {
        const { run, commands } = makeRunner({ status: "" });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "empty-revision",
        );

        expect(error.message).toContain("no changes");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
    });

    test("rejects a staged tree that matches the prior head and unstages the temporary index", async () => {
        const { run, commands } = makeRunner({
            status: " M src/index.ts",
            stagedTree: PRIOR_TREE,
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "empty-revision",
        );

        expect(error.message).toContain("matches the prior feature head");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("reset"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("commit"))).toBe(
            false,
        );
    });

    test("rejects an out-of-scope revision whose staged tree differs from the allowed tree", async () => {
        const { run, commands } = makeRunner({
            status: " M src/index.ts",
            stagedTree: OTHER_TREE,
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "out-of-scope-revision",
        );

        expect(error.message).toContain(OTHER_TREE);
        expect(error.message).toContain(APPROVED_TREE);
        expect(commands.some((command) => command.includes("reset"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("commit"))).toBe(
            false,
        );
    });

    test("rejects already-staged changes before any mutation", async () => {
        const { run, commands } = makeRunner({
            status: "M  src/index.ts",
            preStaged: true,
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "invalid-input",
        );

        expect(error.message).toContain("already-staged");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
    });

    test("rejects invalid commit messages locally without touching the checkout", async () => {
        const { run, commands } = makeRunner({ status: " M a.ts" });
        const service = makeGitRevisionCommitService({ run });
        const input = {
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedStagedTreeSha: APPROVED_TREE,
        };

        await expectErrorKind(
            service.commitRevision({
                ...input,
                message: { subject: "" },
            }),
            "invalid-input",
        );
        await expectErrorKind(
            service.commitRevision({
                ...input,
                message: { subject: "   " },
            }),
            "invalid-input",
        );
        await expectErrorKind(
            service.commitRevision({
                ...input,
                message: { subject: "x".repeat(73) },
            }),
            "invalid-input",
        );
        await expectErrorKind(
            service.commitRevision({
                ...input,
                message: { subject: "Valid subject", body: "" },
            }),
            "invalid-input",
        );

        expect(commands).toEqual([]);
    });

    test("runs the validation context hook before staging and propagates its scope rejection", async () => {
        const pendingCall = {
            repository: "",
            repositoryPath: "",
            branch: "",
            status: "",
        };
        const { run, commands } = makeRunner({
            status: " M protected/secret.ts",
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
                context: {
                    validate: async (pending) => {
                        Object.assign(pendingCall, pending);
                        throw new GitRevisionCommitError({
                            kind: "out-of-scope-revision",
                            message: "Agent touched a protected path.",
                        });
                    },
                },
            }),
            "out-of-scope-revision",
        );

        expect(pendingCall).toEqual({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            status: " M protected/secret.ts",
        });
        expect(error.message).toBe("Agent touched a protected path.");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
    });

    test("cancels immediately without touching the checkout", async () => {
        const { run, commands } = makeRunner({ status: " M a.ts" });
        const service = makeGitRevisionCommitService({ run });

        await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
                context: { isCancelled: () => true },
            }),
            "cancelled",
        );

        expect(commands).toEqual([]);
    });

    test("cancelling before the commit cleans only the temporary index state", async () => {
        let calls = 0;
        const { run, commands } = makeRunner({ status: " M a.ts" });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
                context: {
                    isCancelled: () => {
                        calls += 1;
                        return calls >= 3;
                    },
                },
            }),
            "cancelled",
        );

        expect(error.kind).toBe("cancelled");
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("reset"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("commit"))).toBe(
            false,
        );
    });

    test("fails revalidation when the commit parent is not the expected prior head and retains the commit", async () => {
        const { run, commands } = makeRunner({
            status: " M a.ts",
            commitParent: OTHER,
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "commit-verification-failed",
        );

        expect(error.message).toContain(OTHER);
        expect(error.message).toContain("parent");
        expect(commands.some((command) => command.includes("reset"))).toBe(
            false,
        );
    });

    test("fails revalidation when the commit tree is not byte-for-byte the captured staged tree", async () => {
        const { run, commands } = makeRunner({
            status: " M a.ts",
            commitTree: OTHER_TREE,
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "commit-verification-failed",
        );

        expect(error.message).toContain(OTHER_TREE);
        expect(error.message).toContain("tree");
        expect(commands.some((command) => command.includes("reset"))).toBe(
            false,
        );
    });

    test("fails revalidation when more than one commit was created", async () => {
        const { run } = makeRunner({
            status: " M a.ts",
            commitCount: "2",
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "commit-verification-failed",
        );

        expect(error.message).toContain("commits ahead");
    });

    test("fails revalidation when the checkout is left dirty after the commit", async () => {
        const { run } = makeRunner({
            status: " M a.ts",
            postCommitStatus: " M left-over.ts",
        });
        const service = makeGitRevisionCommitService({ run });

        const error = await expectErrorKind(
            service.commitRevision({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                message: COMMIT_MESSAGE,
            }),
            "commit-verification-failed",
        );

        expect(error.message).toContain("dirty checkout");
    });

    test("rejects invalid prior head and staged tree shas", async () => {
        const { run, commands } = makeRunner({ status: " M a.ts" });
        const service = makeGitRevisionCommitService({ run });
        const input = {
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            message: COMMIT_MESSAGE,
        };

        await expectErrorKind(
            service.commitRevision({
                ...input,
                expectedPriorHeadSha: "not-a-sha",
                expectedStagedTreeSha: APPROVED_TREE,
            }),
            "invalid-input",
        );
        await expectErrorKind(
            service.commitRevision({
                ...input,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: "not-a-sha",
            }),
            "invalid-input",
        );
        await expectErrorKind(
            service.commitRevision({
                ...input,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: APPROVED_TREE,
                branch: " ",
            }),
            "invalid-input",
        );

        expect(commands).toEqual([]);
    });
});