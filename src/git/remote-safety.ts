import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "../github/repository.ts";
import { runGit } from "./run-git.ts";

export type GitRemoteSafetyFailureKind =
    | "origin-mismatch"
    | "diverged-base"
    | "invalid-push-mode";

export type GitDirectPushPolicy =
    | "require-owned-origin"
    | "require-expected-base"
    | "non-force-only";

export type GitPushMode = "non-force" | "force";

export class GitRemoteSafetyError extends RalphieError {
    override readonly _tag = "GitRemoteSafetyError";
    readonly kind: GitRemoteSafetyFailureKind;
    readonly policy: GitDirectPushPolicy;

    constructor(input: {
        readonly kind: GitRemoteSafetyFailureKind;
        readonly policy: GitDirectPushPolicy;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitRemoteSafetyError";
        this.kind = input.kind;
        this.policy = input.policy;
    }
}

export type GitManagedRevisionFailureKind =
    | "invalid-managed-checkout"
    | "stale-prior-head"
    | "remote-moved"
    | "invalid-push-mode";

export type GitManagedRevisionPolicy =
    | "require-valid-managed-checkout"
    | "require-expected-prior-head"
    | "require-expected-remote-head"
    | "non-force-only";

export class GitManagedRevisionSafetyError extends RalphieError {
    override readonly _tag = "GitManagedRevisionSafetyError";
    readonly kind: GitManagedRevisionFailureKind;
    readonly policy: GitManagedRevisionPolicy;

    constructor(input: {
        readonly kind: GitManagedRevisionFailureKind;
        readonly policy: GitManagedRevisionPolicy;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitManagedRevisionSafetyError";
        this.kind = input.kind;
        this.policy = input.policy;
    }
}

export type GitRemoteSafetyInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    /** The exact clean checkout base captured before issue work began. */
    readonly intendedBaseSha: string;
    /** When supplied, HEAD must be this commit and exactly one commit ahead. */
    readonly expectedCommitSha?: string;
    /** Allow a new PR feature branch to be absent before its first push. */
    readonly allowMissingRemoteBranch?: boolean;
    readonly pushMode?: GitPushMode;
};

export type GitRemoteSafetyReport = {
    readonly repository: string;
    readonly branch: string;
    readonly origin: string;
    readonly commitsBehindBase: number;
    readonly commitsAheadBase: number;
    readonly pushMode: "non-force";
};

export type GitManagedRevisionInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    /** The exact original PR/base commit the managed feature branch was created from. */
    readonly baseSha: string;
    /**
     * The exact feature-head commit expected before this revision is pushed.
     * The explicitly identified first feature delivery may pass the base as
     * the prior head; later revisions pass the last delivered feature head.
     */
    readonly expectedPriorHeadSha: string;
    /** Identifies the first feature delivery; only then may the remote branch be absent. */
    readonly isFirstDelivery: boolean;
    readonly pushMode?: GitPushMode;
};

export type GitManagedRevisionPrePushInput = GitManagedRevisionInput & {
    /**
     * The exact new feature-head commit created locally for delivery. The
     * re-check requires local HEAD to be exactly this commit and its parent
     * to be the expected prior feature head before the non-force push.
     */
    readonly expectedLocalHeadSha: string;
};

export type GitManagedRevisionReport = {
    readonly repository: string;
    readonly branch: string;
    readonly origin: string;
    readonly baseSha: string;
    readonly expectedPriorHeadSha: string;
    readonly commitsBehindBase: number;
    readonly commitsAheadBase: number;
    readonly pushMode: "non-force";
};

export type GitRemoteSafetyService = {
    /** Verify all invariants required immediately before a direct branch push. */
    readonly verifyDirectPush: (
        input: GitRemoteSafetyInput,
    ) => Promise<GitRemoteSafetyReport>;
    /**
     * Verify the revision-specific invariants before pushing a revision to an
     * existing managed feature branch. The first revision may push a missing
     * remote branch and use the original base as its prior head; later
     * revisions must match the last delivered feature head locally and on the
     * remote.
     */
    readonly verifyManagedRevisionPush: (
        input: GitManagedRevisionInput,
    ) => Promise<GitManagedRevisionReport>;
    /**
     * Re-check the revision invariants immediately before pushing a created
     * revision: the local branch and HEAD must still be the managed feature
     * branch at exactly the created revision commit whose parent is the
     * expected prior feature head, and the remote feature/PR head must still
     * sit at the expected prior head (absent only for the explicit first
     * delivery). A moved remote, a drifted local head, a changed revision
     * parent, or a force push halts the check; the created commit is retained
     * for reconciliation and is never force-pushed or reset over.
     */
    readonly verifyManagedRevisionPrePush: (
        input: GitManagedRevisionPrePushInput,
    ) => Promise<GitManagedRevisionReport>;
};

const fail = (
    kind: GitRemoteSafetyFailureKind,
    policy: GitDirectPushPolicy,
    message: string,
    cause?: unknown,
): never => {
    throw new GitRemoteSafetyError({ kind, policy, message, cause });
};

const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const failManaged = (
    kind: GitManagedRevisionFailureKind,
    policy: GitManagedRevisionPolicy,
    message: string,
    cause?: unknown,
): never => {
    throw new GitManagedRevisionSafetyError({ kind, policy, message, cause });
};

const parseCounts = (output: string): readonly [number, number] | undefined => {
    const values = output.trim().split(/\s+/).map(Number);
    if (
        values.length !== 2 ||
        values.some((value) => !Number.isInteger(value) || value < 0)
    ) {
        return undefined;
    }
    return [values[0]!, values[1]!];
};

const validateDirectPushInput = (input: GitRemoteSafetyInput): string => {
    if ((input.pushMode ?? "non-force") !== "non-force") {
        fail(
            "invalid-push-mode",
            "non-force-only",
            "Direct pushes must use Git's non-force mode; force pushes are refused.",
        );
    }

    let slug: string;
    try {
        slug = parseRepositorySlug(input.repository).slug;
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: `Invalid GitHub repository: ${input.repository}.`,
            cause,
        });
    }
    if (input.intendedBaseSha.trim().length === 0) {
        fail(
            "diverged-base",
            "require-expected-base",
            "An intended base commit is required before a direct push.",
        );
    }
    return slug;
};

const readAndVerifyOrigin = async (
    runner: CommandRunnerService,
    input: GitRemoteSafetyInput,
    slug: string,
): Promise<string> => {
    const origin = await runGit(
        runner,
        input.repositoryPath,
        ["remote", "get-url", "origin"],
        "Failed to read the repository origin.",
    );
    let originSlug: string;
    try {
        originSlug = parseRepositorySlug(origin).slug;
    } catch (cause) {
        throw new GitRemoteSafetyError({
            kind: "origin-mismatch",
            policy: "require-owned-origin",
            message: `Repository origin ${origin} is not a GitHub repository owned by ${slug}.`,
            cause,
        });
    }
    if (originSlug.toLowerCase() !== slug.toLowerCase()) {
        fail(
            "origin-mismatch",
            "require-owned-origin",
            `Repository origin ${originSlug} does not match ${slug}.`,
        );
    }
    return origin;
};

const verifyBranch = (
    input: GitRemoteSafetyInput,
    localBranch: string,
): void => {
    if (localBranch !== input.branch) {
        fail(
            "origin-mismatch",
            "require-owned-origin",
            `Checkout is on ${localBranch}, expected ${input.branch}.`,
        );
    }
};

const verifyHead = (input: GitRemoteSafetyInput, head: string): void => {
    if (
        input.expectedCommitSha !== undefined &&
        head.toLowerCase() !== input.expectedCommitSha.toLowerCase()
    ) {
        fail(
            "diverged-base",
            "require-expected-base",
            `Local HEAD ${head} does not match expected commit ${input.expectedCommitSha}.`,
        );
    }
};

const verifyRemoteBase = (
    input: GitRemoteSafetyInput,
    remote: string,
): void => {
    const remoteSha = remote.split(/\s+/)[0] ?? "";
    const normalizedRemoteSha = remoteSha.toLowerCase();
    const remoteIsIntendedBase =
        normalizedRemoteSha === input.intendedBaseSha.toLowerCase();
    const remoteIsExpectedCommit =
        input.expectedCommitSha !== undefined &&
        normalizedRemoteSha === input.expectedCommitSha.toLowerCase();
    if (
        normalizedRemoteSha.length === 0 &&
        input.allowMissingRemoteBranch === true
    ) {
        return;
    }
    if (!remoteIsIntendedBase && !remoteIsExpectedCommit) {
        fail(
            "diverged-base",
            "require-expected-base",
            `Remote origin/${input.branch} moved from intended base ${input.intendedBaseSha} to ${remoteSha || "no commit"}.`,
        );
    }
};

const verifyAheadBehindCounts = (
    input: GitRemoteSafetyInput,
    countsOutput: string,
): readonly [number, number] => {
    const counts = parseCounts(countsOutput);
    if (counts === undefined) {
        fail(
            "diverged-base",
            "require-expected-base",
            `Git returned an invalid ahead/behind count: ${countsOutput}.`,
        );
        throw new Error("unreachable");
    }
    const [behind, ahead] = counts;
    const expectedAhead = input.expectedCommitSha === undefined ? 0 : 1;
    if (behind !== 0 || ahead !== expectedAhead) {
        fail(
            "diverged-base",
            "require-expected-base",
            `Checkout diverged from intended base: ${behind} behind and ${ahead} ahead; expected 0 behind and ${expectedAhead} ahead.`,
        );
    }
    return counts;
};

const readAndVerifyManagedOrigin = async (
    runner: CommandRunnerService,
    input: GitManagedRevisionInput,
    slug: string,
): Promise<string> => {
    const origin = await runGit(
        runner,
        input.repositoryPath,
        ["remote", "get-url", "origin"],
        "Failed to read the repository origin.",
    );
    let originSlug: string;
    try {
        originSlug = parseRepositorySlug(origin).slug;
    } catch (cause) {
        throw new GitManagedRevisionSafetyError({
            kind: "invalid-managed-checkout",
            policy: "require-valid-managed-checkout",
            message: `Repository origin ${origin} is not a GitHub repository owned by ${slug}.`,
            cause,
        });
    }
    if (originSlug.toLowerCase() !== slug.toLowerCase()) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            `Repository origin ${originSlug} does not match ${slug}.`,
        );
    }
    return origin;
};

const verifyManagedBranch = (
    input: GitManagedRevisionInput,
    localBranch: string,
): void => {
    if (localBranch !== input.branch) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            `Managed checkout is on ${localBranch}, expected ${input.branch}.`,
        );
    }
};

const verifyManagedLocalHead = (
    input: GitManagedRevisionInput,
    head: string,
): void => {
    if (head.toLowerCase() !== input.expectedPriorHeadSha.toLowerCase()) {
        failManaged(
            "stale-prior-head",
            "require-expected-prior-head",
            `Local HEAD ${head} is stale: expected prior feature head ${input.expectedPriorHeadSha}; refusing to revise over a drifted checkout.`,
        );
    }
};

const verifyManagedRemoteHead = (
    input: GitManagedRevisionInput,
    remote: string,
): void => {
    const remoteSha = remote.split(/\s+/)[0] ?? "";
    if (remoteSha.length === 0) {
        if (input.isFirstDelivery) return;
        failManaged(
            "remote-moved",
            "require-expected-remote-head",
            `origin/${input.branch} has no remote branch; only the explicitly identified first feature delivery may push to a missing branch.`,
        );
    }
    if (remoteSha.toLowerCase() !== input.expectedPriorHeadSha.toLowerCase()) {
        failManaged(
            "remote-moved",
            "require-expected-remote-head",
            `Remote origin/${input.branch} moved from expected prior head ${input.expectedPriorHeadSha} to ${remoteSha}.`,
        );
    }
};

const verifyManagedBaseAncestry = async (
    runner: CommandRunnerService,
    input: GitManagedRevisionInput,
): Promise<readonly [number, number]> => {
    const countsOutput = await runGit(
        runner,
        input.repositoryPath,
        [
            "rev-list",
            "--left-right",
            "--count",
            `${input.baseSha}...${input.expectedPriorHeadSha}`,
        ],
        "Failed to compare the feature head with its original base.",
    );
    const counts = parseCounts(countsOutput);
    if (counts === undefined) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            `Git returned an invalid ahead/behind count: ${countsOutput}.`,
        );
        throw new Error("unreachable");
    }
    const [behind, ahead] = counts;
    if (behind !== 0) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            `Feature head ${input.expectedPriorHeadSha} is ${behind} commits behind original base ${input.baseSha}; refusing an unanchored revision.`,
        );
    }
    return counts;
};

const verifyManagedRevisionPrePushInput = (
    input: GitManagedRevisionPrePushInput,
): string => {
    const slug = verifyManagedRevisionPushInput(input);
    if (!validGitSha.test(input.expectedLocalHeadSha)) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            `Refusing to push a revision with an invalid created head: ${input.expectedLocalHeadSha}.`,
        );
    }
    return slug;
};

const verifyManagedLocalCreatedHead = (
    input: GitManagedRevisionPrePushInput,
    head: string,
): void => {
    if (head.toLowerCase() !== input.expectedLocalHeadSha.toLowerCase()) {
        failManaged(
            "stale-prior-head",
            "require-expected-prior-head",
            `Local HEAD ${head} is not the created revision ${input.expectedLocalHeadSha}; refusing to push a drifted checkout.`,
        );
    }
};

const verifyManagedRevisionParent = async (
    runner: CommandRunnerService,
    input: GitManagedRevisionPrePushInput,
): Promise<void> => {
    const parent = await runGit(
        runner,
        input.repositoryPath,
        ["rev-parse", "HEAD^"],
        "Failed to read the created revision parent.",
    );
    if (parent.toLowerCase() !== input.expectedPriorHeadSha.toLowerCase()) {
        failManaged(
            "stale-prior-head",
            "require-expected-prior-head",
            `Created revision parent ${parent} does not match expected prior head ${input.expectedPriorHeadSha}; refusing to push.`,
        );
    }
};

const verifyManagedRevisionPushInput = (
    input: GitManagedRevisionInput,
): string => {
    if ((input.pushMode ?? "non-force") !== "non-force") {
        failManaged(
            "invalid-push-mode",
            "non-force-only",
            "Managed feature-branch revisions must use Git's non-force mode; force pushes are refused.",
        );
    }

    let slug: string;
    try {
        slug = parseRepositorySlug(input.repository).slug;
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: `Invalid GitHub repository: ${input.repository}.`,
            cause,
        });
    }
    if (input.baseSha.trim().length === 0) {
        failManaged(
            "invalid-managed-checkout",
            "require-valid-managed-checkout",
            "The original PR/base commit is required for a managed feature-branch revision.",
        );
    }
    if (input.expectedPriorHeadSha.trim().length === 0) {
        failManaged(
            "stale-prior-head",
            "require-expected-prior-head",
            "An expected prior feature head is required for a managed feature-branch revision.",
        );
    }
    return slug;
};

export const makeGitRemoteSafetyService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitRemoteSafetyService => ({
    verifyDirectPush: async (input) => {
        const slug = validateDirectPushInput(input);
        const origin = await readAndVerifyOrigin(runner, input, slug);

        const localBranch = await runGit(
            runner,
            input.repositoryPath,
            ["symbolic-ref", "--short", "HEAD"],
            "Failed to read the checked-out branch.",
        );
        verifyBranch(input, localBranch);

        const head = await runGit(
            runner,
            input.repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the local HEAD.",
        );
        verifyHead(input, head);

        const remote = await runGit(
            runner,
            input.repositoryPath,
            ["ls-remote", "origin", `refs/heads/${input.branch}`],
            `Failed to read origin/${input.branch}.`,
        );
        verifyRemoteBase(input, remote);

        const countsOutput = await runGit(
            runner,
            input.repositoryPath,
            [
                "rev-list",
                "--left-right",
                "--count",
                `${input.intendedBaseSha}...HEAD`,
            ],
            "Failed to compare the checkout with its intended base.",
        );
        const [behind, ahead] = verifyAheadBehindCounts(input, countsOutput);

        return {
            repository: slug,
            branch: input.branch,
            origin,
            commitsBehindBase: behind,
            commitsAheadBase: ahead,
            pushMode: "non-force",
        };
    },

    verifyManagedRevisionPush: async (input) => {
        const slug = verifyManagedRevisionPushInput(input);
        const origin = await readAndVerifyManagedOrigin(runner, input, slug);

        const localBranch = await runGit(
            runner,
            input.repositoryPath,
            ["symbolic-ref", "--short", "HEAD"],
            "Failed to read the checked-out branch.",
        );
        verifyManagedBranch(input, localBranch);

        const head = await runGit(
            runner,
            input.repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the local HEAD.",
        );
        verifyManagedLocalHead(input, head);

        const remote = await runGit(
            runner,
            input.repositoryPath,
            ["ls-remote", "origin", `refs/heads/${input.branch}`],
            `Failed to read origin/${input.branch}.`,
        );
        verifyManagedRemoteHead(input, remote);

        const [behind, ahead] = await verifyManagedBaseAncestry(runner, input);

        return {
            repository: slug,
            branch: input.branch,
            origin,
            baseSha: input.baseSha,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            commitsBehindBase: behind,
            commitsAheadBase: ahead,
            pushMode: "non-force",
        };
    },

    verifyManagedRevisionPrePush: async (input) => {
        const slug = verifyManagedRevisionPrePushInput(input);
        const origin = await readAndVerifyManagedOrigin(runner, input, slug);

        const localBranch = await runGit(
            runner,
            input.repositoryPath,
            ["symbolic-ref", "--short", "HEAD"],
            "Failed to read the checked-out branch.",
        );
        verifyManagedBranch(input, localBranch);

        const head = await runGit(
            runner,
            input.repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the local HEAD.",
        );
        verifyManagedLocalCreatedHead(input, head);
        await verifyManagedRevisionParent(runner, input);

        const remote = await runGit(
            runner,
            input.repositoryPath,
            ["ls-remote", "origin", `refs/heads/${input.branch}`],
            `Failed to read origin/${input.branch}.`,
        );
        verifyManagedRemoteHead(input, remote);

        const [behind, ahead] = await verifyManagedBaseAncestry(runner, input);

        return {
            repository: slug,
            branch: input.branch,
            origin,
            baseSha: input.baseSha,
            expectedPriorHeadSha: input.expectedPriorHeadSha,
            commitsBehindBase: behind,
            commitsAheadBase: ahead,
            pushMode: "non-force",
        };
    },
});

export const GitRemoteSafetyLive = makeGitRemoteSafetyService;