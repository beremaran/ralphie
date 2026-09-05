import type { CommitMessageDecision } from "../issues/decisions.ts";
import {
    CommandRunnerLive,
    type CommandResult,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import {
    isNonFastForward,
    type GitPushFailureKind,
} from "./issue-operations.ts";
import type { GitRemoteSafetyService } from "./remote-safety.ts";
import {
    type GitRevisionCommitContext,
    type GitRevisionCommitService,
} from "./revision-commit.ts";
import { runGit } from "./run-git.ts";

export type GitRevisionDeliveryFailureKind = "invalid-input" | "cancelled";

export class GitRevisionDeliveryError extends RalphieError {
    override readonly _tag = "GitRevisionDeliveryError";
    readonly kind: GitRevisionDeliveryFailureKind;

    constructor(input: {
        readonly kind: GitRevisionDeliveryFailureKind;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitRevisionDeliveryError";
        this.kind = input.kind;
    }
}

export type GitRevisionAmbiguousReason =
    | "remote-read-failed"
    | "remote-branch-missing"
    | "remote-unchanged"
    | "checkout-not-clean";

/** The discriminated delivery outcome a coordinator can act on. */
export type GitRevisionDeliveryOutcome =
    | {
          readonly status: "confirmed";
          readonly repository: string;
          readonly branch: string;
          readonly headSha: string;
          readonly parentSha: string;
          readonly treeSha: string;
          /** Remote branch head read via `git ls-remote` after the push. */
          readonly remoteSha: string;
          /**
           * True when the push command itself failed (transport error or lost
           * response) but the authoritative remote read reconciled the
           * delivery to the new commit.
           */
          readonly pushResponseLost: boolean;
      }
    | {
          readonly status: "external-movement";
          readonly repository: string;
          readonly branch: string;
          readonly headSha: string;
          readonly parentSha: string;
          /** The expected remote head the delivery would have extended. */
          readonly expectedRemoteSha: string;
          /** The remote head observed by the authoritative read after the push attempt. */
          readonly actualRemoteSha: string;
          /** Set when the push command itself was rejected. */
          readonly pushFailureKind?: GitPushFailureKind;
      }
    | {
          readonly status: "ambiguous";
          readonly repository: string;
          readonly branch: string;
          readonly headSha: string;
          readonly parentSha: string;
          /** Remote head observed by the authoritative read; "" when the read could not prove any value. */
          readonly actualRemoteSha: string;
          readonly reason: GitRevisionAmbiguousReason;
          /** Set when the push command itself failed. */
          readonly pushFailureKind?: GitPushFailureKind;
      };

export type GitRevisionDeliveryInput = {
    /** Managed repository slug, e.g. `owner/repository`. */
    readonly repository: string;
    /** Git working tree checked out to the managed feature branch. */
    readonly repositoryPath: string;
    /** Managed feature branch expected to carry the new revision commit. */
    readonly branch: string;
    /** The exact original PR/base commit the managed feature branch was created from. */
    readonly baseSha: string;
    /** The shared sequential-head contract the revision must extend. */
    readonly expectedPriorHeadSha: string;
    /** The exact deterministic staged tree the revision commit must capture. */
    readonly expectedStagedTreeSha: string;
    /** Schema-valid commit message, re-validated locally before staging. */
    readonly message: CommitMessageDecision;
    /** Identifies the first feature delivery; only then may the remote branch be absent. */
    readonly isFirstDelivery?: boolean;
    /** Cancellation/validation context consulted at every mutation boundary. */
    readonly context?: GitRevisionCommitContext;
};

/**
 * Resume-only input for a revision whose commit/push boundary was interrupted.
 * The service discovers the existing local candidate instead of creating a
 * second commit, then reconciles or performs the one safe non-force push.
 */
export type GitRevisionReconciliationInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly baseSha: string;
    readonly expectedPriorHeadSha: string;
    /** The exact tree recorded for the interrupted revision, when known. */
    readonly expectedStagedTreeSha?: string;
    /** Optional candidate head recorded after a prior reconciliation step. */
    readonly expectedHeadSha?: string;
    readonly context?: GitRevisionCommitContext;
};

export type GitRevisionDeliveryService = {
    /**
     * Deliver one approved revision as a single deterministic operation. The
     * managed revision safety check runs before staging/commit (external
     * movement there fails as {@link GitManagedRevisionSafetyError} without
     * staging or committing), the exact-tree revision commit creates the
     * feature head, the safety check runs again on the local branch/parent and
     * remote feature/PR head immediately before the push, and the push uses
     * only Git's non-force mode with the explicit destination ref. After both
     * a successful push and a push/transport error the authoritative remote
     * branch is read with `git ls-remote`; success is never inferred from a
     * command response or tracking ref alone. Returns a discriminated outcome:
     * `confirmed` (remote equals the new commit and the checkout is clean,
     * including a lost push response reconciled to success),
     * `external-movement` (the remote no longer equals the expected prior
     * head; halt without retrying or overwriting), or `ambiguous` (the
     * remote read cannot prove whether the new commit arrived; the created
     * clean commit is retained for safe reconciliation). Never force-pushes,
     * never retries a push, and never resets or follows a moved remote;
     * failures leave a clean, recoverable checkout.
     */
    readonly deliverRevision: (
        input: GitRevisionDeliveryInput,
    ) => Promise<GitRevisionDeliveryOutcome>;
    /** Reconcile an already-created local revision without creating another commit. */
    readonly reconcileRevision?: (
        input: GitRevisionReconciliationInput,
    ) => Promise<GitRevisionDeliveryOutcome | undefined>;
};

const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const fail = (
    kind: GitRevisionDeliveryFailureKind,
    message: string,
    cause?: unknown,
): never => {
    throw new GitRevisionDeliveryError({ kind, message, cause });
};

const cancellationCheck = (isCancelled: (() => boolean) | undefined): void => {
    if (isCancelled?.() === true) {
        fail("cancelled", "Revision delivery cancelled; no further mutation.");
    }
};

const verifyRevisionDeliveryInput = (input: GitRevisionDeliveryInput): void => {
    if (
        input.repository.trim().length === 0 ||
        input.repositoryPath.trim().length === 0
    ) {
        fail(
            "invalid-input",
            "A managed repository and repository path are required for revision delivery.",
        );
    }
    // Branch, expected prior head, staged tree, and commit message are
    // re-validated by the exact-tree commit operation before any mutation.
};

/** A push that failed locally, whose remote effect is intentionally unresolved. */
type PushAttempt = {
    readonly failed: boolean;
    readonly failureKind: GitPushFailureKind | undefined;
};

const pushNonForce = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string,
): Promise<PushAttempt> => {
    let result: CommandResult;
    try {
        result = await runner.run("git", [
            "-C",
            repositoryPath,
            "push",
            "--no-force",
            "origin",
            `HEAD:refs/heads/${branch}`,
        ]);
    } catch {
        // The response was lost; only the authoritative read can resolve it.
        return { failed: true, failureKind: undefined };
    }
    if (result.exitCode === 0) return { failed: false, failureKind: undefined };
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
        failed: true,
        failureKind: isNonFastForward(output) ? "non-fast-forward" : "other",
    };
};

type RemoteHeadRead =
    | { readonly available: true; readonly sha: string }
    | { readonly available: false };

const readRemoteHead = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string,
): Promise<RemoteHeadRead> => {
    let output: string;
    try {
        output = await runGit(
            runner,
            repositoryPath,
            ["ls-remote", "origin", `refs/heads/${branch}`],
            "Failed to read the authoritative remote branch.",
        );
    } catch {
        return { available: false };
    }
    const sha = output.split(/\s+/)[0] ?? "";
    return { available: sha.length === 0 || validGitSha.test(sha), sha };
};

const checkoutStatus = async (
    runner: CommandRunnerService,
    repositoryPath: string,
): Promise<string | undefined> => {
    try {
        return await runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to inspect the revision checkout.",
        );
    } catch {
        return undefined;
    }
};

type RevisionDeliveryIdentity = Pick<
    GitRevisionDeliveryInput,
    "repository" | "repositoryPath" | "branch" | "expectedPriorHeadSha"
>;

const deliveryBase = (
    input: RevisionDeliveryIdentity,
    headSha: string,
    parentSha: string,
) => ({
    repository: input.repository,
    branch: input.branch,
    headSha,
    parentSha,
});

type DeliveryBase = ReturnType<typeof deliveryBase>;

const ambiguousDelivery = (
    base: DeliveryBase,
    actualRemoteSha: string,
    reason: GitRevisionAmbiguousReason,
    pushFailureKind: GitPushFailureKind | undefined,
): GitRevisionDeliveryOutcome => ({
    status: "ambiguous",
    ...base,
    actualRemoteSha,
    reason,
    ...(pushFailureKind === undefined ? {} : { pushFailureKind }),
});

const externalMovement = (
    base: DeliveryBase,
    input: Pick<GitRevisionDeliveryInput, "expectedPriorHeadSha">,
    actualRemoteSha: string,
    pushFailureKind: GitPushFailureKind | undefined,
): GitRevisionDeliveryOutcome => ({
    status: "external-movement",
    ...base,
    expectedRemoteSha: input.expectedPriorHeadSha,
    actualRemoteSha,
    ...(pushFailureKind === undefined ? {} : { pushFailureKind }),
});

const classifyObservedRemote = async (
    runner: CommandRunnerService,
    input: RevisionDeliveryIdentity,
    isFirstDelivery: boolean,
    observed: string,
    base: DeliveryBase,
    headSha: string,
    treeSha: string,
    push: PushAttempt,
): Promise<GitRevisionDeliveryOutcome> => {
    const pushFailureKind = push.failed ? push.failureKind : undefined;
    if (observed === headSha.toLowerCase()) {
        const finalStatus = await checkoutStatus(runner, input.repositoryPath);
        if (finalStatus === "") {
            return {
                status: "confirmed",
                ...base,
                treeSha,
                remoteSha: observed,
                pushResponseLost: push.failed,
            };
        }
        // The commit arrived but the clean-checkout half of confirmed
        // success cannot be proven; require safe reconciliation.
        return ambiguousDelivery(
            base,
            observed,
            "checkout-not-clean",
            pushFailureKind,
        );
    }
    if (observed.length === 0) {
        if (!isFirstDelivery) {
            // A branch that existed at the re-check vanished before the read.
            return externalMovement(base, input, "", pushFailureKind);
        }
        return ambiguousDelivery(
            base,
            "",
            "remote-branch-missing",
            pushFailureKind,
        );
    }
    if (observed !== input.expectedPriorHeadSha.toLowerCase()) {
        // The remote no longer equals the expected prior head: halt without
        // retrying or overwriting.
        return externalMovement(base, input, observed, pushFailureKind);
    }
    // The remote still sits at the expected prior head: nothing landed, so
    // the read cannot prove whether the new commit arrived. Retain the
    // created clean commit and require safe reconciliation.
    return ambiguousDelivery(
        base,
        observed,
        "remote-unchanged",
        pushFailureKind,
    );
};

const classifyDelivery = async (
    runner: CommandRunnerService,
    input: GitRevisionDeliveryInput,
    isFirstDelivery: boolean,
    push: PushAttempt,
    remote: RemoteHeadRead,
    headSha: string,
    parentSha: string,
    treeSha: string,
): Promise<GitRevisionDeliveryOutcome> => {
    const base = deliveryBase(input, headSha, parentSha);
    const pushFailureKind = push.failed ? push.failureKind : undefined;
    if (!remote.available) {
        // The authoritative read cannot prove whether the new commit arrived.
        return ambiguousDelivery(
            base,
            "",
            "remote-read-failed",
            pushFailureKind,
        );
    }
    return await classifyObservedRemote(
        runner,
        input,
        isFirstDelivery,
        remote.sha.toLowerCase(),
        base,
        headSha,
        treeSha,
        push,
    );
};

const verifyReconciliationInput = (
    input: GitRevisionReconciliationInput,
): void => {
    if (
        input.repository.trim().length === 0 ||
        input.repositoryPath.trim().length === 0 ||
        input.branch.trim().length === 0 ||
        !validGitSha.test(input.baseSha) ||
        !validGitSha.test(input.expectedPriorHeadSha) ||
        (input.expectedStagedTreeSha !== undefined &&
            !validGitSha.test(input.expectedStagedTreeSha)) ||
        (input.expectedHeadSha !== undefined &&
            !validGitSha.test(input.expectedHeadSha))
    ) {
        fail(
            "invalid-input",
            "Revision reconciliation requires a repository, branch, base, and valid prior head.",
        );
    }
};

/**
 * Reconcile a commit that may have been created before cancellation or a lost
 * process response. The local candidate must be exactly one commit over the
 * recorded prior head. If the remote already has it, no push is repeated; if
 * the remote still has the prior head, one normal non-force push is attempted.
 */
const reconcileRevision = async (
    input: GitRevisionReconciliationInput,
    runner: CommandRunnerService,
    remoteSafety: GitRemoteSafetyService,
): Promise<GitRevisionDeliveryOutcome | undefined> => {
    verifyReconciliationInput(input);
    cancellationCheck(input.context?.isCancelled);

    const actualBranch = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        "Failed to read the managed revision branch during reconciliation.",
    );
    if (actualBranch !== input.branch) {
        fail(
            "invalid-input",
            `Managed checkout is on ${actualBranch}, expected ${input.branch}; refusing revision reconciliation.`,
        );
    }

    const headSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "Failed to read the local revision candidate.",
    );
    if (sameSha(headSha, input.expectedPriorHeadSha)) return undefined;
    if (
        input.expectedHeadSha !== undefined &&
        !sameSha(headSha, input.expectedHeadSha)
    ) {
        fail(
            "invalid-input",
            `Local revision candidate ${headSha} does not match recorded candidate ${input.expectedHeadSha}.`,
        );
    }

    const parentSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "HEAD^"],
        "Failed to read the local revision parent.",
    );
    if (!sameSha(parentSha, input.expectedPriorHeadSha)) {
        fail(
            "invalid-input",
            `Local revision candidate ${headSha} is not exactly one commit over ${input.expectedPriorHeadSha}.`,
        );
    }
    const treeSha = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "HEAD^{tree}"],
        "Failed to read the local revision tree.",
    );
    if (
        input.expectedStagedTreeSha !== undefined &&
        !sameSha(treeSha, input.expectedStagedTreeSha)
    ) {
        fail(
            "invalid-input",
            `Local revision candidate ${headSha} has tree ${treeSha}, expected ${input.expectedStagedTreeSha}.`,
        );
    }
    const status = await checkoutStatus(runner, input.repositoryPath);
    const remote = await readRemoteHead(
        runner,
        input.repositoryPath,
        input.branch,
    );
    if (!remote.available) {
        return ambiguousDelivery(
            deliveryBase(input, headSha, parentSha),
            "",
            "remote-read-failed",
            undefined,
        );
    }
    const observed = remote.sha.toLowerCase();
    if (observed === headSha.toLowerCase()) {
        return await classifyObservedRemote(
            runner,
            input,
            false,
            observed,
            deliveryBase(input, headSha, parentSha),
            headSha,
            treeSha,
            { failed: true, failureKind: undefined },
        );
    }
    if (observed !== input.expectedPriorHeadSha.toLowerCase()) {
        return externalMovement(
            deliveryBase(input, headSha, parentSha),
            input,
            observed,
            undefined,
        );
    }
    if (status !== "") {
        return ambiguousDelivery(
            deliveryBase(input, headSha, parentSha),
            observed,
            "checkout-not-clean",
            undefined,
        );
    }

    await remoteSafety.verifyManagedRevisionPrePush({
        repository: input.repository,
        repositoryPath: input.repositoryPath,
        branch: input.branch,
        baseSha: input.baseSha,
        expectedPriorHeadSha: input.expectedPriorHeadSha,
        expectedLocalHeadSha: headSha,
        isFirstDelivery: false,
        pushMode: "non-force",
    });
    cancellationCheck(input.context?.isCancelled);
    const push = await pushNonForce(runner, input.repositoryPath, input.branch);
    const afterPush = await readRemoteHead(
        runner,
        input.repositoryPath,
        input.branch,
    );
    return await classifyDelivery(
        runner,
        {
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            baseSha: input.baseSha,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            expectedStagedTreeSha: treeSha,
            message: { subject: "reconciled revision" },
            context: input.context,
        },
        false,
        push,
        afterPush,
        headSha,
        parentSha,
        treeSha,
    );
};

export const makeGitRevisionDeliveryService = (
    runner: CommandRunnerService = CommandRunnerLive,
    revisionCommit: GitRevisionCommitService,
    remoteSafety: GitRemoteSafetyService,
): GitRevisionDeliveryService => ({
    deliverRevision: async (input) => {
        verifyRevisionDeliveryInput(input);
        cancellationCheck(input.context?.isCancelled);
        const isFirstDelivery = input.isFirstDelivery === true;

        // Safety check before staging/commit: external movement here fails as
        // a typed safety error and nothing is staged or committed.
        await remoteSafety.verifyManagedRevisionPush({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            baseSha: input.baseSha,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            isFirstDelivery,
            pushMode: "non-force",
        });
        cancellationCheck(input.context?.isCancelled);

        // Exact-tree revision commit; it consults cancellation before index
        // mutation and before the commit is created.
        const commit = await revisionCommit.commitRevision({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            expectedStagedTreeSha: input.expectedStagedTreeSha,
            message: input.message,
            context: input.context,
        });
        cancellationCheck(input.context?.isCancelled);

        // Re-check the local branch/parent and remote feature/PR head
        // immediately before pushing; movement here halts with the created
        // commit retained and no push attempted.
        await remoteSafety.verifyManagedRevisionPrePush({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            baseSha: input.baseSha,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            expectedLocalHeadSha: commit.headSha,
            isFirstDelivery,
            pushMode: "non-force",
        });
        cancellationCheck(input.context?.isCancelled);

        const push = await pushNonForce(
            runner,
            input.repositoryPath,
            input.branch,
        );

        // The sole authority for delivery is the post-push remote read.
        const remote = await readRemoteHead(
            runner,
            input.repositoryPath,
            input.branch,
        );

        return await classifyDelivery(
            runner,
            input,
            isFirstDelivery,
            push,
            remote,
            commit.headSha,
            commit.parentSha,
            commit.treeSha,
        );
    },
    reconcileRevision: async (input) =>
        await reconcileRevision(input, runner, remoteSafety),
});

export const GitRevisionDeliveryLive = makeGitRevisionDeliveryService;