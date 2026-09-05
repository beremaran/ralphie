import { describe, expect, test } from "bun:test";

import { isNonFastForward } from "../../src/git/issue-operations.ts";
import {
    GitManagedRevisionSafetyError,
    makeGitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";
import { makeGitRevisionCommitService } from "../../src/git/revision-commit.ts";
import {
    GitRevisionDeliveryError,
    type GitRevisionDeliveryInput,
    type GitRevisionDeliveryOutcome,
    makeGitRevisionDeliveryService,
} from "../../src/git/revision-delivery.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";

const REPOSITORY = "owner/repository";
const REPOSITORY_PATH = "/work/repository";
const BRANCH = "ralphie/issue-42";
const ORIGIN_URL = "https://github.com/owner/repository.git";
const BASE = "a".repeat(40);
const PRIOR_HEAD = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const BASE_TREE = "d".repeat(40);
const PRIOR_TREE = "e".repeat(40);
const APPROVED_TREE = "f".repeat(40);
const OTHER = "5".repeat(40);

const COMMIT_MESSAGE = {
    subject: "Fix: address review findings",
    body: "Applies the approved revision.",
};

type PushOptions = {
    readonly exitCode?: number;
    readonly stderr?: string;
    /** Simulates a lost push response: the server applied the ref update anyway. */
    readonly applyRemote?: boolean;
    /** Simulates the remote having moved at rejection time (non-fast-forward race). */
    readonly moveRemoteTo?: string;
};

type PostPushRemote =
    | { readonly kind: "unparseable" }
    | { readonly kind: "exit-error" };

type RunnerOptions = {
    readonly branch?: string;
    /** Local HEAD observed while reconciling an existing revision. */
    readonly localHead?: string;
    /** Initial remote head for `git ls-remote`; "" means the branch is absent. */
    readonly remoteHead?: string;
    /** Remote head observed by the pre-push re-check (second `ls-remote` call). */
    readonly remoteHeadDuringRecheck?: string;
    /** Overrides the authoritative post-push `ls-remote` response. */
    readonly postPushRemote?: PostPushRemote;
    /** Parent the created commit is observed to carry. */
    readonly commitParent?: string;
    /** Local head observed immediately after the commit was created. */
    readonly postCommitHead?: string;
    /** `git rev-list --left-right --count <base>...<prior>` output. */
    readonly counts?: string;
    /** Porcelain status seen after the push attempt. */
    readonly postPushStatus?: string;
    readonly push?: PushOptions;
};

const result = (stdout: string, exitCode = 0, stderr = ""): CommandResult => ({
    stdout,
    exitCode,
    stderr,
});

const makeRunner = (
    options: RunnerOptions = {},
): {
    readonly run: CommandRunnerService["run"];
    readonly commands: string[];
} => {
    const commands: string[] = [];
    const state = {
        head: options.localHead ?? PRIOR_HEAD,
        remoteHead: options.remoteHead ?? PRIOR_HEAD,
        lsRemoteCalls: 0,
        pushed: false,
    };
    const readRemoteHead = (): CommandResult => {
        state.lsRemoteCalls += 1;
        if (options.postPushRemote !== undefined && state.lsRemoteCalls >= 3) {
            if (options.postPushRemote.kind === "unparseable") {
                return result("not-a-sha\trefs/heads/other");
            }
            return result("", 1, "fatal: ls-remote failed");
        }
        const observed =
            state.lsRemoteCalls === 2 &&
            options.remoteHeadDuringRecheck !== undefined
                ? options.remoteHeadDuringRecheck
                : state.remoteHead;
        if (observed === "") return result("");
        return result(`${observed}\trefs/heads/${options.branch ?? BRANCH}`);
    };
    const pushRevision = (): CommandResult => {
        const push = options.push;
        if (push !== undefined && push.exitCode !== 0) {
            if (push.applyRemote === true) {
                state.remoteHead = NEW_HEAD;
            } else if (push.moveRemoteTo !== undefined) {
                state.remoteHead = push.moveRemoteTo;
            }
        } else {
            state.remoteHead = NEW_HEAD;
        }
        state.pushed = true;
        return result("", push?.exitCode ?? 0, push?.stderr ?? "");
    };
    const checkoutStatus = (): CommandResult => {
        if (state.pushed) return result(options.postPushStatus ?? "");
        if (state.head === NEW_HEAD) return result("");
        return result(" M src/index.ts");
    };
    const priorTree = (joined: string): CommandResult => {
        const sha = joined.slice(
            joined.indexOf("rev-parse ") + "rev-parse ".length,
            joined.length - "^{tree}".length,
        );
        return result(sha === BASE ? BASE_TREE : PRIOR_TREE);
    };
    const handlers: ReadonlyArray<{
        readonly match: (joined: string) => boolean;
        readonly respond: (joined: string) => CommandResult;
    }> = [
        {
            match: (joined) => joined.includes("remote get-url origin"),
            respond: () => result(ORIGIN_URL),
        },
        {
            match: (joined) => joined.includes("symbolic-ref --short HEAD"),
            respond: () => result(options.branch ?? BRANCH),
        },
        {
            match: (joined) => joined.includes("ls-remote"),
            respond: readRemoteHead,
        },
        {
            match: (joined) => joined.includes("rev-parse --abbrev-ref HEAD"),
            respond: () => result(options.branch ?? BRANCH),
        },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD^"),
            respond: () => result(options.commitParent ?? PRIOR_HEAD),
        },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD^{tree}"),
            respond: () => result(APPROVED_TREE),
        },
        {
            match: (joined) =>
                joined.includes("rev-parse --verify HEAD^{commit}"),
            respond: () => result(state.head),
        },
        {
            match: (joined) => joined.endsWith("rev-parse HEAD"),
            respond: () => result(state.head),
        },
        {
            match: (joined) => joined.endsWith("^{tree}"),
            respond: priorTree,
        },
        {
            match: (joined) => joined.includes("status --porcelain=v1"),
            respond: checkoutStatus,
        },
        {
            match: (joined) => joined.includes("diff --cached --quiet"),
            respond: () => result(""),
        },
        {
            match: (joined) => joined.includes("add --all"),
            respond: () => result(""),
        },
        {
            match: (joined) => joined.includes("write-tree"),
            respond: () => result(APPROVED_TREE),
        },
        {
            match: (joined) => joined.includes("rev-list --count"),
            respond: () => result("1"),
        },
        {
            match: (joined) => joined.includes("rev-list --left-right --count"),
            respond: () => result(options.counts ?? "0 1"),
        },
        {
            match: (joined) => joined.includes("push --no-force"),
            respond: pushRevision,
        },
        {
            match: (joined) => joined.includes("commit -m"),
            respond: () => {
                state.head = options.postCommitHead ?? NEW_HEAD;
                return result("");
            },
        },
    ];
    const respond = (args: ReadonlyArray<string>): CommandResult => {
        const joined = args.join(" ");
        commands.push(joined);
        const handler = handlers.find(({ match }) => match(joined));
        return handler === undefined ? result("") : handler.respond(joined);
    };
    return {
        run: async (_command, args) => respond(args),
        commands,
    };
};

const makeDeliveryService = (run: CommandRunnerService["run"]) =>
    makeGitRevisionDeliveryService(
        { run },
        makeGitRevisionCommitService({ run }),
        makeGitRemoteSafetyService({ run }),
    );
const deliveryInput = (): GitRevisionDeliveryInput => ({
    repository: REPOSITORY,
    repositoryPath: REPOSITORY_PATH,
    branch: BRANCH,
    baseSha: BASE,
    expectedPriorHeadSha: PRIOR_HEAD,
    expectedStagedTreeSha: APPROVED_TREE,
    message: COMMIT_MESSAGE,
});

const expectErrorKind = async (
    promise: Promise<unknown>,
    kind: GitRevisionDeliveryError["kind"],
): Promise<GitRevisionDeliveryError> => {
    let outcome: unknown;
    try {
        outcome = await promise;
    } catch (error) {
        outcome = error;
    }
    expect(outcome).toBeInstanceOf(GitRevisionDeliveryError);
    expect((outcome as GitRevisionDeliveryError).kind).toBe(kind);
    return outcome as GitRevisionDeliveryError;
};

describe("managed feature-branch revision delivery", () => {
    test("confirms a first delivery with non-force push and the explicit destination ref", async () => {
        const { run, commands } = makeRunner({ remoteHead: "" });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision({
            ...deliveryInput(),
            isFirstDelivery: true,
        })) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "confirmed",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
            remoteSha: NEW_HEAD,
            pushResponseLost: false,
        });
        const indexOf = (needle: string) =>
            commands.findIndex((command) => command.includes(needle));
        // Safety check before staging/commit...
        expect(
            indexOf("ls-remote origin refs/heads/ralphie/issue-42"),
        ).toBeGreaterThan(-1);
        expect(
            indexOf("ls-remote origin refs/heads/ralphie/issue-42"),
        ).toBeLessThan(indexOf("add --all"));
        // Re-check immediately before the push...
        expect(indexOf("push --no-force")).toBeGreaterThan(
            indexOf("commit -m"),
        );
        // Authoritative read after the push...
        expect(
            indexOf("ls-remote origin refs/heads/ralphie/issue-42"),
        ).toBeLessThan(indexOf("push --no-force"));
        expect(
            indexOf("push --no-force origin HEAD:refs/heads/ralphie/issue-42"),
        ).toBeGreaterThan(-1);
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("confirms a subsequent revision against the last delivered head", async () => {
        const { run, commands } = makeRunner({ remoteHead: PRIOR_HEAD });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "confirmed",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
            remoteSha: NEW_HEAD,
            pushResponseLost: false,
        });
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("reconciles a lost push response to confirmed success via the authoritative remote read", async () => {
        const { run } = makeRunner({
            remoteHead: PRIOR_HEAD,
            push: {
                exitCode: 1,
                stderr: "fatal: unable to access 'https://github.com/owner/repository.git/': Operation timed out",
                applyRemote: true,
            },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "confirmed",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
            remoteSha: NEW_HEAD,
            pushResponseLost: true,
        });
    });

    test("halts on external remote movement before any staging or commit", async () => {
        const { run, commands } = makeRunner({ remoteHead: OTHER });
        const delivery = makeDeliveryService(run);

        let error: unknown;
        try {
            await delivery.deliverRevision(deliveryInput());
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(GitManagedRevisionSafetyError);
        expect((error as GitManagedRevisionSafetyError).kind).toBe(
            "remote-moved",
        );
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
        expect(commands.some((command) => command.includes("commit -m"))).toBe(
            false,
        );
        expect(commands.some((command) => command.includes("push"))).toBe(
            false,
        );
    });

    test("halts on external remote movement between commit and push without pushing", async () => {
        const { run, commands } = makeRunner({
            remoteHead: PRIOR_HEAD,
            remoteHeadDuringRecheck: OTHER,
        });
        const delivery = makeDeliveryService(run);

        let error: unknown;
        try {
            await delivery.deliverRevision(deliveryInput());
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(GitManagedRevisionSafetyError);
        expect((error as GitManagedRevisionSafetyError).kind).toBe(
            "remote-moved",
        );
        expect(commands.some((command) => command.includes("commit -m"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("push"))).toBe(
            false,
        );
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("reports a non-fast-forward rejection as external movement without retrying", async () => {
        const { run, commands } = makeRunner({
            remoteHead: PRIOR_HEAD,
            push: {
                exitCode: 1,
                stderr:
                    "! [rejected]        ralphie/issue-42 -> ralphie/issue-42 (non-fast-forward)\n" +
                    "error: failed to push some refs to 'https://github.com/owner/repository.git'",
                moveRemoteTo: OTHER,
            },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "external-movement",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            expectedRemoteSha: PRIOR_HEAD,
            actualRemoteSha: OTHER,
            pushFailureKind: "non-fast-forward",
        });
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("reports a transport failure with the remote unchanged as ambiguous", async () => {
        const { run, commands } = makeRunner({
            remoteHead: PRIOR_HEAD,
            push: {
                exitCode: 1,
                stderr: "fatal: unable to access 'https://github.com/owner/repository.git/': Could not resolve host",
            },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "ambiguous",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            actualRemoteSha: PRIOR_HEAD,
            reason: "remote-unchanged",
            pushFailureKind: "other",
        });
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
    });

    test("reports a failed first delivery with no remote branch as ambiguous", async () => {
        const { run } = makeRunner({
            remoteHead: "",
            push: {
                exitCode: 1,
                stderr: "fatal: unable to access: Connection refused",
            },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision({
            ...deliveryInput(),
            isFirstDelivery: true,
        })) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "ambiguous",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            actualRemoteSha: "",
            reason: "remote-branch-missing",
            pushFailureKind: "other",
        });
    });

    test("does not claim success from a push response alone when the authoritative read is unusable", async () => {
        const { run } = makeRunner({
            remoteHead: PRIOR_HEAD,
            postPushRemote: { kind: "unparseable" },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "ambiguous",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            actualRemoteSha: "",
            reason: "remote-read-failed",
        });
    });

    test("does not claim success when the authoritative remote read command fails", async () => {
        const { run } = makeRunner({
            remoteHead: PRIOR_HEAD,
            postPushRemote: { kind: "exit-error" },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "ambiguous",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            actualRemoteSha: "",
            reason: "remote-read-failed",
        });
    });

    test("refuses to confirm when the checkout is dirty after the commit arrived", async () => {
        const { run } = makeRunner({
            remoteHead: PRIOR_HEAD,
            postPushStatus: " M leftover.ts",
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "ambiguous",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            actualRemoteSha: NEW_HEAD,
            reason: "checkout-not-clean",
        });
    });

    test("cancels before any mutation when requested before the safety check", async () => {
        let calls = 0;
        const { run, commands } = makeRunner({ remoteHead: PRIOR_HEAD });
        const delivery = makeDeliveryService(run);

        const error = await expectErrorKind(
            delivery.deliverRevision({
                ...deliveryInput(),
                context: {
                    isCancelled: () => {
                        calls += 1;
                        return calls >= 1;
                    },
                },
            }),
            "cancelled",
        );

        expect(error.message).toContain("no further mutation");
        expect(commands).toEqual([]);
    });

    test("cancels before the push, retaining the created clean commit", async () => {
        const { run, commands } = makeRunner({ remoteHead: PRIOR_HEAD });
        const delivery = makeDeliveryService(run);

        // Cancellation is consulted before the pre-push re-check, after the
        // exact-tree commit has already been created.
        const error = await expectErrorKind(
            delivery.deliverRevision({
                ...deliveryInput(),
                context: {
                    isCancelled: (() => {
                        let called = 0;
                        return () => {
                            called += 1;
                            return called === 6;
                        };
                    })(),
                },
            }),
            "cancelled",
        );

        expect(error.message).toContain("no further mutation");
        expect(commands.some((command) => command.includes("commit -m"))).toBe(
            true,
        );
        expect(commands.some((command) => command.includes("push"))).toBe(
            false,
        );
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("rejects an invalid delivery input without touching the checkout", async () => {
        const { run, commands } = makeRunner({ remoteHead: PRIOR_HEAD });
        const delivery = makeDeliveryService(run);

        await expectErrorKind(
            delivery.deliverRevision({
                ...deliveryInput(),
                repository: "",
            }),
            "invalid-input",
        );
        await expectErrorKind(
            delivery.deliverRevision({
                ...deliveryInput(),
                repositoryPath: "",
            }),
            "invalid-input",
        );

        expect(commands).toEqual([]);
    });

    test("retains the created commit and clean checkout for a subsequent revision after a rejected push", async () => {
        const { run, commands } = makeRunner({
            remoteHead: PRIOR_HEAD,
            push: {
                exitCode: 1,
                stderr: "! [rejected]        ralphie/issue-42 -> ralphie/issue-42 (fetch first)",
                moveRemoteTo: OTHER,
            },
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.deliverRevision(
            deliveryInput(),
        )) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "external-movement",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            expectedRemoteSha: PRIOR_HEAD,
            actualRemoteSha: OTHER,
            pushFailureKind: "non-fast-forward",
        });
        // The rejected push is attempted exactly once: no retries, no force.
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
        expect(
            commands.some((command) =>
                /reset|checkout|fetch|pull|--force/.test(command),
            ),
        ).toBe(false);
    });

    test("reconciles an interrupted revision by pushing the existing clean candidate once", async () => {
        const { run, commands } = makeRunner({
            localHead: NEW_HEAD,
            remoteHead: PRIOR_HEAD,
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.reconcileRevision?.({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedStagedTreeSha: APPROVED_TREE,
        })) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "confirmed",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
            remoteSha: NEW_HEAD,
            pushResponseLost: false,
        });
        expect(commands.some((command) => command.includes("add --all"))).toBe(
            false,
        );
        expect(commands.some((command) => command.includes("commit -m"))).toBe(
            false,
        );
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(1);
    });

    test("does not repeat a push when the interrupted revision is already remote", async () => {
        const { run, commands } = makeRunner({
            localHead: NEW_HEAD,
            remoteHead: NEW_HEAD,
        });
        const delivery = makeDeliveryService(run);

        const outcome = (await delivery.reconcileRevision?.({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedStagedTreeSha: APPROVED_TREE,
            expectedHeadSha: NEW_HEAD,
        })) as GitRevisionDeliveryOutcome;

        expect(outcome).toEqual({
            status: "confirmed",
            repository: REPOSITORY,
            branch: BRANCH,
            headSha: NEW_HEAD,
            parentSha: PRIOR_HEAD,
            treeSha: APPROVED_TREE,
            remoteSha: NEW_HEAD,
            pushResponseLost: true,
        });
        expect(
            commands.filter((command) => command.includes("push --no-force")),
        ).toHaveLength(0);
    });

    test("leaves no reconciliation work when the checkout is still at the recorded prior head", async () => {
        const { run, commands } = makeRunner({
            localHead: PRIOR_HEAD,
            remoteHead: PRIOR_HEAD,
        });
        const delivery = makeDeliveryService(run);

        const outcome = await delivery.reconcileRevision?.({
            repository: REPOSITORY,
            repositoryPath: REPOSITORY_PATH,
            branch: BRANCH,
            baseSha: BASE,
            expectedPriorHeadSha: PRIOR_HEAD,
            expectedStagedTreeSha: APPROVED_TREE,
        });

        expect(outcome).toBeUndefined();
        expect(commands).toHaveLength(2);
        expect(commands.some((command) => command.includes("push"))).toBe(
            false,
        );
    });

    test("rejects an interrupted revision whose exact tree no longer matches", async () => {
        const { run, commands } = makeRunner({
            localHead: NEW_HEAD,
            remoteHead: PRIOR_HEAD,
        });
        const delivery = makeDeliveryService(run);

        await expectErrorKind(
            delivery.reconcileRevision?.({
                repository: REPOSITORY,
                repositoryPath: REPOSITORY_PATH,
                branch: BRANCH,
                baseSha: BASE,
                expectedPriorHeadSha: PRIOR_HEAD,
                expectedStagedTreeSha: OTHER,
            }) ?? Promise.resolve(undefined),
            "invalid-input",
        );

        expect(commands.some((command) => command.includes("push"))).toBe(
            false,
        );
    });
});

describe("shared push classification regression", () => {
    test("classifies Git's non-fast-forward rejection responses", () => {
        expect(
            isNonFastForward("! [rejected]  main -> main (non-fast-forward)"),
        ).toBe(true);
        expect(
            isNonFastForward(
                "hint: Updates were rejected because the tip of your current branch is behind",
            ),
        ).toBe(true);
        expect(isNonFastForward("error: failed to push some refs")).toBe(false);
        expect(
            isNonFastForward(
                "fatal: unable to access 'https://github.com/owner/repository.git/': Operation timed out",
            ),
        ).toBe(false);
        expect(isNonFastForward("   bbbb  HEAD -> ralphie/issue-42")).toBe(
            false,
        );
    });

    test("exposes typed delivery errors for callers to distinguish", () => {
        expect(GitRevisionDeliveryError).toBeTypeOf("function");
    });
});