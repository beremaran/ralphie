import { RalphieError } from "../shared/error.ts";
import type { CommitMessageDecision } from "../issues/domain/decisions.ts";

/** A clean issue checkout captured before agent work begins. */
export type IssueCheckpoint = {
    readonly branch: string;
    readonly sha: string;
};

export type GitIssueCheckpointService = {
    readonly capture: (
        repositoryPath: string,
        branch: string,
    ) => Promise<IssueCheckpoint>;
    /** Capture tracked and untracked changes without changing the checkout. */
    readonly createPatch: (repositoryPath: string) => Promise<string>;
    readonly restore: (
        repositoryPath: string,
        checkpoint: IssueCheckpoint,
    ) => Promise<void>;
};

export type GitPushFailureKind = "non-fast-forward" | "other";

/** Push failures halt so their created commit can be reconciled on resume. */
export const GitPushFailurePolicy = "halt" as const;
export type GitPushFailurePolicy = typeof GitPushFailurePolicy;

export class GitPushError extends RalphieError {
    readonly kind: GitPushFailureKind;
    readonly policy: GitPushFailurePolicy;
    readonly branch: string;

    constructor(input: {
        readonly kind: GitPushFailureKind;
        readonly policy?: GitPushFailurePolicy;
        readonly branch: string;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitPushError";
        this.kind = input.kind;
        this.policy = input.policy ?? GitPushFailurePolicy;
        this.branch = input.branch;
    }
}

export type GitIssueOperationError = RalphieError | GitPushError;

export type GitCommitResult = {
    readonly sha: string;
    readonly treeSha: string;
};

export type GitIssueOperationsService = {
    /** Stage tracked, untracked, and deleted files in the issue checkout. */
    readonly stageAll: (repositoryPath: string) => Promise<void>;
    /** Read the complete staged patch, retaining Git's binary patch bytes/text. */
    readonly readStagedBinaryDiff: (repositoryPath: string) => Promise<string>;
    /** Check whether the index contains any staged changes. */
    readonly hasStagedChanges: (repositoryPath: string) => Promise<boolean>;
    /** Commit the validated generated message and verify the staged tree. */
    readonly commit: (
        repositoryPath: string,
        message: CommitMessageDecision,
    ) => Promise<GitCommitResult>;
    /** Push a commit to the configured branch without force and verify origin. */
    readonly push: (
        repositoryPath: string,
        branch: string,
        expectedCommitSha: string,
    ) => Promise<void>;
};

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

export type GitRemoteSafetyInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    /** The exact clean checkout base captured before issue work began. */
    readonly intendedBaseSha: string;
    /** When supplied, HEAD must be this commit and exactly one commit ahead. */
    readonly expectedCommitSha?: string;
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

export type GitRemoteSafetyService = {
    /** Verify all invariants required immediately before a direct branch push. */
    readonly verifyDirectPush: (
        input: GitRemoteSafetyInput,
    ) => Promise<GitRemoteSafetyReport>;
};

export type GitRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type GitRepositoryInvariantService = {
    readonly capture: (
        repositoryPath: string,
        signal?: AbortSignal,
    ) => Promise<GitRepositoryInvariant>;
    readonly verify: (
        repositoryPath: string,
        expected: GitRepositoryInvariant,
        signal?: AbortSignal,
    ) => Promise<void>;
};

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
        signal?: AbortSignal,
    ) => Promise<PreparedRepository>;
};