import type { CommitMessageDecision } from "../issues/decisions.ts";
import {
    CommandRunnerLive,
    type CommandRunnerService,
    type CommandResult,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { runGit } from "./run-git.ts";

export type GitRevisionCommitFailureKind =
    | "invalid-input"
    | "invalid-managed-checkout"
    | "stale-prior-head"
    | "empty-revision"
    | "out-of-scope-revision"
    | "cancelled"
    | "commit-verification-failed";

export class GitRevisionCommitError extends RalphieError {
    override readonly _tag = "GitRevisionCommitError";
    readonly kind: GitRevisionCommitFailureKind;

    constructor(input: {
        readonly kind: GitRevisionCommitFailureKind;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitRevisionCommitError";
        this.kind = input.kind;
    }
}

export type GitRevisionCommitResult = {
    /** The new feature head commit created by the revision. */
    readonly headSha: string;
    /** The expected prior feature head the revision was appended to. */
    readonly parentSha: string;
    /** The exact deterministic staged tree captured in the revision commit. */
    readonly treeSha: string;
};

/** Read-only view of the pending changes handed to the validation context. */
export type GitRevisionPendingChanges = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    /** Raw `git status --porcelain=v1` output before any index mutation. */
    readonly status: string;
};

export type GitRevisionCommitContext = {
    /**
     * Consulted before index mutation and immediately before the commit is
     * created. Returning `true` aborts with the typed `cancelled` failure
     * without discarding the intended fix.
     */
    readonly isCancelled?: () => boolean;
    /**
     * Local pre-index validation hook for the coordinator's scope policy.
     * Receives the pending changes and may reject an out-of-scope fix by
     * throwing (preferably a {@link GitRevisionCommitError} of kind
     * `out-of-scope-revision`).
     */
    readonly validate?: (
        pending: GitRevisionPendingChanges,
    ) => Promise<void> | void;
};

export type GitRevisionCommitInput = {
    /** Managed repository slug, e.g. `owner/repository`. */
    readonly repository: string;
    /** Git working tree checked out to the managed feature branch. */
    readonly repositoryPath: string;
    /** Managed feature branch expected to carry the new revision commit. */
    readonly branch: string;
    /**
     * Shared sequential-head contract: the exact feature head this revision
     * must extend. The explicitly identified first feature delivery may pass
     * the original PR/base commit as the prior head.
     */
    readonly expectedPriorHeadSha: string;
    /**
     * The allowed revision changes expressed in the repository's
     * deterministic staging convention: the exact staged-tree hash that
     * `git add --all` plus `git write-tree` must produce. Any drift is an
     * out-of-scope revision.
     */
    readonly expectedStagedTreeSha: string;
    /** Schema-valid commit message, re-validated locally before staging. */
    readonly message: CommitMessageDecision;
    /** Cancellation/validation context consulted at safe points. */
    readonly context?: GitRevisionCommitContext;
};

export type GitRevisionCommitService = {
    /**
     * Commit one approved revision with an exact deterministic staged tree.
     * The managed checkout must sit at the expected prior feature head; the
     * operation stages deterministically, creates exactly one commit from
     * the captured tree, and revalidates the resulting parent/tree without
     * leaving partially staged state. It never invokes the agent, GitHub, force
     * operations, or branch/reset operations that could discard external
     * work; pre-commit failures clean up only temporary index state, and a
     * created commit is retained for reconciliation.
     */
    readonly commitRevision: (
        input: GitRevisionCommitInput,
    ) => Promise<GitRevisionCommitResult>;
};

const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const validCommitMessage = (message: CommitMessageDecision): boolean =>
    message.subject.trim().length > 0 &&
    message.subject.length <= 72 &&
    (message.body === undefined || message.body.trim().length > 0);

const fail = (
    kind: GitRevisionCommitFailureKind,
    message: string,
    cause?: unknown,
): never => {
    throw new GitRevisionCommitError({ kind, message, cause });
};

const verifyRevisionInput = (input: GitRevisionCommitInput): void => {
    if (
        input.branch.trim().length === 0 ||
        input.branch !== input.branch.trim()
    ) {
        fail(
            "invalid-input",
            "Managed revision branch must be a non-empty Git branch name.",
        );
    }
    if (!validGitSha.test(input.expectedPriorHeadSha)) {
        fail(
            "invalid-input",
            `Refusing a revision with an invalid expected prior head: ${input.expectedPriorHeadSha}.`,
        );
    }
    if (!validGitSha.test(input.expectedStagedTreeSha)) {
        fail(
            "invalid-input",
            `Refusing a revision with an invalid expected staged tree: ${input.expectedStagedTreeSha}.`,
        );
    }
    if (!validCommitMessage(input.message)) {
        fail(
            "invalid-input",
            "Commit message subject must be non-empty and at most 72 characters; body must be non-empty when provided.",
        );
    }
};

const cancellationCheck = (isCancelled: (() => boolean) | undefined): void => {
    if (isCancelled?.() === true) {
        fail("cancelled", "Revision commit cancelled; no commit was created.");
    }
};

const verifyNoPreStagedChanges = (result: CommandResult): void => {
    if (result.exitCode === 1) {
        fail(
            "invalid-input",
            "Refusing a revision commit over already-staged changes; start from the clean sequential head.",
        );
    }
    if (result.exitCode !== 0) {
        const detail = result.stderr ? ` ${result.stderr}` : "";
        fail(
            "invalid-input",
            `Failed to inspect pre-staged revision changes.${detail}`,
        );
    }
};

const revalidateCreatedCommit = async (
    runner: CommandRunnerService,
    input: GitRevisionCommitInput,
    capturedTree: string,
): Promise<GitRevisionCommitResult> => {
    const headSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "Failed to verify the revision commit.",
    );
    const parentSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "HEAD^"],
        "Failed to read the revision parent.",
    );
    const treeSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "HEAD^{tree}"],
        "Failed to read the revision tree.",
    );
    const commitCount = await runGit(
        runner,
        input.repositoryPath,
        ["rev-list", "--count", `${input.expectedPriorHeadSha}..HEAD`],
        "Failed to count the revision commits.",
    );
    const finalStatus = await runGit(
        runner,
        input.repositoryPath,
        ["status", "--porcelain=v1"],
        "Failed to check the revision status after commit.",
    );

    const mismatches: string[] = [];
    if (!validGitSha.test(headSha)) {
        mismatches.push(`invalid head ${headSha}`);
    }
    if (parentSha.toLowerCase() !== input.expectedPriorHeadSha.toLowerCase()) {
        mismatches.push(`parent ${parentSha}`);
    }
    if (treeSha.toLowerCase() !== capturedTree.toLowerCase()) {
        mismatches.push(`tree ${treeSha}`);
    }
    if (commitCount !== "1") {
        mismatches.push(`${commitCount} commits ahead`);
    }
    if (finalStatus !== "") {
        mismatches.push("dirty checkout");
    }
    if (mismatches.length > 0) {
        fail(
            "commit-verification-failed",
            `Created revision commit ${headSha} failed revalidation: ${mismatches.join(", ")}.`,
        );
    }
    return { headSha, parentSha, treeSha };
};

export const makeGitRevisionCommitService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitRevisionCommitService => {
    const currentBranch = (repositoryPath: string) =>
        runGit(
            runner,
            repositoryPath,
            ["rev-parse", "--abbrev-ref", "HEAD"],
            "Failed to read the managed revision branch.",
        );

    const headCommit = (repositoryPath: string) =>
        runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the managed revision HEAD.",
        );

    const status = (repositoryPath: string) =>
        runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to inspect the managed revision status.",
        );

    const treeOf = (repositoryPath: string, sha: string) =>
        runGit(
            runner,
            repositoryPath,
            ["rev-parse", `${sha}^{tree}`],
            "Failed to resolve a revision tree.",
        );

    /** Restore only temporary index state; never moves the branch ref and never discards working-tree changes. */
    const unstage = async (repositoryPath: string): Promise<void> => {
        await runGit(
            runner,
            repositoryPath,
            ["reset"],
            "Failed to unstage the rejected revision.",
        );
    };

    const verifyManagedSequentialHead = async (
        input: GitRevisionCommitInput,
    ): Promise<void> => {
        const actualBranch = await currentBranch(input.repositoryPath);
        if (actualBranch !== input.branch) {
            fail(
                "invalid-managed-checkout",
                `Managed checkout is on ${actualBranch}, expected ${input.branch}.`,
            );
        }
        const head = await headCommit(input.repositoryPath);
        if (head.toLowerCase() !== input.expectedPriorHeadSha.toLowerCase()) {
            fail(
                "stale-prior-head",
                `Local HEAD ${head} is stale: expected prior feature head ${input.expectedPriorHeadSha}; refusing to revise over a drifted checkout.`,
            );
        }
        const checkoutStatus = await status(input.repositoryPath);
        if (checkoutStatus === "") {
            fail(
                "empty-revision",
                "Refusing to commit an empty revision: the managed checkout has no changes.",
            );
        }
        verifyNoPreStagedChanges(
            await runner.run("git", [
                "-C",
                input.repositoryPath,
                "diff",
                "--cached",
                "--quiet",
            ]),
        );
        await input.context?.validate?.({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            status: checkoutStatus,
        });
    };

    const stageAndCommit = async (
        input: GitRevisionCommitInput,
    ): Promise<string> => {
        let createdCommit = false;
        let capturedTree = "";
        try {
            await runGit(
                runner,
                input.repositoryPath,
                ["add", "--all"],
                "Failed to stage the approved revision.",
            );
            capturedTree = await runGit(
                runner,
                input.repositoryPath,
                ["write-tree"],
                "Failed to capture the staged revision tree.",
            );
            const priorTree = await treeOf(
                input.repositoryPath,
                input.expectedPriorHeadSha,
            );
            if (capturedTree.toLowerCase() === priorTree.toLowerCase()) {
                fail(
                    "empty-revision",
                    "Refusing to commit an empty revision: the staged tree matches the prior feature head.",
                );
            }
            if (
                capturedTree.toLowerCase() !==
                input.expectedStagedTreeSha.toLowerCase()
            ) {
                fail(
                    "out-of-scope-revision",
                    `Staged revision tree ${capturedTree} differs from the allowed revision tree ${input.expectedStagedTreeSha}.`,
                );
            }
            cancellationCheck(input.context?.isCancelled);

            const commitArgs = ["commit", "-m", input.message.subject];
            if (input.message.body !== undefined) {
                commitArgs.push("-m", input.message.body);
            }
            await runGit(
                runner,
                input.repositoryPath,
                commitArgs,
                "Failed to commit the approved revision.",
            );
            createdCommit = true;
        } catch (error) {
            // Pre-commit failures clean up only the temporary index state;
            // the intended fix stays in the working tree.
            if (!createdCommit) {
                await unstage(input.repositoryPath).catch(() => undefined);
            }
            throw error;
        }
        return capturedTree;
    };

    return {
        commitRevision: async (input) => {
            verifyRevisionInput(input);
            cancellationCheck(input.context?.isCancelled);

            // Before any index mutation: the managed checkout must sit at the
            // expected prior feature head with a non-empty, in-scope fix.
            await verifyManagedSequentialHead(input);
            cancellationCheck(input.context?.isCancelled);

            const capturedTree = await stageAndCommit(input);

            // Once the commit exists it is retained for reconciliation;
            // revalidation failures never reset it.
            return await revalidateCreatedCommit(runner, input, capturedTree);
        },
    };
};

export const GitRevisionCommitLive = makeGitRevisionCommitService;