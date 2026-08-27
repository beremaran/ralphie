import { describe, expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";
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
import { makeIssueArtifactStoreService } from "../../src/issues/artifacts.ts";
import { makeComplexityAssessmentService } from "../../src/issues/complexity.ts";
import { ComplexityLevel, ReviewVerdict } from "../../src/issues/decisions.ts";
import type { DecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import { makeImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import { makeIssueRecoveryService } from "../../src/issues/recovery.ts";
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
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

const makePi = (repositoryPath: string) => {
    let session = 0;
    let implementationWritten = false;
    const promptKinds: string[] = [];
    const client = {
        session: {
            create: async () => ({
                data: { id: `local-session-${++session}` },
            }),
            prompt: async (parameters: { readonly format?: unknown }) => {
                const structured = parameters.format !== undefined;
                promptKinds.push(structured ? "structured" : "text");
                if (!structured && !implementationWritten) {
                    implementationWritten = true;
                    await writeFile(
                        join(repositoryPath, "implemented.txt"),
                        "implemented\n",
                    );
                    return { data: { info: {}, parts: [] } };
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
                    structured &&
                    promptKinds.filter((kind) => kind === "structured")
                        .length === 2
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
    return { client: client as unknown as PiClient, promptKinds };
};

const makeContext = (
    repositoryPath: string,
    pi: PiClient,
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
    },
    repository: "owner/repository",
    repositoryPath,
    targetBranch: "main",
    workspace,
    runId,
    octokit: {} as Octokit,
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(() => "now"),
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
            const piSetup = makePi(repositoryPath);
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
            );
            const outcome = await executor.execute(
                makeContext(
                    repositoryPath,
                    piSetup.client,
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
            expect(piSetup.promptKinds).toEqual([
                "structured",
                "text",
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
});