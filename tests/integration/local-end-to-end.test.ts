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
import {
    issueArtifactPath,
    makeIssueArtifactStoreService,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import { makeDryRunIssueExecutorService } from "../../src/issues/dry-run-executor.ts";
import { makeComplexityAssessmentService } from "../../src/issues/complexity.ts";
import { makeGroundingAssessmentService } from "../../src/issues/grounding.ts";
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
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";
import { IssueOrder, IssueSort } from "../../src/github/issues.ts";
import { NeedsAttentionPolicy, WorkflowMode } from "../../src/options.ts";
import { RunStateStatus, type RunState } from "../../src/run/state.ts";
import { makeLiveRuntime, type RalphieRuntime } from "../../src/runtime.ts";
import { workflow } from "../../src/workflow.ts";

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

const artifactMutationMethods = new Set<PropertyKey>([
    "write",
    "recordResolutionDecision",
    "beginNeedsAttentionHandoff",
    "recordNeedsAttentionDecision",
    "appendReview",
    "appendPullRequestReview",
    "recordCreatedIssue",
    "resetImplementationAttempt",
    "clearUnresolvedResolutionDecision",
    "invalidateStaleIssueDecisions",
    "invalidateStaleNeedsAttentionDecision",
    "invalidateNeedsAttentionDecision",
    "clearNeedsAttentionHandoff",
]);

const readOnlyArtifactSpy = (
    store: IssueArtifactStore,
    mutations: string[],
): IssueArtifactStore =>
    new Proxy(store, {
        get(target, property, receiver) {
            if (artifactMutationMethods.has(property)) {
                return async () => {
                    mutations.push(String(property));
                    throw new Error(
                        `dry run attempted artifact mutation: ${String(property)}`,
                    );
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

const forbiddenCall = (calls: string[], operation: string): never => {
    calls.push(operation);
    throw new Error(`Unexpected dry-run mutation: ${operation}`);
};

type LocalDryRunRoute = "actionable" | "already-resolved" | "needs-attention";

const dryRunGroundingDecision = (
    route: LocalDryRunRoute,
): Readonly<Record<string, unknown>> => {
    switch (route) {
        case "actionable":
            return { disposition: GroundingDisposition.Actionable };
        case "already-resolved":
            return { disposition: GroundingDisposition.AlreadyResolved };
        case "needs-attention":
            return {
                disposition: GroundingDisposition.NeedsAttention,
                reason: NeedsAttentionReason.ExternalDependency,
                summary: "The local prerequisite is still open.",
                evidence: ["README.md documents the unresolved prerequisite."],
                questions: ["When will the local prerequisite be complete?"],
            };
    }
};

const structuredPiResponse = (structured: unknown) => ({
    data: { info: { structured }, parts: [] },
});

const localPiResponse = (
    promptText: string,
    structured: boolean,
    promptCount: number,
    dryRunRoute: LocalDryRunRoute,
) => {
    if (
        structured &&
        promptText.includes("Determine whether this GitHub issue")
    ) {
        return structuredPiResponse(dryRunGroundingDecision(dryRunRoute));
    }
    if (structured && promptText.includes("Assign exactly one complexity")) {
        return structuredPiResponse({
            complexity:
                dryRunRoute === "actionable"
                    ? ComplexityLevel.Level2
                    : ComplexityLevel.Level4,
            rationale: "A small isolated implementation change.",
        });
    }
    if (structured && promptCount === 1) {
        return structuredPiResponse({
            complexity: ComplexityLevel.Level2,
            rationale: "A small isolated implementation change.",
        });
    }
    if (promptText.includes("Review the staged implementation")) {
        return structuredPiResponse({
            verdict: ReviewVerdict.Approved,
            summary: "The implementation is correct.",
            findings: [],
        });
    }
    return structuredPiResponse({ subject: "implement local issue" });
};

const makePi = (
    repositoryPath: string,
    dryRunRoute: LocalDryRunRoute = "actionable",
) => {
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
                const promptText = parameters.parts?.[0]?.text ?? "";
                promptKinds.push(structured ? "structured" : "text");
                if (
                    promptText.includes("Address the GitHub issue") &&
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
                return localPiResponse(
                    promptText,
                    structured,
                    promptKinds.length,
                    dryRunRoute,
                );
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
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(() => "now"),
    repositoryInvariant: invariant,
});

describe("local implementation end-to-end", () => {
    test.each([
        { name: "lgtm", workflowMode: WorkflowMode.Lgtm },
        { name: "pr", workflowMode: WorkflowMode.Pr },
    ])(
        "keeps every dry-run route isolated in $name mode",
        async ({ workflowMode }) => {
            const root = await mkdtemp(
                join(tmpdir(), "ralphie-local-dry-run-"),
            );
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
                const initialBranch = git(repositoryPath, [
                    "branch",
                    "--show-current",
                ]);
                const issue = {
                    number: 17,
                    title: "Implement local change",
                    url: "https://github.com/owner/repository/issues/17",
                    body: "Create the implementation file.",
                    labels: ["bug"],
                    state: "open" as const,
                    updatedAt: "2026-08-28T00:00:00.000Z",
                    comments: [],
                    commentCount: 0,
                    commentVersion: "2026-08-28T00:00:00.000Z",
                };

                for (const route of [
                    "actionable",
                    "already-resolved",
                    "needs-attention",
                ] as const) {
                    const runId = `local-dry-run-${workflowMode}-${route}`;
                    const events: ProgressUpdate[] = [];
                    const piSetup = makePi(repositoryPath, route);
                    const piCalls: string[] = [];
                    const progress = makeProgressRecorder(events);
                    const artifactLoads: string[] = [];
                    const artifactMutations: string[] = [];
                    const stores = makeIssueArtifactStoreService();
                    const artifactStore: IssueArtifactStoreService = {
                        forIssue: async () => {
                            artifactLoads.push("writable-loader");
                            throw new Error("dry run used writable artifacts");
                        },
                        forIssueReadOnly: async (issueNumber, scope) => {
                            artifactLoads.push("read-only-loader");
                            return readOnlyArtifactSpy(
                                await stores.forIssueReadOnly!(
                                    issueNumber,
                                    scope,
                                ),
                                artifactMutations,
                            );
                        },
                    };
                    const gitPreparationCalls: string[] = [];
                    const gitReadCalls: string[] = [];
                    const gitMutationCalls: string[] = [];
                    const gitRepository: RalphieRuntime["gitRepository"] = {
                        verifyInstalled: async () => {
                            gitPreparationCalls.push("verify-installed");
                        },
                        prepare: async (
                            repository,
                            branch,
                            preparedWorkspace,
                        ) => {
                            gitPreparationCalls.push(
                                `prepare:${repository}:${branch}:${preparedWorkspace}`,
                            );
                            return {
                                path: repositoryPath,
                                branch: branch ?? "main",
                                cloned: false,
                                branchChanged: false,
                                cleaned: false,
                            };
                        },
                    };
                    const realInvariant =
                        makeGitRepositoryInvariantService(CommandRunnerLive);
                    const invariant: RalphieRuntime["gitRepositoryInvariant"] =
                        {
                            capture: async (path) => {
                                gitReadCalls.push("capture");
                                return await realInvariant.capture(path);
                            },
                            verify: async (path, expected) => {
                                gitReadCalls.push("verify");
                                await realInvariant.verify(path, expected);
                            },
                        };
                    const gitIssueOperations: RalphieRuntime["gitIssueOperations"] =
                        {
                            stageAll: async () =>
                                forbiddenCall(gitMutationCalls, "stage-all"),
                            readStagedBinaryDiff: async () =>
                                forbiddenCall(
                                    gitMutationCalls,
                                    "read-staged-diff",
                                ),
                            readCommittedBinaryDiff: async () =>
                                forbiddenCall(
                                    gitMutationCalls,
                                    "read-committed-diff",
                                ),
                            hasStagedChanges: async () =>
                                forbiddenCall(
                                    gitMutationCalls,
                                    "has-staged-changes",
                                ),
                            commit: async () =>
                                forbiddenCall(gitMutationCalls, "commit"),
                            push: async () =>
                                forbiddenCall(gitMutationCalls, "push"),
                            createOrCheckoutFeatureBranch: async () =>
                                forbiddenCall(
                                    gitMutationCalls,
                                    "feature-branch",
                                ),
                            restoreBaseCheckout: async () =>
                                forbiddenCall(gitMutationCalls, "restore-base"),
                        };
                    const githubReadCalls: string[] = [];
                    const githubDeliveryCalls: string[] = [];
                    const githubClient: RalphieRuntime["githubClient"] = {
                        initialize: async () => {
                            githubReadCalls.push("initialize");
                            return {} as Octokit;
                        },
                    };
                    const githubIssues: RalphieRuntime["githubIssues"] = {
                        listOpen: async () => {
                            githubReadCalls.push("list-open");
                            return [issue];
                        },
                        refresh: async () => {
                            githubReadCalls.push("refresh");
                            return issue;
                        },
                        listDecompositionChildren: async () => {
                            githubReadCalls.push("list-children");
                            return [];
                        },
                    };
                    const githubIssueMutations: RalphieRuntime["githubIssueMutations"] =
                        {
                            create: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "issue.create",
                                ),
                            update: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "issue.update",
                                ),
                            close: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "issue.close",
                                ),
                        };
                    const githubPullRequests: RalphieRuntime["githubPullRequests"] =
                        {
                            createOrFind: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.create",
                                ),
                            read: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.read",
                                ),
                            readSnapshot: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.read-snapshot",
                                ),
                            rereadMatchingSnapshot: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.reread-snapshot",
                                ),
                            publishPullRequestReviewAttempts: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.publish-head-reviews",
                                ),
                            publishReviewAttempts: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.publish-reviews",
                                ),
                            merge: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pull-request.merge",
                                ),
                        };
                    const parentCompletion: RalphieRuntime["parentCompletion"] =
                        {
                            reconcileParent: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "parent.reconcile",
                                ),
                            reconcileAfterChildCompletion: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "parent.reconcile-child",
                                ),
                        };
                    const pipelineObservation: RalphieRuntime["pipelineObservation"] =
                        {
                            observe: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "pipeline.observe",
                                ),
                        };
                    const notification: RalphieRuntime["githubNeedsAttentionNotification"] =
                        {
                            notify: async () =>
                                forbiddenCall(
                                    githubDeliveryCalls,
                                    "needs-attention.notify",
                                ),
                        };
                    const implementationCalls: string[] = [];
                    const implementationExecutor: RalphieRuntime["implementationExecutor"] =
                        {
                            execute: async () =>
                                forbiddenCall(
                                    implementationCalls,
                                    "implementation.execute",
                                ),
                        };
                    const decompositionCalls: string[] = [];
                    const decompositionExecutor: RalphieRuntime["decompositionExecutor"] =
                        {
                            execute: async () =>
                                forbiddenCall(
                                    decompositionCalls,
                                    "decomposition.execute",
                                ),
                        };
                    const complexity =
                        makeComplexityAssessmentService(progress);
                    const grounding = makeGroundingAssessmentService(progress);
                    const resolution = {
                        verify: async () =>
                            forbiddenCall(
                                githubDeliveryCalls,
                                "resolution.verify",
                            ),
                    } satisfies RalphieRuntime["resolutionVerification"];
                    const normalExecutor = makeIssueExecutorService(
                        artifactStore,
                        complexity,
                        implementationExecutor,
                        decompositionExecutor,
                        grounding,
                        resolution,
                        progress,
                    );
                    const normalIssueCalls: string[] = [];
                    const issueExecutor: RalphieRuntime["issueExecutor"] = {
                        execute: async (context) => {
                            normalIssueCalls.push(
                                `issue-${context.issue.number}`,
                            );
                            return await normalExecutor.execute(context);
                        },
                    };
                    const dryRunIssueExecutor = makeDryRunIssueExecutorService(
                        artifactStore,
                        complexity,
                        progress,
                        grounding,
                    );
                    const savedStates: RunState[] = [];
                    const runStateStore: RalphieRuntime["runStateStore"] = {
                        load: async () => {
                            throw new Error("unexpected state load");
                        },
                        save: async (_path, state) => {
                            savedStates.push(structuredClone(state));
                        },
                    };
                    const workspaceService: RalphieRuntime["workspace"] = {
                        prepare: async (path) => {
                            await mkdir(path, { recursive: true });
                        },
                        remove: async () => {
                            throw new Error("unexpected workspace cleanup");
                        },
                    };
                    const pi: RalphieRuntime["pi"] = {
                        start: async () => {
                            piCalls.push("start");
                            return {
                                url: "local://pi",
                                client: piSetup.client,
                                close: async () => {
                                    piCalls.push("close");
                                },
                            };
                        },
                    };
                    const runtime = {
                        ...makeLiveRuntime({ pi, progress }),
                        githubClient,
                        githubIssues,
                        githubIssueMutations,
                        githubPullRequests,
                        githubNeedsAttentionNotification: notification,
                        gitRepository,
                        gitRepositoryInvariant: invariant,
                        gitIssueOperations,
                        parentCompletion,
                        pipelineObservation,
                        issueArtifactStore: artifactStore,
                        implementationExecutor,
                        decompositionExecutor,
                        issueExecutor,
                        dryRunIssueExecutor,
                        runStateStore,
                        workspace: workspaceService,
                    } satisfies RalphieRuntime;

                    const summary = await workflow(
                        {
                            repo: "owner/repository",
                            branch: "main",
                            maxIssues: 1,
                            issueFilters: {
                                labels: ["bug"],
                                sort: IssueSort.Created,
                                order: IssueOrder.Ascending,
                            },
                            agent: "build",
                            workspace,
                            cleanup: false,
                            startClean: false,
                            runId,
                            workflow: workflowMode,
                            dryRun: true,
                            onNeedsAttention: NeedsAttentionPolicy.Continue,
                        },
                        runtime,
                    );

                    const expectedRoute =
                        route === "actionable" ? "implementation" : route;
                    expect(summary.outcomes[0]?.outcome).toMatchObject({
                        kind:
                            route === "needs-attention"
                                ? IssueExecutionOutcomeKind.NeedsAttention
                                : IssueExecutionOutcomeKind.Skipped,
                        route: expectedRoute,
                    });
                    expect(artifactLoads).toEqual(["read-only-loader"]);
                    expect(artifactMutations).toEqual([]);
                    expect(normalIssueCalls).toEqual([]);
                    expect(implementationCalls).toEqual([]);
                    expect(decompositionCalls).toEqual([]);
                    expect(gitMutationCalls).toEqual([]);
                    expect(githubReadCalls).toEqual([
                        "initialize",
                        "list-open",
                        "refresh",
                    ]);
                    expect(githubDeliveryCalls).toEqual([]);
                    expect(gitPreparationCalls).toEqual([
                        "verify-installed",
                        `prepare:owner/repository:main:${workspace}`,
                    ]);
                    expect(gitReadCalls.length).toBeGreaterThan(0);
                    expect(piCalls).toEqual(["start", "close"]);
                    expect(piSetup.promptKinds).toEqual(
                        route === "actionable"
                            ? ["structured", "structured"]
                            : ["structured"],
                    );
                    expect(issue.state).toBe("open");
                    expect(initialBranch).toBe("main");
                    expect(
                        git(repositoryPath, ["branch", "--show-current"]),
                    ).toBe(initialBranch);
                    expect(git(repositoryPath, ["rev-parse", "HEAD"])).toBe(
                        initialSha,
                    );
                    expect(
                        git(repositoryPath, ["status", "--porcelain=v1"]),
                    ).toBe("");
                    expect(
                        await Bun.file(
                            join(repositoryPath, "implemented.txt"),
                        ).exists(),
                    ).toBe(false);
                    expect(
                        await Bun.file(
                            issueArtifactPath(
                                {
                                    workspace,
                                    runId,
                                    repository: "owner/repository",
                                },
                                17,
                            ),
                        ).exists(),
                    ).toBe(false);
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            stage: "run",
                            status: "info",
                            details: expect.objectContaining({
                                workflow: workflowMode,
                                dryRun: true,
                            }),
                        }),
                    );
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            stage: "run",
                            status: "succeeded",
                            details: expect.objectContaining({
                                workflow: workflowMode,
                                routes: [
                                    {
                                        issueNumber: 17,
                                        route: expectedRoute,
                                    },
                                ],
                            }),
                        }),
                    );
                    expect(savedStates.at(-1)?.status).toBe(
                        RunStateStatus.Complete,
                    );
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );

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
            const pi = {
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
            } as unknown as PiClient;
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
                    pi,
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
                    pi,
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