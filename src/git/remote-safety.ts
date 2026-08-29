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

export type GitRemoteSafetyService = {
    /** Verify all invariants required immediately before a direct branch push. */
    readonly verifyDirectPush: (
        input: GitRemoteSafetyInput,
    ) => Promise<GitRemoteSafetyReport>;
};

const fail = (
    kind: GitRemoteSafetyFailureKind,
    policy: GitDirectPushPolicy,
    message: string,
    cause?: unknown,
): never => {
    throw new GitRemoteSafetyError({ kind, policy, message, cause });
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
});

export const GitRemoteSafetyLive = makeGitRemoteSafetyService;