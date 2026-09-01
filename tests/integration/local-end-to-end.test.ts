import { describe, expect, test } from "bun:test";
import type { CodexClient } from "../../src/codex/client.ts";
import type { Octokit } from "octokit";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CommandRunnerLive } from "../../src/process/command-runner.ts";
import { makeGitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";
import { makeGitIssueOperationsService } from "../../src/git/issue-operations.ts";
import { makeGitIssuePreparationService } from "../../src/git/issue-preparation.ts";
import {
    type GitPushMode,
    type GitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";
import { makeGitRepositoryInvariantService } from "../../src/git/repository-invariant.ts";
import {
    issueArtifactPath,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import { makeComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    NeedsAttentionReason,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";
import type { DecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import { makeImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import { makeIssueRecoveryService } from "../../src/issues/recovery.ts";
import { makeNeedsAttentionRouterService } from "../../src/issues/needs-attention.ts";
import { makeCodexSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
): string => {
    const result = Bun.spawnSync([command, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0)
        throw new Error(
            `${command} ${args.join(" ")} failed: ${stderr || stdout}`,
        );
    return stdout.trim();
};
const git = (repositoryPath: string, args: ReadonlyArray<string>): string =>
    run("git", args, repositoryPath);

const makeCodex = (repositoryPath: string) => {
    let session = 0;
    let implementationWritten = false;
    const promptKinds: string[] = [];
    const client = {
        session: {
            create: async () => ({
                data: { id: `local-session-${++session}` },
            }),
            prompt: async (parameters: {
                readonly format?: unknown;
                readonly parts?: ReadonlyArray<{ readonly text: string }>;
            }) => {
                const structured = parameters.format !== undefined;
                promptKinds.push(structured ? "structured" : "text");
                if (
                    parameters.parts?.[0]?.text.includes(
                        "Address the GitHub issue",
                    ) &&
                    !implementationWritten
                ) {
                    implementationWritten = true;
                    await writeFile(
                        join(repositoryPath, "implemented.txt"),
                        "implemented\n",
                    );
                    return {
                        data: {
                            info: {
                                structured: {
                                    status: "changed",
                                    summary: "Created implemented.txt.",
                                    validation: ["bun run check"],
                                },
                            },
                            parts: [],
                        },
                    };
                }
                if (structured && promptKinds.length === 1) {
                    return {
                        data: {
                            info: {
                                structured: {
                                    complexity: ComplexityLevel.Level2,
                                    rationale:
                                        "A small isolated implementation change.",
                                },
                            },
                            parts: [],
                        },
                    };
                }
                if (
                    parameters.parts?.[0]?.text.includes(
                        "Review the staged implementation",
                    )
                ) {
                    return {
                        data: {
                            info: {
                                structured: {
                                    verdict: ReviewVerdict.Approved,
                                    summary: "The implementation is correct.",
                                    findings: [],
                                },
                            },
                            parts: [],
                        },
                    };
                }
                return {
                    data: {
                        info: {
                            structured: { subject: "implement local issue" },
                        },
                        parts: [],
                    },
                };
            },
        },
    };
    return { client: client as unknown as CodexClient, promptKinds };
};

const makeContext = (
    repositoryPath: string,
    codex: CodexClient,
    workspace: string,
    runId: string,
    invariant: ReturnType<typeof makeGitRepositoryInvariantService>,
): IssueExecutionContext => ({
    issue: {
        number: 17,
        title: "Implement local change",
        url: "https://github.com/owner/repository/issues/17",
        body: "Create the implementation file.",
        labels: ["bug"],
        state: "open",
        updatedAt: "2026-08-28T00:00:00.000Z",
        comments: [],
        commentCount: 0,
        commentVersion: "2026-08-28T00:00:00.000Z",
    },
    repository: "owner/repository",
    repositoryPath,
    targetBranch: "main",
    workspace,
    runId,
    octokit: {} as Octokit,
    codex,
    codexSelection: { agent: "build" },
    codexDiagnostics: makeCodexSessionDiagnostics(() => "now"),
    repositoryInvariant: invariant,
});

describe("local implementation end-to-end", () => {
    test("implements, reviews, commits, pushes, and leaves a clean checkout", async () => {
        const root = await mkdtemp(join(tmpdir(), "ralphie-local-e2e-"));
        const repositoryPath = join(root, "repository");
        const remotePath = join(root, "remote.git");
        const workspace = join(root, "workspace");
        await mkdir(repositoryPath, { recursive: true });
        try {
            run("git", ["init", "--bare", remotePath]);
            run("git", ["init", "-b", "main"], repositoryPath);
            git(repositoryPath, ["config", "user.name", "Ralphie Test"]);
            git(repositoryPath, [
                "config",
                "user.email",
                "ralphie@example.test",
            ]);
            await writeFile(join(repositoryPath, "README.md"), "initial\n");
            git(repositoryPath, ["add", "--all"]);
            git(repositoryPath, ["commit", "-m", "initial commit"]);
            git(repositoryPath, ["remote", "add", "origin", remotePath]);
            git(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
            const initialSha = git(repositoryPath, ["rev-parse", "HEAD"]);
            const codexSetup = makeCodex(repositoryPath);
            const progressEvents: ProgressUpdate[] = [];
            const safetyInputs: Array<{
                readonly intendedBaseSha: string;
                readonly expectedCommitSha?: string;
            }> = [];
            const safety: GitRemoteSafetyService = {
                verifyDirectPush: async (input) => {
                    safetyInputs.push({
                        intendedBaseSha: input.intendedBaseSha,
                        expectedCommitSha: input.expectedCommitSha,
                    });
                    return {
                        repository: input.repository,
                        branch: input.branch,
                        origin: remotePath,
                        commitsBehindBase: 0,
                        commitsAheadBase:
                            input.expectedCommitSha === undefined ? 0 : 1,
                        pushMode: "non-force",
                    };
                },
            };
            let decompositionCalls = 0;
            const decomposition: DecompositionExecutorService = {
                execute: async () => {
                    decompositionCalls += 1;
                    throw new Error(
                        "decomposition must not run for complexity 2",
                    );
                },
            };
            const runner = CommandRunnerLive;
            const checkpoint = makeGitIssueCheckpointService(runner);
            const artifacts = makeIssueArtifactStoreService();
            const preparation = makeGitIssuePreparationService(
                checkpoint,
                artifacts,
            );
            const operations = makeGitIssueOperationsService(runner);
            const invariant = makeGitRepositoryInvariantService(runner);
            const progress = makeProgressRecorder(progressEvents);
            const recovery = makeIssueRecoveryService(checkpoint, progress);
            const implementation = makeImplementationExecutorService(
                preparation,
                operations,
                safety,
                recovery,
                progress,
            );
            const complexity = makeComplexityAssessmentService(progress);
            const executor = makeIssueExecutorService(
                artifacts,
                complexity,
                implementation,
                decomposition,
                {
                    assess: async () => ({
                        sessionID: "grounding-session",
                        decision: {
                            disposition: GroundingDisposition.Actionable,
                        },
                    }),
                },
                {
                    verify: async () => {
                        throw new Error("resolution verification must not run");
                    },
                },
            );
            const outcome = await executor.execute(
                makeContext(
                    repositoryPath,
                    codexSetup.client,
                    workspace,
                    "local-implementation-e2e",
                    invariant,
                ),
            );

            const remoteSha = run("git", [
                "--git-dir",
                remotePath,
                "rev-parse",
                "refs/heads/main",
            ]);
            expect(outcome).toMatchObject({
                kind: IssueExecutionOutcomeKind.Completed,
                reviewCount: 1,
            });
            if (
                outcome.kind !== IssueExecutionOutcomeKind.Completed ||
                outcome.completion !== "pushed-commit"
            )
                throw new Error("Expected pushed completion");
            expect(outcome.commitSha).not.toBe(initialSha);
            expect(git(repositoryPath, ["rev-parse", "HEAD"])).toBe(
                outcome.commitSha,
            );
            expect(remoteSha).toBe(outcome.commitSha);
            expect(git(repositoryPath, ["log", "-1", "--format=%s"])).toBe(
                "implement local issue",
            );
            expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
            expect(
                await Bun.file(join(repositoryPath, "implemented.txt")).text(),
            ).toBe("implemented\n");
            expect(codexSetup.promptKinds).toEqual([
                "structured",
                "structured",
                "structured",
                "structured",
            ]);
            expect(safetyInputs).toHaveLength(2);
            expect(safetyInputs[0]).toEqual({ intendedBaseSha: initialSha });
            expect(safetyInputs[1]?.intendedBaseSha).toBe(initialSha);
            expect(safetyInputs[1]?.expectedCommitSha).toBe(outcome.commitSha);
            expect(decompositionCalls).toBe(0);
            expect(progressEvents.length).toBeGreaterThan(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("persists and reuses a verified implementation signal before any Git mutation", async () => {
        const root = await mkdtemp(join(tmpdir(), "ralphie-local-attention-"));
        const repositoryPath = join(root, "repository");
        const workspace = join(root, "workspace");
        await mkdir(repositoryPath, { recursive: true });
        try {
            run("git", ["init", "-b", "main"], repositoryPath);
            git(repositoryPath, ["config", "user.name", "Ralphie Test"]);
            git(repositoryPath, [
                "config",
                "user.email",
                "ralphie@example.test",
            ]);
            await writeFile(join(repositoryPath, "README.md"), "initial\n");
            git(repositoryPath, ["add", "--all"]);
            git(repositoryPath, ["commit", "-m", "initial commit"]);
            const initialSha = git(repositoryPath, ["rev-parse", "HEAD"]);
            let prompt = 0;
            const sessions: string[] = [];
            const codex = {
                session: {
                    create: async () => {
                        const id = `attention-session-${sessions.length + 1}`;
                        sessions.push(id);
                        return { data: { id } };
                    },
                    prompt: async (parameters: {
                        format?: unknown;
                        parts?: ReadonlyArray<{ readonly text: string }>;
                    }) => {
                        prompt += 1;
                        if (prompt === 1) {
                            return {
                                data: {
                                    info: {
                                        structured: {
                                            complexity: ComplexityLevel.Level2,
                                            rationale: "Small implementation.",
                                        },
                                    },
                                    parts: [],
                                },
                            };
                        }
                        if (
                            parameters.parts?.[0]?.text.includes(
                                "Address the GitHub issue",
                            )
                        ) {
                            await writeFile(
                                join(repositoryPath, "partial.txt"),
                                "partial\n",
                            );
                            return {
                                data: {
                                    info: {
                                        structured: {
                                            status: "changed",
                                            summary:
                                                "Partial work exposed a dependency.",
                                            validation: [],
                                        },
                                    },
                                    parts: [],
                                    needsAttention: {
                                        reason: "external_dependency",
                                        message:
                                            "A generated fixture is missing.",
                                    },
                                },
                            };
                        }
                        return {
                            data: {
                                info: {
                                    structured: {
                                        disposition:
                                            GroundingDisposition.NeedsAttention,
                                        reason: NeedsAttentionReason.ExternalDependency,
                                        summary:
                                            "The generated fixture is required.",
                                        evidence: [
                                            "README.md does not provide the generated fixture.",
                                        ],
                                        questions: [
                                            "Can the generated fixture be supplied?",
                                        ],
                                    },
                                },
                                parts: [],
                            },
                        };
                    },
                },
            } as unknown as CodexClient;
            const runner = CommandRunnerLive;
            const gitCheckpoint = makeGitIssueCheckpointService(runner);
            const artifacts = makeIssueArtifactStoreService();
            const preparation = makeGitIssuePreparationService(
                gitCheckpoint,
                artifacts,
            );
            const operations = makeGitIssueOperationsService(runner);
            const invariant = makeGitRepositoryInvariantService(runner);
            const progress = makeProgressRecorder([]);
            const recovery = makeIssueRecoveryService(
                gitCheckpoint,
                progress,
                invariant,
            );
            const router = makeNeedsAttentionRouterService(recovery);
            const safety: GitRemoteSafetyService = {
                verifyDirectPush: async (input) => ({
                    repository: input.repository,
                    branch: input.branch,
                    origin: "local",
                    commitsBehindBase: 0,
                    commitsAheadBase: 0,
                    pushMode: "non-force",
                }),
            };
            const implementation = makeImplementationExecutorService(
                preparation,
                operations,
                safety,
                recovery,
                progress,
                undefined,
                undefined,
                router,
            );
            const executor = makeIssueExecutorService(
                artifacts,
                makeComplexityAssessmentService(progress),
                implementation,
                {
                    execute: async () => {
                        throw new Error("decomposition must not run");
                    },
                },
                {
                    assess: async () => ({
                        sessionID: "grounding-session",
                        decision: {
                            disposition: GroundingDisposition.Actionable,
                        },
                    }),
                },
                {
                    verify: async () => {
                        throw new Error("resolution verification must not run");
                    },
                },
                progress,
                router,
            );

            const outcome = await executor.execute(
                makeContext(
                    repositoryPath,
                    codex,
                    workspace,
                    "local-needs-attention-e2e",
                    invariant,
                ),
            );

            expect(outcome).toMatchObject({
                kind: IssueExecutionOutcomeKind.NeedsAttention,
                summary: "The generated fixture is required.",
            });
            if (
                outcome.kind !== IssueExecutionOutcomeKind.NeedsAttention ||
                outcome.diagnosticsPath === undefined
            ) {
                throw new Error("Expected needs-attention diagnostics");
            }
            expect(
                await Bun.file(
                    join(outcome.diagnosticsPath, "metadata.json"),
                ).exists(),
            ).toBe(true);
            expect(
                await Bun.file(
                    issueArtifactPath(
                        {
                            workspace,
                            runId: "local-needs-attention-e2e",
                            repository: "owner/repository",
                        },
                        17,
                    ),
                ).exists(),
            ).toBe(true);
            expect(sessions).toHaveLength(3);
            const promptCount = prompt;

            const resumedOutcome = await executor.execute(
                makeContext(
                    repositoryPath,
                    codex,
                    workspace,
                    "local-needs-attention-e2e",
                    invariant,
                ),
            );

            expect(resumedOutcome).toMatchObject({
                kind: IssueExecutionOutcomeKind.NeedsAttention,
                summary: "The generated fixture is required.",
            });
            expect(prompt).toBe(promptCount);
            expect(sessions).toHaveLength(3);
            expect(git(repositoryPath, ["rev-parse", "HEAD"])).toBe(initialSha);
            expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
            expect(
                await Bun.file(join(repositoryPath, "partial.txt")).exists(),
            ).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});