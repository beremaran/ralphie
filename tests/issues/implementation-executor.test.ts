import { describe, expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";
import type { Octokit } from "octokit";

import {
    IssueArtifactKind,
    type IssueArtifactStore,
    makeIssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import type { GitIssueOperationsService } from "../../src/git/issue-operations.ts";
import {
    GitPushError,
    type GitPushFailureKind,
    GitPushFailurePolicy,
} from "../../src/git/issue-operations.ts";
import type { GitIssuePreparationService } from "../../src/git/issue-preparation.ts";
import {
    type GitPushMode,
    type GitRemoteSafetyInput,
    type GitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import type { WorkflowExecutorResult } from "../../src/issues/workflow-executor-input.ts";
import { makeImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import type { IssueVerificationService } from "../../src/issues/verification.ts";
import {
    type ReviewExhaustionOutcome,
    type IssueRecoveryService,
} from "../../src/issues/recovery.ts";
import {
    IssueQueueResumeStrategy,
    type IssueWorkflowKind,
} from "../../src/issues/stage.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";
import { type IssueCheckpoint } from "../../src/git/issue-checkpoint.ts";
import {
    reviewDecisionSchema,
    IssueResolutionStatus,
} from "../../src/issues/decisions.ts";

const checkpoint: IssueCheckpoint = {
    branch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
};

const review = (
    verdict: "approved" | "changes_requested",
    description = "The implementation misses an edge case.",
) => ({
    verdict,
    summary:
        verdict === "approved" ? "The change is safe." : "Fix the blocker.",
    findings:
        verdict === "approved"
            ? []
            : [
                  {
                      severity: "blocking" as const,
                      description,
                  },
              ],
});

const issueContext = (
    pi: PiClient,
    verify: IssueExecutionContext["repositoryInvariant"]["verify"] = async () => {},
    head = checkpoint.sha,
): IssueExecutionContext => ({
    issue: {
        number: 42,
        title: "Fix token refresh",
        url: "https://github.com/owner/repository/issues/42",
        body: "Refresh expired tokens.",
        labels: ["bug"],
    },
    repository: "owner/repository",
    repositoryPath: "/workspace/repository",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "run-1",
    octokit: {} as Octokit,
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(() => "now"),
    repositoryInvariant: {
        capture: async () => ({ branch: checkpoint.branch, head }),
        verify,
    },
});

const piClient = (outputs: ReadonlyArray<unknown>, sessions?: string[]) => {
    let index = 0;
    let sessionIndex = 0;
    return {
        session: {
            create: async () => {
                const sessionID = `session-${++sessionIndex}`;
                sessions?.push(sessionID);
                return { data: { id: sessionID } };
            },
            prompt: async (parameters: { format?: unknown }) => {
                const output = outputs[index++];
                return {
                    data: {
                        info:
                            parameters.format === undefined
                                ? {}
                                : { structured: output },
                        parts: [],
                    },
                };
            },
        },
    } as unknown as PiClient;
};

type ServiceOptions = {
    readonly preparation?: Partial<GitIssuePreparationService>;
    readonly operations?: Partial<GitIssueOperationsService>;
    readonly recovery?: Partial<IssueRecoveryService>;
    readonly remoteSafety?: Partial<GitRemoteSafetyService>;
    readonly safetyInputs?: GitRemoteSafetyInput[];
    readonly verification?: IssueVerificationService;
};

const services = (options: ServiceOptions = {}) => {
    const preparation: GitIssuePreparationService = {
        prepare: async () => checkpoint,
        ...options.preparation,
    };
    const operations: GitIssueOperationsService = {
        stageAll: async () => {},
        readStagedBinaryDiff: async () => "diff --git a/file b/file\n",
        hasStagedChanges: async () => true,
        commit: async () => ({ sha: "commit-1", treeSha: "tree-1" }),
        push: async () => {},
        createOrCheckoutFeatureBranch: async () => ({
            branch: "feature",
            baseBranch: "main",
            baseSha: checkpoint.sha,
            headSha: checkpoint.sha,
            created: true,
        }),
        restoreBaseCheckout: async () => {},
        ...options.operations,
        readCommittedBinaryDiff:
            options.operations?.readCommittedBinaryDiff ??
            (async () => "diff --git a/file b/file\n"),
    };
    const recovery: IssueRecoveryService = {
        handleReviewExhaustion: async () => ({
            outcome: "escalated-to-decomposition",
            diagnosticsPath: "/workspace/review-exhaustion",
            nextWorkflow: "decomposition",
            resume: IssueQueueResumeStrategy,
        }),
        ...options.recovery,
    };
    const remoteSafety: GitRemoteSafetyService = {
        verifyDirectPush: async (input) => {
            options.safetyInputs?.push(input);
            return {
                repository: input.repository,
                branch: input.branch,
                origin: "https://github.com/owner/repository.git",
                commitsBehindBase: 0,
                commitsAheadBase: input.expectedCommitSha === undefined ? 0 : 1,
                pushMode: "non-force",
            };
        },
        ...options.remoteSafety,
    };
    const progress = makeProgressRecorder([]);
    return {
        executor: makeImplementationExecutorService(
            preparation,
            operations,
            remoteSafety,
            recovery,
            progress,
            options.verification,
        ),
        operations,
        recovery,
    };
};

const run = async (
    client: PiClient,
    artifacts: IssueArtifactStore,
    setup: ReturnType<typeof services>,
    verify?: IssueExecutionContext["repositoryInvariant"]["verify"],
    head?: string,
): Promise<WorkflowExecutorResult> =>
    setup.executor.execute({
        context: issueContext(client, verify, head),
        artifacts,
    });

describe("implementation executor", () => {
    test("implements, reviews, commits, and pushes after first-pass approval", async () => {
        const safetyInputs: GitRemoteSafetyInput[] = [];
        const setup = services({ safetyInputs });
        const artifacts = await makeIssueArtifactStore(42);
        const result = await run(
            piClient([
                undefined,
                review("approved"),
                { subject: "fix token refresh" },
            ]),
            artifacts,
            setup,
        );
        expect(result).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: "commit-1",
            reviewCount: 1,
        });
        expect(
            await artifacts.read(IssueArtifactKind.ReviewAttempts),
        ).toHaveLength(1);
        expect(
            safetyInputs.map(({ expectedCommitSha }) => expectedCommitSha),
        ).toEqual([undefined, "commit-1"]);
    });

    test("never reviews or commits when deterministic verification fails", async () => {
        let commitCalled = false;
        const setup = services({
            operations: {
                commit: async () => {
                    commitCalled = true;
                    return { sha: "commit-1", treeSha: "tree-1" };
                },
            },
            verification: {
                stagedTreeSha: async () => "a".repeat(40),
                verify: async () => {
                    throw new RalphieError({ message: "bun run check failed" });
                },
            },
        });
        const artifacts = await makeIssueArtifactStore(42);
        await expect(
            run(piClient([undefined]), artifacts, setup),
        ).rejects.toThrow("bun run check failed");
        expect(commitCalled).toBe(false);
    });

    test("refuses commit when the staged tree changes after approval", async () => {
        let verificationCount = 0;
        const verification: IssueVerificationService = {
            stagedTreeSha: async () => "a".repeat(40),
            verify: async () => ({
                stagedTreeSha:
                    ++verificationCount < 3 ? "a".repeat(40) : "b".repeat(40),
                commands: [
                    {
                        command: "bun run check",
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                    },
                ],
            }),
        };
        const artifacts = await makeIssueArtifactStore(42);
        await expect(
            run(
                piClient([undefined, review("approved")]),
                artifacts,
                services({ verification }),
            ),
        ).rejects.toThrow("staged tree changed after approval");
    });

    test("refuses unsafe direct pushes before starting an agent session", async () => {
        let prompted = false;
        const client = piClient([]);
        client.session.prompt = (async () => {
            prompted = true;
            return { data: { info: {}, parts: [] } };
        }) as unknown as typeof client.session.prompt;
        const setup = services({
            remoteSafety: {
                verifyDirectPush: async () => {
                    throw new RalphieError({ message: "protected branch" });
                },
            },
        });
        const artifacts = await makeIssueArtifactStore(42);
        await expect(run(client, artifacts, setup)).rejects.toThrow(
            "protected branch",
        );
        expect(prompted).toBe(false);
    });

    test("reconciles a commit created before interruption without rerunning the agent", async () => {
        let pushedSha: string | undefined;
        const setup = services({
            operations: {
                push: async (_path, _branch, sha) => {
                    pushedSha = sha;
                },
            },
        });
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(IssueArtifactKind.IssueCheckpoint, checkpoint);
        await artifacts.appendReview({
            attempt: 1,
            sessionID: "review-before-interruption",
            decision: reviewDecisionSchema.parse(review("approved")),
        });
        await artifacts.write(IssueArtifactKind.CreatedCommit, {
            sha: "commit-1",
            treeSha: "tree-1",
        });
        const result = await run(
            piClient([]),
            artifacts,
            setup,
            undefined,
            "commit-1",
        );
        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.Completed,
            commitSha: "commit-1",
        });
        expect(pushedSha).toBe("commit-1");
    });

    test("starts a fresh review-fix session and converges after a requested change", async () => {
        const sessions: string[] = [];
        const artifacts = await makeIssueArtifactStore(42);
        const result = await run(
            piClient(
                [
                    undefined,
                    review("changes_requested"),
                    undefined,
                    review("approved"),
                    { subject: "fix token refresh" },
                ],
                sessions,
            ),
            artifacts,
            services(),
        );
        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.Completed,
            reviewCount: 2,
        });
        expect(sessions).toHaveLength(5);
        expect(
            await artifacts.read(IssueArtifactKind.ReviewAttempts),
        ).toHaveLength(2);
    });

    test("completes without a commit when fresh verification proves the issue resolved", async () => {
        let commitCalled = false;
        const artifacts = await makeIssueArtifactStore(42);
        const client = piClient([
            undefined,
            {
                status: IssueResolutionStatus.Resolved,
                summary: "The checkout already closes every response body.",
                evidence: ["bodyclose reports zero findings"],
            },
        ]);
        const setup = services({
            operations: {
                hasStagedChanges: async () => false,
                commit: async () => {
                    commitCalled = true;
                    return { sha: "commit-1", treeSha: "tree-1" };
                },
            },
        });
        const result = await run(client, artifacts, setup);
        expect(result).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "already-resolved",
            resolutionSummary:
                "The checkout already closes every response body.",
            evidence: ["bodyclose reports zero findings"],
        });
        expect(commitCalled).toBe(false);
    });

    test("fails safely when a no-change implementation remains unresolved", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const result = await run(
            piClient([
                undefined,
                {
                    status: IssueResolutionStatus.Unresolved,
                    summary: "The reported behavior still reproduces.",
                    evidence: ["targeted test still fails"],
                },
            ]),
            artifacts,
            services({ operations: { hasStagedChanges: async () => false } }),
        );
        expect(result).toEqual({
            kind: IssueExecutionOutcomeKind.Failed,
            message:
                "Issue remains unresolved after a no-change implementation: The reported behavior still reproduces.",
        });
    });

    test("fails when the implementation agent fails", async () => {
        const client = {
            session: {
                create: async () => ({ data: { id: "implementation" } }),
                prompt: async () => ({
                    data: {
                        info: {
                            error: {
                                name: "MessageOutputLengthError",
                                data: { message: "too long" },
                            },
                        },
                        parts: [],
                    },
                }),
            },
        } as unknown as PiClient;
        await expect(
            run(client, await makeIssueArtifactStore(42), services()),
        ).rejects.toThrow("Pi assistant failed");
    });

    test("fails when a review response is invalid", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        await expect(
            run(piClient([{ verdict: "invalid" }]), artifacts, services()),
        ).rejects.toThrow("structured output");
        expect(artifacts.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
    });

    test("fails without pushing when deterministic commit fails", async () => {
        let pushed = false;
        const setup = services({
            operations: {
                commit: async () => {
                    throw new RalphieError({ message: "commit failed" });
                },
                push: async () => {
                    pushed = true;
                },
            },
        });
        await expect(
            run(
                piClient([undefined, review("approved"), { subject: "fix" }]),
                await makeIssueArtifactStore(42),
                setup,
            ),
        ).rejects.toThrow("commit failed");
        expect(pushed).toBe(false);
    });

    test("fails when push is rejected but retains the created commit", async () => {
        const setup = services({
            operations: {
                push: async () => {
                    throw new GitPushError({
                        kind: "non-fast-forward",
                        policy: GitPushFailurePolicy,
                        branch: "main",
                        message: "rejected",
                    });
                },
            },
        });
        const artifacts = await makeIssueArtifactStore(42);
        await expect(
            run(
                piClient([undefined, review("approved"), { subject: "fix" }]),
                artifacts,
                setup,
            ),
        ).rejects.toThrow("rejected");
        expect(
            await artifacts.read(IssueArtifactKind.CreatedCommit),
        ).toMatchObject({ sha: "commit-1" });
    });

    test("escalates after five rejected reviews without fixing or committing after the fifth", async () => {
        let fixCount = 0;
        let commitCalled = false;
        let recoveryInput: number | undefined;
        const setup = services({
            recovery: {
                handleReviewExhaustion: async (input) => {
                    recoveryInput = input.reviews.length;
                    return {
                        outcome: "escalated-to-decomposition",
                        diagnosticsPath: "/workspace/recovery",
                        nextWorkflow: "decomposition",
                        resume: IssueQueueResumeStrategy,
                    };
                },
            },
            operations: {
                commit: async () => {
                    commitCalled = true;
                    return { sha: "commit-1", treeSha: "tree-1" };
                },
            },
        });
        const client = piClient([
            undefined,
            review("changes_requested", "Fix blocker one."),
            undefined,
            review("changes_requested", "Fix blocker two."),
            undefined,
            review("changes_requested", "Fix blocker three."),
            undefined,
            review("changes_requested", "Fix blocker four."),
            undefined,
            review("changes_requested", "Fix blocker five."),
        ]);
        const originalPrompt = client.session.prompt;
        client.session.prompt = (async (parameters: {
            format?: unknown;
            parts?: ReadonlyArray<{ text: string }>;
        }) => {
            if (
                parameters.format === undefined &&
                parameters.parts?.[0]?.text.includes(
                    "Address the blocking findings",
                )
            )
                fixCount += 1;
            return originalPrompt(parameters as never);
        }) as unknown as typeof client.session.prompt;
        const result = await run(
            client,
            await makeIssueArtifactStore(42),
            setup,
        );
        expect(result.kind).toBe(IssueExecutionOutcomeKind.Escalated);
        expect(recoveryInput).toBe(5);
        expect(fixCount).toBe(4);
        expect(commitCalled).toBe(false);
    });
});