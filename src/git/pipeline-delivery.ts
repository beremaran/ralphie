import type { CommitMessageDecision } from "../issues/decisions.ts";
import {
    CommandRunnerLive,
    type CommandResult,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { runGit } from "./run-git.ts";

/** Git object IDs are kept full at every delivery boundary. */
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type PipelineCheckoutState = {
    readonly branch: string;
    readonly head: string;
    readonly status: string;
};

export type PipelineCommitResult = {
    readonly sha: string;
    readonly parentSha: string;
    readonly treeSha: string;
};

export type PipelinePushFailureKind = "non-fast-forward" | "other";

/**
 * A push response is deliberately not a delivery result.  The caller must
 * read the remote branch after this response and reconcile the expected SHA.
 */
export type PipelinePushAttempt = {
    readonly response: "accepted" | "rejected";
    readonly failureKind?: PipelinePushFailureKind;
    readonly output: string;
};

export type PipelineDeliveryGitService = {
    /** Read the authoritative origin/<branch> commit, or "" when absent. */
    readonly readRemoteHead: (
        repositoryPath: string,
        branch: string,
        signal?: AbortSignal,
    ) => Promise<string>;
    /**
     * Fetch and prepare a clean local branch at the exact remote SHA.  This
     * operation refuses to reset the checkout when the remote moved while it
     * was being prepared.
     */
    readonly prepareExactCheckout: (
        repositoryPath: string,
        branch: string,
        expectedRemoteSha: string,
        signal?: AbortSignal,
    ) => Promise<void>;
    /**
     * Discard only the current repair's edits after proving local branch/HEAD
     * still equal the expected checkpoint.  It never follows a moved branch.
     */
    readonly discardToExactCheckout: (
        repositoryPath: string,
        branch: string,
        expectedLocalSha: string,
        signal?: AbortSignal,
    ) => Promise<void>;
    readonly readCheckout: (
        repositoryPath: string,
        signal?: AbortSignal,
    ) => Promise<PipelineCheckoutState>;
    /** Return the exact tree currently represented by the Git index. */
    readonly readStagedTreeSha: (
        repositoryPath: string,
        signal?: AbortSignal,
    ) => Promise<string>;
    /**
     * Commit exactly the expected index tree on the expected parent.  The
     * commit is retained if post-commit verification fails; callers must
     * reconcile the local and remote heads before doing anything else.
     */
    readonly commitStaged: (input: {
        readonly repositoryPath: string;
        readonly branch: string;
        readonly expectedParentSha: string;
        readonly expectedTreeSha: string;
        readonly message: CommitMessageDecision;
        readonly signal?: AbortSignal;
    }) => Promise<PipelineCommitResult>;
    /** Attempt an explicit non-force push; never reads or mutates GitHub. */
    readonly pushNonForce: (input: {
        readonly repositoryPath: string;
        readonly branch: string;
        readonly expectedCommitSha: string;
        readonly signal?: AbortSignal;
    }) => Promise<PipelinePushAttempt>;
};

export class PipelineDeliveryGitError extends RalphieError {
    override readonly _tag = "PipelineDeliveryGitError" as const;
    readonly kind:
        | "invalid-input"
        | "dirty-checkout"
        | "remote-moved"
        | "remote-missing"
        | "verification-failed";

    constructor(input: {
        readonly kind:
            | "invalid-input"
            | "dirty-checkout"
            | "remote-moved"
            | "remote-missing"
            | "verification-failed";
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "PipelineDeliveryGitError";
        this.kind = input.kind;
    }
}

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const nonBlank = (value: string): boolean => value.trim().length > 0;

const validSha = (value: string): boolean => FULL_GIT_OBJECT_ID.test(value);

const validMessage = (message: CommitMessageDecision): boolean =>
    nonBlank(message.subject) &&
    message.subject.length <= 72 &&
    (message.body === undefined || nonBlank(message.body));

const assertSha = (value: string, description: string): void => {
    if (!validSha(value)) {
        throw new PipelineDeliveryGitError({
            kind: "invalid-input",
            message: `${description} must be a full Git object ID: ${value}.`,
        });
    }
};

const assertBranch = (branch: string): void => {
    if (!nonBlank(branch) || branch !== branch.trim()) {
        throw new PipelineDeliveryGitError({
            kind: "invalid-input",
            message: "Pipeline delivery requires a non-empty branch name.",
        });
    }
};

const assertMessage = (message: CommitMessageDecision): void => {
    if (!validMessage(message)) {
        throw new PipelineDeliveryGitError({
            kind: "invalid-input",
            message:
                "Pipeline commit message subject must be non-empty and at most 72 characters; body must be non-empty when provided.",
        });
    }
};

const outputOf = (result: CommandResult): string =>
    [result.stdout, result.stderr]
        .filter((value) => value.length > 0)
        .join("\n");

const sameBranchAndHead = (
    actual: PipelineCheckoutState,
    branch: string,
    head: string,
): boolean => actual.branch === branch && sameSha(actual.head, head);

const checkRef = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string,
    signal?: AbortSignal,
): Promise<void> => {
    const result = await runner.run(
        "git",
        ["-C", repositoryPath, "check-ref-format", "--branch", branch],
        signal === undefined ? undefined : { signal },
    );
    if (result.exitCode !== 0) {
        throw new PipelineDeliveryGitError({
            kind: "invalid-input",
            message:
                `Pipeline delivery branch is not a valid Git branch: ${branch}. ${outputOf(result)}`.trim(),
        });
    }
};

const readBranch = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<string> =>
    runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        "Failed to read the pipeline delivery branch",
        true,
        signal,
    );

const readHead = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<string> =>
    runGit(
        runner,
        repositoryPath,
        ["rev-parse", "HEAD"],
        "Failed to read the pipeline delivery HEAD",
        true,
        signal,
    );

const readStatus = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<string> =>
    runGit(
        runner,
        repositoryPath,
        ["status", "--porcelain=v1"],
        "Failed to inspect the pipeline delivery checkout",
        true,
        signal,
    );

const readCheckout = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<PipelineCheckoutState> => {
    const [branch, head, status] = await Promise.all([
        readBranch(runner, repositoryPath, signal),
        readHead(runner, repositoryPath, signal),
        readStatus(runner, repositoryPath, signal),
    ]);
    if (!nonBlank(branch) || !validSha(head)) {
        throw new PipelineDeliveryGitError({
            kind: "verification-failed",
            message:
                "Pipeline delivery checkout did not report a branch and full HEAD.",
        });
    }
    return { branch, head, status };
};

const remoteHead = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string,
    signal?: AbortSignal,
): Promise<string> => {
    const result = await runner.run(
        "git",
        ["-C", repositoryPath, "ls-remote", "origin", `refs/heads/${branch}`],
        signal === undefined ? undefined : { signal },
    );
    if (result.exitCode !== 0) {
        throw new PipelineDeliveryGitError({
            kind: "verification-failed",
            message:
                `Failed to read origin/${branch}. ${outputOf(result)}`.trim(),
        });
    }
    const line = result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value.length > 0);
    if (line === undefined) return "";
    const [sha, ref, ...extra] = line.split(/\s+/);
    if (
        extra.length > 0 ||
        ref !== `refs/heads/${branch}` ||
        !validSha(sha ?? "")
    ) {
        throw new PipelineDeliveryGitError({
            kind: "verification-failed",
            message: `origin/${branch} returned an invalid branch head: ${line}.`,
        });
    }
    return sha ?? "";
};

const requireClean = (
    checkout: PipelineCheckoutState,
    description: string,
): void => {
    if (checkout.status !== "") {
        throw new PipelineDeliveryGitError({
            kind: "dirty-checkout",
            message: `${description} requires a clean checkout; found:\n${checkout.status}`,
        });
    }
};

const assertRemote = (
    actual: string,
    expected: string,
    branch: string,
): void => {
    if (actual === "") {
        throw new PipelineDeliveryGitError({
            kind: "remote-missing",
            message: `origin/${branch} does not exist; expected ${expected}.`,
        });
    }
    if (!sameSha(actual, expected)) {
        throw new PipelineDeliveryGitError({
            kind: "remote-moved",
            message: `origin/${branch} moved from ${expected} to ${actual} while the checkout was being prepared.`,
        });
    }
};

const commitOutput = (result: CommandResult): string => outputOf(result);

const isNonFastForward = (output: string): boolean =>
    /non-fast-forward|fetch first|remote contains work|tip of your current branch is behind/i.test(
        output,
    );

export const makePipelineDeliveryGitService = (
    runner: CommandRunnerService = CommandRunnerLive,
): PipelineDeliveryGitService => ({
    readRemoteHead: async (repositoryPath, branch, signal) => {
        assertBranch(branch);
        await checkRef(runner, repositoryPath, branch, signal);
        return remoteHead(runner, repositoryPath, branch, signal);
    },

    prepareExactCheckout: async (
        repositoryPath,
        branch,
        expectedRemoteSha,
        signal,
    ) => {
        assertBranch(branch);
        assertSha(expectedRemoteSha, "Expected pipeline remote SHA");
        await checkRef(runner, repositoryPath, branch, signal);
        const before = await readCheckout(runner, repositoryPath, signal);
        requireClean(before, "Preparing the pipeline delivery checkout");

        if (before.branch !== branch) {
            await runGit(
                runner,
                repositoryPath,
                ["checkout", branch],
                `Failed to checkout pipeline branch ${branch}`,
                true,
                signal,
            );
        }

        await runGit(
            runner,
            repositoryPath,
            ["fetch", "--prune", "origin", branch],
            `Failed to fetch origin/${branch} before pipeline repair`,
            true,
            signal,
        );
        const fetchedRemote = await remoteHead(
            runner,
            repositoryPath,
            branch,
            signal,
        );
        assertRemote(fetchedRemote, expectedRemoteSha, branch);

        await runGit(
            runner,
            repositoryPath,
            ["reset", "--hard", expectedRemoteSha],
            "Failed to prepare the exact pipeline repair checkpoint",
            true,
            signal,
        );
        await runGit(
            runner,
            repositoryPath,
            ["clean", "-fd"],
            "Failed to remove stale pipeline repair files",
            true,
            signal,
        );

        const after = await readCheckout(runner, repositoryPath, signal);
        if (
            !sameBranchAndHead(after, branch, expectedRemoteSha) ||
            after.status !== ""
        ) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Pipeline repair checkout was not prepared at clean ${branch}@${expectedRemoteSha}.`,
            });
        }
        const afterRemote = await remoteHead(
            runner,
            repositoryPath,
            branch,
            signal,
        );
        assertRemote(afterRemote, expectedRemoteSha, branch);
    },

    discardToExactCheckout: async (
        repositoryPath,
        branch,
        expectedLocalSha,
        signal,
    ) => {
        assertBranch(branch);
        assertSha(expectedLocalSha, "Expected local pipeline checkpoint SHA");
        await checkRef(runner, repositoryPath, branch, signal);
        const before = await readCheckout(runner, repositoryPath, signal);
        if (!sameBranchAndHead(before, branch, expectedLocalSha)) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Refusing to discard pipeline edits: expected local ${branch}@${expectedLocalSha}, found ${before.branch}@${before.head}.`,
            });
        }
        await runGit(
            runner,
            repositoryPath,
            ["reset", "--hard", expectedLocalSha],
            "Failed to discard stale pipeline repair edits",
            true,
            signal,
        );
        await runGit(
            runner,
            repositoryPath,
            ["clean", "-fd"],
            "Failed to remove stale pipeline repair files",
            true,
            signal,
        );
        const after = await readCheckout(runner, repositoryPath, signal);
        if (
            !sameBranchAndHead(after, branch, expectedLocalSha) ||
            after.status !== ""
        ) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Stale pipeline repair edits were not discarded from clean ${branch}@${expectedLocalSha}.`,
            });
        }
    },

    readCheckout: (repositoryPath, signal) =>
        readCheckout(runner, repositoryPath, signal),

    readStagedTreeSha: async (repositoryPath, signal) => {
        const tree = await runGit(
            runner,
            repositoryPath,
            ["write-tree"],
            "Failed to read the staged pipeline repair tree",
            true,
            signal,
        );
        assertSha(tree, "Staged pipeline repair tree");
        return tree;
    },

    commitStaged: async ({
        repositoryPath,
        branch,
        expectedParentSha,
        expectedTreeSha,
        message,
        signal,
    }) => {
        assertBranch(branch);
        assertSha(expectedParentSha, "Expected pipeline commit parent");
        assertSha(expectedTreeSha, "Expected staged pipeline tree");
        assertMessage(message);
        const before = await readCheckout(runner, repositoryPath, signal);
        if (!sameBranchAndHead(before, branch, expectedParentSha)) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Refusing to commit pipeline repair: expected clean ${branch}@${expectedParentSha}, found ${before.branch}@${before.head}.`,
            });
        }
        const stagedTree = await runGit(
            runner,
            repositoryPath,
            ["write-tree"],
            "Failed to capture the staged pipeline repair tree",
            true,
            signal,
        );
        if (!sameSha(stagedTree, expectedTreeSha)) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Staged pipeline tree changed from ${expectedTreeSha} to ${stagedTree}; refusing to commit.`,
            });
        }

        const args = ["commit", "-m", message.subject];
        if (message.body !== undefined) args.push("-m", message.body);
        await runGit(
            runner,
            repositoryPath,
            args,
            "Failed to commit the approved pipeline repair",
            true,
            signal,
        );
        const [sha, parentSha, treeSha, after] = await Promise.all([
            readHead(runner, repositoryPath, signal),
            runGit(
                runner,
                repositoryPath,
                ["rev-parse", "HEAD^"],
                "Failed to read the pipeline repair commit parent",
                true,
                signal,
            ),
            runGit(
                runner,
                repositoryPath,
                ["rev-parse", "HEAD^{tree}"],
                "Failed to verify the pipeline repair commit tree",
                true,
                signal,
            ),
            readCheckout(runner, repositoryPath, signal),
        ]);
        if (
            !validSha(sha) ||
            !sameSha(parentSha, expectedParentSha) ||
            !sameSha(treeSha, expectedTreeSha) ||
            !sameBranchAndHead(after, branch, sha) ||
            after.status !== ""
        ) {
            throw new PipelineDeliveryGitError({
                kind: "verification-failed",
                message: `Created pipeline commit ${sha} failed exact parent/tree/clean-checkout verification.`,
            });
        }
        return { sha, parentSha, treeSha };
    },

    pushNonForce: async ({
        repositoryPath,
        branch,
        expectedCommitSha,
        signal,
    }) => {
        assertBranch(branch);
        assertSha(expectedCommitSha, "Expected pipeline commit");
        const result = await runner.run(
            "git",
            [
                "-C",
                repositoryPath,
                "push",
                "--no-force",
                "origin",
                `HEAD:refs/heads/${branch}`,
            ],
            signal === undefined ? undefined : { signal },
        );
        const output = commitOutput(result);
        if (result.exitCode === 0) {
            return { response: "accepted", output };
        }
        return {
            response: "rejected",
            failureKind: isNonFastForward(output)
                ? "non-fast-forward"
                : "other",
            output,
        };
    },
});

export const PipelineDeliveryGitLive = makePipelineDeliveryGitService;