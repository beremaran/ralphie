import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "octokit";

import type { AgentClient } from "../../src/opencode/client.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import type { GitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";
import type { IssueCheckpoint } from "../../src/git/issue-checkpoint.ts";
import type { GitIssuePreparationService } from "../../src/git/issue-preparation.ts";
import type { GitIssueOperationsService } from "../../src/git/issue-operations.ts";
import type { GitRemoteSafetyService } from "../../src/git/remote-safety.ts";
import type {
    GitRepositoryInvariant,
    GitRepositoryInvariantService,
} from "../../src/git/repository-invariant.ts";
import type { GitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import type { GitHubIssueMutationService } from "../../src/github/issue-mutations.ts";
import type { GitHubIssuesService } from "../../src/github/issues.ts";
import { DEFAULT_AGENT } from "../../src/agent/model.ts";
import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import {
    PI_DECISION_PERMISSION_POLICY,
    makeAgentSessionDiagnostics,
    type PiNeedsAttentionRequest,
} from "../../src/agent/task-session.ts";
import {
    IssueArtifactKind,
    issueArtifactPath,
    makeIssueArtifactStore,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
    type IssueFreshnessFingerprint,
} from "../../src/issues/artifacts.ts";
import type { ComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    makeDecompositionExecutorService,
    type DecompositionExecutorService,
} from "../../src/issues/decomposition-executor.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    IssueResolutionStatus,
    NeedsAttentionReason,
    ReviewFindingSeverity,
    ReviewVerdict,
    complexityDecisionSchema,
    groundingDecisionSchema,
    type GroundingDecision,
} from "../../src/issues/decisions.ts";
import {
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "../../src/issues/implementation-executor.ts";
import type { GroundingAssessmentService } from "../../src/issues/grounding.ts";
import {
    type IssueExecutionContext,
    IssueExecutionOutcomeKind,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import {
    makeNeedsAttentionRouterService,
    type NeedsAttentionRouterService,
} from "../../src/issues/needs-attention.ts";
import {
    makeIssueRecoveryService,
    type IssueRecoveryService,
    type NeedsAttentionRecoveryInput,
} from "../../src/issues/recovery.ts";
import { makeResolutionVerificationService } from "../../src/issues/resolution-verification.ts";
import {
    IssueQueueResumeStrategy,
    REVIEW_ITERATION_LIMIT,
} from "../../src/issues/stage.ts";
import type { IssueVerificationService } from "../../src/issues/verification.ts";
import {
    makeProgressRecorder,
    type ProgressReporterService,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";
import { RalphieError } from "../../src/shared/error.ts";

const issue: GitHubIssue = {
    number: 42,
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/42",
    body: "Test body",
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
};

const CHECKPOINT: IssueCheckpoint = { branch: "develop", sha: "a".repeat(40) };
const INVARIANT: GitRepositoryInvariant = {
    branch: CHECKPOINT.branch,
    head: CHECKPOINT.sha,
};
const TREE_SHA = "0".repeat(40);
const VERIFIER_TITLE = "Verify needs-attention request for issue #42";

const currentFingerprint: IssueFreshnessFingerprint = {
    updatedAt: "2026-08-28T00:00:00.000Z",
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
};
const changedFingerprint: IssueFreshnessFingerprint = {
    updatedAt: "2026-08-29T00:00:00.000Z",
    commentCount: 1,
    commentVersion: "2026-08-29T00:00:00.000Z",
};

const attentionRequest: PiNeedsAttentionRequest = {
    reason: "missing_information",
    message: "The request is blocked on a prerequisite.",
};

const attentionDecision = {
    disposition: GroundingDisposition.NeedsAttention as const,
    reason: NeedsAttentionReason.MissingInformation as const,
    summary: "A prerequisite is still open.",
    evidence: ["Issue body links the open prerequisite."],
    questions: ["Complete the prerequisite, then retry."],
};

const confirmedVerifierOutput: GroundingDecision = attentionDecision;

const implementationChanged = {
    status: "changed",
    summary: "Implemented the requested behavior.",
    validation: ["The focused regression test passes."],
};
const commitMessage = { subject: "Implement the requested behavior" };
const approvedReview = {
    verdict: ReviewVerdict.Approved,
    summary: "The staged changes address the issue.",
    findings: [],
};
const changesRequestedReview = (description: string) => ({
    verdict: ReviewVerdict.ChangesRequested,
    summary: `Findings remain: ${description}`,
    findings: [{ severity: ReviewFindingSeverity.Blocking, description }],
});

type FakeStructuredResponse = {
    readonly structured?: unknown;
    readonly needsAttention?: unknown;
    readonly error?: boolean;
};

type FakeScript = {
    readonly titlePrefix: string;
    readonly count?: number;
    readonly result:
        | FakeStructuredResponse
        | ((served: number) => FakeStructuredResponse);
};

type RecordedCreate = {
    readonly sessionID: string;
    readonly title?: string;
    readonly agent?: string;
};

type RecordedPrompt = {
    readonly sessionID: string;
    readonly title: string;
};

/**
 * Deterministic Pi client. Each structured call creates one session and then
 * prompts it, so responses are matched by the session title captured at
 * create time. A script is served up to `count` times in order; the first
 * matching script with remaining budget wins.
 */
const fakePi = (scripts: ReadonlyArray<FakeScript>) => {
    const creates: RecordedCreate[] = [];
    const prompts: RecordedPrompt[] = [];
    const sessionTitles = new Map<string, string>();
    const served = new Map<string, number>();
    const client: AgentClient = {
        session: {
            create: async (input) => {
                const sessionID = `session-${creates.length + 1}`;
                sessionTitles.set(sessionID, input.title ?? "");
                creates.push({
                    sessionID,
                    title: input.title,
                    agent: (input as { readonly agent?: string }).agent,
                });
                return { data: { id: sessionID } };
            },
            prompt: async (input) => {
                const title = sessionTitles.get(input.sessionID) ?? "";
                const index = scripts.findIndex((script) => {
                    const remaining =
                        (script.count ?? Number.POSITIVE_INFINITY) -
                        (served.get(script.titlePrefix) ?? 0);
                    return (
                        title.startsWith(script.titlePrefix) && remaining > 0
                    );
                });
                if (index === -1) {
                    throw new Error(`Fake Pi has no response for ${title}`);
                }
                const script = scripts[index]!;
                const servedCount = (served.get(script.titlePrefix) ?? 0) + 1;
                served.set(script.titlePrefix, servedCount);
                const response =
                    typeof script.result === "function"
                        ? script.result(servedCount)
                        : script.result;
                prompts.push({ sessionID: input.sessionID, title });
                if (response.error === true) {
                    return {
                        error: {
                            name: "PiError",
                            data: {
                                message: `fake prompt failure for ${title}`,
                            },
                        },
                    };
                }
                return {
                    data: {
                        info: {
                            id: `message-${prompts.length}`,
                            role: "assistant",
                            structured: response.structured,
                        },
                        parts: [],
                        ...(response.needsAttention === undefined
                            ? {}
                            : { needsAttention: response.needsAttention }),
                    },
                };
            },
        },
    };
    return { client, creates, prompts };
};

const verifierPromptsOf = (prompts: ReadonlyArray<RecordedPrompt>) =>
    prompts.filter(({ title }) => title.startsWith(VERIFIER_TITLE));

const makeContext = (options: {
    readonly agent: AgentClient;
    readonly invariant: GitRepositoryInvariantService;
    readonly issueOverride?: GitHubIssue;
}): IssueExecutionContext => ({
    issue: options.issueOverride ?? issue,
    repository: "owner/repo",
    repositoryPath: "/work/repository",
    targetBranch: "develop",
    workspace: "/work/workspace",
    runId: "test-run",
    octokit: {} as Octokit,
    agent: options.agent,
    agentSelection: { agent: DEFAULT_AGENT },
    agentDiagnostics: makeAgentSessionDiagnostics(),
    repositoryInvariant: options.invariant,
});

const makeInvariant = (
    verifyCalls: Array<{ branch: string; head: string }>,
): GitRepositoryInvariantService => ({
    capture: async () => INVARIANT,
    verify: async (_repositoryPath, expected) => {
        verifyCalls.push(expected);
    },
});

const makeFakeRecovery = (
    options: {
        readonly failNeedsAttention?: boolean | (() => boolean);
        readonly trace?: string[];
    } = {},
): {
    readonly service: IssueRecoveryService;
    readonly recoveryInputs: NeedsAttentionRecoveryInput[];
} => {
    const recoveryInputs: NeedsAttentionRecoveryInput[] = [];
    return {
        service: {
            handleReviewExhaustion: async () => ({
                outcome: "escalated-to-decomposition",
                diagnosticsPath: "/diag/review-exhaustion",
                nextWorkflow: "decomposition",
                resume: IssueQueueResumeStrategy,
            }),
            handleNeedsAttention: async (input) => {
                recoveryInputs.push(input);
                options.trace?.push("recovery:needs-attention");
                const failing =
                    typeof options.failNeedsAttention === "function"
                        ? options.failNeedsAttention()
                        : options.failNeedsAttention === true;
                if (failing) {
                    throw new RalphieError({
                        message: "needs-attention recovery failed",
                    });
                }
                return { diagnosticsPath: "/diag/needs-attention" };
            },
        },
        recoveryInputs,
    };
};

const makeRealRouter = (
    progress: ProgressReporterService,
): {
    readonly router: NeedsAttentionRouterService;
    readonly recovery: IssueRecoveryService;
    readonly recoveryInputs: NeedsAttentionRecoveryInput[];
} => {
    const { service, recoveryInputs } = makeFakeRecovery();
    return {
        router: makeNeedsAttentionRouterService(service),
        recovery: service,
        recoveryInputs,
    };
};

const makeTrackedStore = async (
    fails?: (method: string) => boolean,
): Promise<IssueArtifactStore> => {
    const store = await makeIssueArtifactStore(issue.number);
    const throwIfFailing = (method: string): void => {
        if (fails?.(method) === true) {
            throw new RalphieError({ message: `persist failed for ${method}` });
        }
    };
    return {
        issueNumber: store.issueNumber,
        write: async (kind, value) => {
            throwIfFailing("write");
            await store.write(kind, value);
        },
        read: store.read,
        has: store.has,
        recordResolutionDecision: async (value) => {
            throwIfFailing("recordResolutionDecision");
            await store.recordResolutionDecision(value);
        },
        beginNeedsAttentionHandoff: async (value) => {
            throwIfFailing("beginNeedsAttentionHandoff");
            await store.beginNeedsAttentionHandoff(value);
        },
        recordNeedsAttentionDecision: async (value) => {
            throwIfFailing("recordNeedsAttentionDecision");
            await store.recordNeedsAttentionDecision(value);
        },
        appendReview: async (review) => {
            throwIfFailing("appendReview");
            await store.appendReview(review);
        },
        appendPullRequestReview: async (review) => {
            throwIfFailing("appendPullRequestReview");
            await store.appendPullRequestReview(review);
        },
        recordCreatedIssue: async (key, createdIssueNumber) => {
            throwIfFailing("recordCreatedIssue");
            await store.recordCreatedIssue(key, createdIssueNumber);
        },
        resetImplementationAttempt: async () => {
            throwIfFailing("resetImplementationAttempt");
            await store.resetImplementationAttempt();
        },
        clearUnresolvedResolutionDecision: async () => {
            throwIfFailing("clearUnresolvedResolutionDecision");
            return store.clearUnresolvedResolutionDecision();
        },
        invalidateStaleIssueDecisions: async (fingerprint) => {
            throwIfFailing("invalidateStaleIssueDecisions");
            return store.invalidateStaleIssueDecisions(fingerprint);
        },
        invalidateStaleNeedsAttentionDecision: async (fingerprint) => {
            throwIfFailing("invalidateStaleNeedsAttentionDecision");
            return store.invalidateStaleNeedsAttentionDecision(fingerprint);
        },
        invalidateNeedsAttentionDecision: async (fingerprint) => {
            throwIfFailing("invalidateNeedsAttentionDecision");
            return store.invalidateNeedsAttentionDecision(fingerprint);
        },
        clearNeedsAttentionHandoff: async () => {
            throwIfFailing("clearNeedsAttentionHandoff");
            await store.clearNeedsAttentionHandoff();
        },
    };
};

const resolutionVerification = {
    verify: async () => ({
        decision: {
            status: IssueResolutionStatus.Resolved,
            summary: "The checkout already satisfies the issue.",
            evidence: ["The focused regression test passes."],
        },
        sessionID: "resolution-1",
    }),
};

const defaultImplementation: ImplementationExecutorService = {
    execute: async () => ({
        kind: IssueExecutionOutcomeKind.Completed,
        completion: "pushed-commit",
        commitSha: "abc123",
        reviewCount: 1,
    }),
};

type ExecutorHarnessOptions = {
    readonly trace?: string[];
    readonly grounding?: GroundingAssessmentService;
    readonly complexity?: ComplexityAssessmentService;
    readonly implementation?: ImplementationExecutorService;
    readonly decomposition?: DecompositionExecutorService;
    readonly withRouter?: boolean;
    readonly failPersist?: (method: string) => boolean;
};

const makeExecutorHarness = async (options: ExecutorHarnessOptions = {}) => {
    const trace = options.trace ?? [];
    const events: ProgressUpdate[] = [];
    const progress = makeProgressRecorder(events);
    const { client, creates, prompts } = fakePi([
        {
            titlePrefix: VERIFIER_TITLE,
            result: { structured: confirmedVerifierOutput },
        },
    ]);
    const store = await makeTrackedStore(options.failPersist);
    const artifactStores: IssueArtifactStoreService = {
        forIssue: async () => store,
    };
    const complexity: ComplexityAssessmentService = options.complexity ?? {
        assess: async (context) => {
            trace.push(`complexity:${context.issue.number}`);
            return {
                decision: {
                    complexity: ComplexityLevel.Level2,
                    rationale: "The fixture is directly actionable.",
                },
                sessionID: "complexity-1",
            };
        },
    };
    const grounding: GroundingAssessmentService = options.grounding ?? {
        assess: async (context) => {
            trace.push(`grounding:${context.issue.number}`);
            return {
                decision: { disposition: GroundingDisposition.Actionable },
                sessionID: "grounding-1",
            };
        },
    };
    const recoveryTrace: string[] = [];
    const { service: recovery, recoveryInputs } = makeFakeRecovery({
        trace: recoveryTrace,
    });
    const router =
        options.withRouter === false
            ? undefined
            : makeNeedsAttentionRouterService(recovery);
    const implementation =
        options.implementation ??
        ({
            execute: async (input) => {
                trace.push(`implementation:${input.context.issue.number}`);
                return {
                    kind: IssueExecutionOutcomeKind.Completed,
                    completion: "pushed-commit",
                    commitSha: "abc123",
                    reviewCount: 1,
                };
            },
        } satisfies ImplementationExecutorService);
    const decomposition: DecompositionExecutorService =
        options.decomposition ?? {
            execute: async (input) => {
                trace.push(`decomposition:${input.context.issue.number}`);
                return {
                    kind: IssueExecutionOutcomeKind.Decomposed,
                    childIssueNumbers: [51],
                };
            },
        };
    const verifyCalls: Array<{ branch: string; head: string }> = [];
    const context = makeContext({
        agent: client,
        invariant: makeInvariant(verifyCalls),
    });
    const executor = makeIssueExecutorService(
        artifactStores,
        complexity,
        implementation,
        decomposition,
        grounding,
        resolutionVerification,
        progress,
        router,
    );
    return {
        executor,
        store,
        context,
        creates,
        prompts,
        trace,
        events,
        verifyCalls,
        recoveryInputs,
        recoveryTrace,
        grounding,
        complexity,
    };
};

type ImplementationHarnessOptions = {
    readonly scripts?: ReadonlyArray<FakeScript>;
    readonly withRouter?: boolean;
    readonly recoveryFailure?: boolean;
};

const makeImplementationHarness = async (
    options: ImplementationHarnessOptions = {},
) => {
    const events: ProgressUpdate[] = [];
    const progress = makeProgressRecorder(events);
    const { client, creates, prompts } = fakePi(options.scripts ?? []);
    const store = await makeTrackedStore();
    const recoveryTrace: string[] = [];
    const { service: recovery, recoveryInputs } = makeFakeRecovery({
        failNeedsAttention: options.recoveryFailure,
        trace: recoveryTrace,
    });
    const router =
        options.withRouter === false
            ? undefined
            : makeNeedsAttentionRouterService(recovery);
    const verifyCalls: Array<{ branch: string; head: string }> = [];
    const context = makeContext({
        agent: client,
        invariant: makeInvariant(verifyCalls),
    });
    const trace: string[] = [];
    const operations: GitIssueOperationsService = {
        stageAll: async () => {
            trace.push("ops:stageAll");
        },
        readStagedBinaryDiff: async () => {
            trace.push("ops:readDiff");
            return "";
        },
        readCommittedBinaryDiff: async () => "",
        hasStagedChanges: async () => {
            trace.push("ops:hasStaged");
            return true;
        },
        commit: async () => {
            trace.push("ops:commit");
            return { sha: "c".repeat(40), treeSha: "t".repeat(40) };
        },
        push: async () => {
            trace.push("ops:push");
        },
        createOrCheckoutFeatureBranch: async () => ({
            branch: "ralphie/issue-42",
            baseBranch: "develop",
            baseSha: CHECKPOINT.sha,
            headSha: "h".repeat(40),
            created: false,
        }),
        restoreBaseCheckout: async () => {},
    };
    const preparation: GitIssuePreparationService = {
        prepare: async () => CHECKPOINT,
    };
    const remoteSafety: GitRemoteSafetyService = {
        verifyDirectPush: async () => {
            trace.push("ops:remoteSafety");
            return {
                repository: "owner/repo",
                branch: "develop",
                origin: "origin",
                commitsBehindBase: 0,
                commitsAheadBase: 1,
                pushMode: "non-force",
            };
        },
        verifyManagedRevisionPush: async () => {
            trace.push("ops:remoteSafety:managed");
            return {
                repository: "owner/repo",
                branch: "develop",
                origin: "origin",
                baseSha: CHECKPOINT.sha,
                expectedPriorHeadSha: CHECKPOINT.sha,
                commitsBehindBase: 0,
                commitsAheadBase: 0,
                pushMode: "non-force",
            };
        },
        verifyManagedRevisionPrePush: async () => {
            trace.push("ops:remoteSafety:managed:prePush");
            return {
                repository: "owner/repo",
                branch: "develop",
                origin: "origin",
                baseSha: CHECKPOINT.sha,
                expectedPriorHeadSha: CHECKPOINT.sha,
                commitsBehindBase: 0,
                commitsAheadBase: 0,
                pushMode: "non-force",
            };
        },
    };
    const verification: IssueVerificationService = {
        stagedTreeSha: async () => TREE_SHA,
        verify: async () => ({
            stagedTreeSha: TREE_SHA,
            commands: [
                { command: "test", exitCode: 0, stdout: "", stderr: "" },
            ],
        }),
    };
    const executor = makeImplementationExecutorService(
        preparation,
        operations,
        remoteSafety,
        recovery,
        progress,
        verification,
        makeResolutionVerificationService(progress),
        router,
    );
    return {
        executor,
        store,
        context,
        creates,
        prompts,
        trace,
        events,
        verifyCalls,
        recoveryInputs,
        recoveryTrace,
    };
};

type DecompositionHarnessOptions = {
    readonly scripts?: ReadonlyArray<FakeScript>;
    readonly withRouter?: boolean;
};

const makeDecompositionHarness = async (
    options: DecompositionHarnessOptions = {},
) => {
    const events: ProgressUpdate[] = [];
    const progress = makeProgressRecorder(events);
    const { client, creates, prompts } = fakePi(options.scripts ?? []);
    const store = await makeTrackedStore();
    const { service: recovery, recoveryInputs } = makeFakeRecovery();
    const router =
        options.withRouter === false
            ? undefined
            : makeNeedsAttentionRouterService(recovery);
    const verifyCalls: Array<{ branch: string; head: string }> = [];
    const context = makeContext({
        agent: client,
        invariant: makeInvariant(verifyCalls),
    });
    const githubCalls: string[] = [];
    const mutations: GitHubIssueMutationService = {
        create: async () => {
            githubCalls.push("create");
            return { ...issue, number: 51 };
        },
        update: async () => {
            githubCalls.push("update");
            return issue;
        },
        close: async () => {
            githubCalls.push("close");
            return issue;
        },
    };
    const issues: GitHubIssuesService = {
        listOpen: async () => {
            githubCalls.push("listOpen");
            return [];
        },
        refresh: async () => {
            githubCalls.push("refresh");
            return issue;
        },
        listDecompositionChildren: async () => {
            githubCalls.push("listChildren");
            return [];
        },
    };
    const relationships: GitHubIssueRelationshipService = {
        listSubIssues: async () => {
            githubCalls.push("listSubIssues");
            return [];
        },
        parentOf: async () => undefined,
        attachSubIssue: async () => {
            githubCalls.push("attachSubIssue");
        },
        listBlockedBy: async () => {
            githubCalls.push("listBlockedBy");
            return [];
        },
        addBlockedBy: async () => {
            githubCalls.push("addBlockedBy");
        },
    };
    const executor = makeDecompositionExecutorService(
        mutations,
        issues,
        relationships,
        progress,
        router,
    );
    return {
        executor,
        store,
        context,
        creates,
        prompts,
        githubCalls,
        verifyCalls,
        recoveryInputs,
        events,
    };
};

describe("structured-output needs-attention side channel", () => {
    test("surfaces a valid side-channel request from a grounding call", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Check readiness of issue #42",
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                    },
                    needsAttention: attentionRequest,
                },
            },
        ]);
        const result = await requestStructuredOutput(client, {
            directory: "/work/repository",
            title: "Check readiness of issue #42",
            prompt: "ground the fixture issue",
            schema: groundingDecisionSchema,
        });
        expect(result.output).toEqual({
            disposition: GroundingDisposition.Actionable,
        });
        expect(result.needsAttention).toEqual(attentionRequest);
    });

    test("parses the side channel like every structured call, including complexity", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Assess issue #42",
                result: {
                    structured: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    needsAttention: attentionRequest,
                },
            },
        ]);
        const result = await requestStructuredOutput(client, {
            directory: "/work/repository",
            title: "Assess issue #42",
            prompt: "assess the fixture issue",
            schema: complexityDecisionSchema,
        });
        expect(result.output).toEqual({
            complexity: ComplexityLevel.Level2,
            rationale: "Directly actionable.",
        });
        expect(result.needsAttention).toEqual(attentionRequest);
    });

    test("ignores an invalid side-channel value", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Check readiness of issue #42",
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                    },
                    needsAttention: { reason: "not-a-reason" },
                },
            },
        ]);
        const result = await requestStructuredOutput(client, {
            directory: "/work/repository",
            title: "Check readiness of issue #42",
            prompt: "ground the fixture issue",
            schema: groundingDecisionSchema,
        });
        expect(result.needsAttention).toBeUndefined();
    });

    test("rejects structured output that fails the schema", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Check readiness of issue #42",
                result: { structured: { disposition: "not-a-disposition" } },
            },
        ]);
        await expect(
            requestStructuredOutput(client, {
                directory: "/work/repository",
                title: "Check readiness of issue #42",
                prompt: "ground the fixture issue",
                schema: groundingDecisionSchema,
            }),
        ).rejects.toBeInstanceOf(RalphieError);
    });
});

describe("needs-attention router", () => {
    test("returns undefined without a handoff or request and starts no verifier session", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([]);
        const store = await makeTrackedStore();
        const { router } = makeRealRouter(progress);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        await expect(
            router.route({ context, artifacts: store }),
        ).resolves.toBeUndefined();
        expect(verifierPromptsOf(prompts)).toHaveLength(0);
    });

    test.each([
        { disposition: GroundingDisposition.Actionable },
        { disposition: GroundingDisposition.AlreadyResolved },
    ])(
        "clears the handoff and resumes when the verifier returns $disposition",
        async ({ disposition }) => {
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const { client, prompts } = fakePi([
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: { disposition } },
                },
            ]);
            const store = await makeTrackedStore();
            const { router, recoveryInputs } = makeRealRouter(progress);
            const verifyCalls: Array<{ branch: string; head: string }> = [];
            const context = makeContext({
                agent: client,
                invariant: makeInvariant(verifyCalls),
            });
            const outcome = await router.route({
                context,
                artifacts: store,
                request: attentionRequest,
                checkpoint: CHECKPOINT,
            });
            expect(outcome).toBeUndefined();
            expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
                false,
            );
            expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
                false,
            );
            expect(recoveryInputs).toHaveLength(0);
            expect(verifierPromptsOf(prompts)).toHaveLength(1);
        },
    );

    test("confirms with one fresh read-only verifier session and invokes recovery once", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts, creates } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeNeedsAttentionRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const outcome = await router.route({
            context,
            artifacts: store,
            request: attentionRequest,
            checkpoint: CHECKPOINT,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
            reason: NeedsAttentionReason.MissingInformation,
            summary: "A prerequisite is still open.",
            evidence: ["Issue body links the open prerequisite."],
            questions: ["Complete the prerequisite, then retry."],
        });
        const verifierPrompts = verifierPromptsOf(prompts);
        expect(verifierPrompts).toHaveLength(1);
        const verifierSession = creates.find(
            (created) => created.sessionID === verifierPrompts[0]?.sessionID,
        );
        expect(verifierSession).toBeDefined();
        expect(verifyCalls).toEqual([INVARIANT]);
        expect(recoveryInputs).toHaveLength(1);
        expect(recoveryInputs[0]).toMatchObject({
            checkpoint: CHECKPOINT,
            fingerprint: currentFingerprint,
            request: attentionRequest,
            decision: attentionDecision,
        });
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(true);
    });

    test("resumes a pending handoff with a fresh verifier session", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        await store.beginNeedsAttentionHandoff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        const { router, recoveryInputs } = makeRealRouter(progress);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const outcome = await router.route({ context, artifacts: store });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("reuses a persisted decision without a fresh verifier session when recovery retries", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([]);
        const store = await makeTrackedStore();
        await store.beginNeedsAttentionHandoff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordNeedsAttentionDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        const { router, recoveryInputs } = makeRealRouter(progress);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const outcome = await router.route({ context, artifacts: store });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(0);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("invalidates a stale persisted decision before verification", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        await store.recordNeedsAttentionDecision({
            decision: attentionDecision,
            fingerprint: changedFingerprint,
        });
        const { router, recoveryInputs } = makeRealRouter(progress);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const outcome = await router.route({
            context,
            artifacts: store,
            request: attentionRequest,
            checkpoint: CHECKPOINT,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("propagates verifier failures and keeps the handoff pending", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            { titlePrefix: VERIFIER_TITLE, result: { error: true } },
        ]);
        const store = await makeTrackedStore();
        const { router, recoveryInputs } = makeRealRouter(progress);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        await expect(
            router.route({
                context,
                artifacts: store,
                request: attentionRequest,
                checkpoint: CHECKPOINT,
            }),
        ).rejects.toBeInstanceOf(RalphieError);
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(0);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);
    });
});

describe("issue executor needs-attention routing", () => {
    test("executes normally with zero verifier sessions when no signal is present", async () => {
        const harness = await makeExecutorHarness();
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: "abc123",
            reviewCount: 1,
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.trace).toContain("complexity:42");
        expect(harness.trace).toContain("implementation:42");
        expect(harness.recoveryInputs).toHaveLength(0);
    });

    test("confirms a grounding signal with one fresh read-only verifier session and recovers once", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({
            trace,
            grounding: {
                assess: async (context) => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
            reason: NeedsAttentionReason.MissingInformation,
            summary: "A prerequisite is still open.",
            evidence: ["Issue body links the open prerequisite."],
            questions: ["Complete the prerequisite, then retry."],
        });
        const verifierPrompts = verifierPromptsOf(harness.prompts);
        expect(verifierPrompts).toHaveLength(1);
        const verifierSession = harness.creates.find(
            (created) => created.sessionID === verifierPrompts[0]?.sessionID,
        );
        expect(verifierSession).toBeDefined();
        expect(harness.verifyCalls).toEqual([INVARIANT]);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.recoveryInputs[0]).toMatchObject({
            checkpoint: CHECKPOINT,
            fingerprint: currentFingerprint,
            request: attentionRequest,
        });
        expect(harness.trace).not.toContain("implementation:42");
    });

    test("does not treat a grounding needs_attention result as confirmation when its side-channel request is rejected", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                    },
                },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeNeedsAttentionRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    sessionID: "complexity-1",
                }),
            },
            defaultImplementation,
            {
                execute: async () => {
                    throw new Error("decomposition must not run");
                },
            },
            {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const outcome = await executor.execute(context);
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.MissingInformation,
            artifactPath: issueArtifactPath(
                {
                    workspace: context.workspace,
                    runId: context.runId,
                    repository: context.repository,
                },
                context.issue.number,
            ),
        });
        expect(outcome).not.toHaveProperty("diagnosticsPath");
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(0);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(true);
        expect(verifyCalls).toEqual([INVARIANT]);
    });

    test("ignores a complexity side-channel without confirmation or routing", async () => {
        const harness = await makeExecutorHarness({
            complexity: {
                assess: async (context) => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    sessionID: "complexity-1",
                    needsAttention: attentionRequest,
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: "abc123",
            reviewCount: 1,
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.recoveryInputs).toHaveLength(0);
        expect(harness.store.has(IssueArtifactKind.ComplexityDecision)).toBe(
            true,
        );
    });

    test("reuses a cached complexity decision on restart", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({ trace });
        const first = await harness.executor.execute(harness.context);
        const second = await harness.executor.execute(harness.context);
        expect(first.kind).toBe(IssueExecutionOutcomeKind.Completed);
        expect(second.kind).toBe(IssueExecutionOutcomeKind.Completed);
        expect(trace.filter((entry) => entry === "complexity:42")).toHaveLength(
            1,
        );
        expect(
            trace.filter((entry) => entry === "implementation:42"),
        ).toHaveLength(2);
    });

    test("resumes a pending handoff after a verifier failure without trusting the signal", async () => {
        let failVerifier = true;
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                count: 1,
                result: () =>
                    failVerifier
                        ? { error: true }
                        : { structured: confirmedVerifierOutput },
            },
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeNeedsAttentionRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    sessionID: "complexity-1",
                }),
            },
            defaultImplementation,
            {
                execute: async () => {
                    throw new Error("decomposition must not run");
                },
            },
            {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const failed = await executor.execute(context);
        expect(failed).toMatchObject({
            kind: IssueExecutionOutcomeKind.Failed,
        });
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(false);

        failVerifier = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(2);
        expect(recoveryInputs).toHaveLength(1);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
    });

    test("halts on decision persistence failure and resumes with a fresh verifier", async () => {
        let failPersistence = true;
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore(
            (method) =>
                failPersistence && method === "recordNeedsAttentionDecision",
        );
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeNeedsAttentionRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    sessionID: "complexity-1",
                }),
            },
            defaultImplementation,
            {
                execute: async () => {
                    throw new Error("decomposition must not run");
                },
            },
            {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const failed = await executor.execute(context);
        expect(failed).toMatchObject({
            kind: IssueExecutionOutcomeKind.Failed,
        });
        expect(recoveryInputs).toHaveLength(0);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(false);

        failPersistence = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(2);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("recovery failure after decision persistence reuses the confirmed decision on restart", async () => {
        let failRecovery = true;
        const events: ProgressUpdate[] = [];
        const progress = makeProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery({
            failNeedsAttention: () => failRecovery,
        });
        const router = makeNeedsAttentionRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Directly actionable.",
                    },
                    sessionID: "complexity-1",
                }),
            },
            defaultImplementation,
            {
                execute: async () => {
                    throw new Error("decomposition must not run");
                },
            },
            {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const failed = await executor.execute(context);
        expect(failed).toMatchObject({
            kind: IssueExecutionOutcomeKind.Failed,
            message: "needs-attention recovery failed",
        });
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);

        failRecovery = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(2);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
    });

    test("fails closed when a signal arrives without a router", async () => {
        const harness = await makeExecutorHarness({
            withRouter: false,
            grounding: {
                assess: async (context) => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    needsAttention: attentionRequest,
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.Failed,
        });
        if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
            expect(outcome.message).toContain("verifier/router service");
        }
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
    });

    test("review exhaustion still returns Escalated with its created children", async () => {
        const harness = await makeExecutorHarness({
            implementation: {
                execute: async () => ({
                    kind: IssueExecutionOutcomeKind.Escalated,
                    diagnosticsPath: "/diag/review-exhaustion",
                    reason: "Review did not converge.",
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Escalated);
        if (outcome.kind === IssueExecutionOutcomeKind.Escalated) {
            expect(outcome.diagnosticsPath).toBe("/diag/review-exhaustion");
            expect(outcome.childIssueNumbers).toEqual([51]);
        }
        expect(harness.trace).toContain("decomposition:42");
    });
});

describe("implementation executor needs-attention routing", () => {
    test("completes the full implementation flow with zero verifier sessions when no signal is present", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Review issue #42",
                    result: { structured: approvedReview },
                },
                {
                    titlePrefix: "Generate commit message for issue #42",
                    result: { structured: commitMessage },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.recoveryInputs).toHaveLength(0);
        expect(harness.trace).toContain("ops:commit");
        expect(harness.trace).toContain("ops:push");
    });

    test.each([
        { disposition: GroundingDisposition.Actionable },
        { disposition: GroundingDisposition.AlreadyResolved },
    ])(
        "resumes the original implementation and review flow when the verifier rejects with $disposition",
        async ({ disposition }) => {
            const harness = await makeImplementationHarness({
                scripts: [
                    {
                        titlePrefix: "Implement issue #42",
                        result: {
                            structured: implementationChanged,
                            needsAttention: attentionRequest,
                        },
                    },
                    {
                        titlePrefix: VERIFIER_TITLE,
                        result: { structured: { disposition } },
                    },
                    {
                        titlePrefix: "Review issue #42",
                        result: { structured: approvedReview },
                    },
                    {
                        titlePrefix: "Generate commit message for issue #42",
                        result: { structured: commitMessage },
                    },
                ],
            });
            const outcome = await harness.executor.execute({
                context: harness.context,
                artifacts: harness.store,
            });
            expect(outcome).toMatchObject({
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
            });
            expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
            expect(harness.recoveryInputs).toHaveLength(0);
            expect(harness.trace).toContain("ops:commit");
            expect(harness.trace).toContain("ops:push");
        },
    );

    test("confirms an implementation signal before any stage, commit, or push", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: {
                        structured: implementationChanged,
                        needsAttention: attentionRequest,
                    },
                },
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: confirmedVerifierOutput },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.recoveryInputs[0]?.checkpoint).toEqual(CHECKPOINT);
        expect(harness.trace).not.toContain("ops:stageAll");
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("routes a signal from the read-only review path before any commit", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Review issue #42",
                    result: {
                        structured: approvedReview,
                        needsAttention: attentionRequest,
                    },
                },
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: confirmedVerifierOutput },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.prompts).toHaveLength(3);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("routes a signal from a review-fix attempt and confirms before any further review", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Review issue #42",
                    result: {
                        structured: changesRequestedReview("Finding one"),
                    },
                },
                {
                    titlePrefix: "Address review for issue #42",
                    result: {
                        needsAttention: attentionRequest,
                    },
                },
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: confirmedVerifierOutput },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        const reviewFixPrompts = harness.prompts.filter(({ title }) =>
            title.startsWith("Address review for issue #42"),
        );
        expect(reviewFixPrompts).toHaveLength(1);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("confirms a commit-message signal before commit and push but never decomposes", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Review issue #42",
                    result: { structured: approvedReview },
                },
                {
                    titlePrefix: "Generate commit message for issue #42",
                    result: {
                        structured: commitMessage,
                        needsAttention: attentionRequest,
                    },
                },
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: confirmedVerifierOutput },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
        expect(harness.trace).toContain("ops:stageAll");
    });

    test("review exhaustion returns Escalated after the full iteration budget", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Review issue #42",
                    result: (served) => ({
                        structured: changesRequestedReview(`Finding ${served}`),
                    }),
                },
                {
                    titlePrefix: "Address review for issue #42",
                    result: {},
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Escalated);
        if (outcome.kind === IssueExecutionOutcomeKind.Escalated) {
            expect(outcome.diagnosticsPath).toBe("/diag/review-exhaustion");
        }
        const reviewPrompts = harness.prompts.filter(({ title }) =>
            title.startsWith("Review issue #42"),
        );
        expect(reviewPrompts).toHaveLength(REVIEW_ITERATION_LIMIT);
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("fails closed when an implementation signal arrives without a router", async () => {
        const harness = await makeImplementationHarness({
            withRouter: false,
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: {
                        structured: implementationChanged,
                        needsAttention: attentionRequest,
                    },
                },
            ],
        });
        await expect(
            harness.executor.execute({
                context: harness.context,
                artifacts: harness.store,
            }),
        ).rejects.toThrow("verifier/router service");
    });
});

describe("decomposition executor needs-attention routing", () => {
    test("routes a decomposition signal before any GitHub mutation", async () => {
        const harness = await makeDecompositionHarness({
            scripts: [
                {
                    titlePrefix: "Decompose issue #42",
                    result: {
                        structured: {
                            rationale: "Split the work.",
                            issues: [
                                {
                                    key: "a",
                                    title: "Child A",
                                    body: "Work for A.",
                                    estimatedComplexity: ComplexityLevel.Level2,
                                    dependsOn: [],
                                },
                                {
                                    key: "b",
                                    title: "Child B",
                                    body: "Work for B.",
                                    estimatedComplexity: ComplexityLevel.Level2,
                                    dependsOn: ["a"],
                                },
                            ],
                        },
                        needsAttention: attentionRequest,
                    },
                },
                {
                    titlePrefix: VERIFIER_TITLE,
                    result: { structured: confirmedVerifierOutput },
                },
            ],
        });
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            diagnosticsPath: "/diag/needs-attention",
        });
        expect(harness.githubCalls).toEqual([]);
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.recoveryInputs[0]?.checkpoint).toEqual(CHECKPOINT);
    });

    test("fails closed when a decomposition signal arrives without a router", async () => {
        const harness = await makeDecompositionHarness({
            withRouter: false,
            scripts: [
                {
                    titlePrefix: "Decompose issue #42",
                    result: {
                        structured: {
                            rationale: "Split the work.",
                            issues: [
                                {
                                    key: "a",
                                    title: "Child A",
                                    body: "Work for A.",
                                    estimatedComplexity: ComplexityLevel.Level2,
                                    dependsOn: [],
                                },
                                {
                                    key: "b",
                                    title: "Child B",
                                    body: "Work for B.",
                                    estimatedComplexity: ComplexityLevel.Level2,
                                    dependsOn: ["a"],
                                },
                            ],
                        },
                        needsAttention: attentionRequest,
                    },
                },
            ],
        });
        await expect(
            harness.executor.execute({
                context: harness.context,
                artifacts: harness.store,
            }),
        ).rejects.toThrow("verifier/router service");
        expect(harness.githubCalls).toEqual([]);
    });
});

describe("needs-attention artifacts", () => {
    test("beginNeedsAttentionHandoff discards a prior decision and records the request", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.recordNeedsAttentionDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        await store.beginNeedsAttentionHandoff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);
        const handoff = await store.read(
            IssueArtifactKind.NeedsAttentionHandoff,
        );
        expect(handoff.request).toEqual(attentionRequest);
        expect(handoff.checkpoint).toEqual(CHECKPOINT);
        expect(handoff.fingerprint).toEqual(currentFingerprint);
    });

    test("clearNeedsAttentionHandoff keeps the confirmed decision", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.beginNeedsAttentionHandoff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordNeedsAttentionDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        await store.clearNeedsAttentionHandoff();
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
    });

    test("invalidateStaleNeedsAttentionDecision drops mismatched state and keeps matching state", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.beginNeedsAttentionHandoff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordNeedsAttentionDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        expect(
            await store.invalidateStaleNeedsAttentionDecision(
                currentFingerprint,
            ),
        ).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(true);
        expect(
            await store.invalidateStaleNeedsAttentionDecision(
                changedFingerprint,
            ),
        ).toBe(true);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(false);
    });

    test("invalidateStaleIssueDecisions clears stale decisions across kinds", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.write(IssueArtifactKind.ComplexityDecision, {
            decision: {
                complexity: ComplexityLevel.Level2,
                rationale: "Directly actionable.",
            },
            fingerprint: changedFingerprint,
        });
        await store.write(IssueArtifactKind.NeedsAttentionDecision, {
            decision: attentionDecision,
            fingerprint: changedFingerprint,
        });
        expect(
            await store.invalidateStaleIssueDecisions(currentFingerprint),
        ).toBe(true);
        expect(store.has(IssueArtifactKind.ComplexityDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(false);
    });
});

describe("needs-attention recovery diagnostics", () => {
    test("reuses a matching diagnostic and restores without creating a new patch", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const trace: string[] = [];
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const git: GitIssueCheckpointService = {
                capture: async () => CHECKPOINT,
                createPatch: async () => {
                    trace.push("createPatch");
                    return "--- a/x\n+++ b/x\n";
                },
                restore: async () => {
                    trace.push("restore");
                },
            };
            const verifyCalls: Array<{ branch: string; head: string }> = [];
            const invariant = makeInvariant(verifyCalls);
            const recovery = makeIssueRecoveryService(git, progress, invariant);
            const input: NeedsAttentionRecoveryInput = {
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: "/work/repository",
                issue,
                checkpoint: CHECKPOINT,
                fingerprint: currentFingerprint,
                decision: attentionDecision,
                request: attentionRequest,
            };
            const first = await recovery.handleNeedsAttention(input);
            const second = await recovery.handleNeedsAttention(input);
            expect(second.diagnosticsPath).toBe(first.diagnosticsPath);
            expect(second.diagnosticsPath).toMatch(/needs-attention-/);
            expect(
                trace.filter((entry) => entry === "createPatch"),
            ).toHaveLength(1);
            expect(trace.filter((entry) => entry === "restore")).toHaveLength(
                2,
            );
            expect(verifyCalls).toEqual([INVARIANT, INVARIANT]);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("keys diagnostics by fingerprint so a stale decision cannot reuse them", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const trace: string[] = [];
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const git: GitIssueCheckpointService = {
                capture: async () => CHECKPOINT,
                createPatch: async () => {
                    trace.push("createPatch");
                    return "--- a/x\n+++ b/x\n";
                },
                restore: async () => {
                    trace.push("restore");
                },
            };
            const recovery = makeIssueRecoveryService(
                git,
                progress,
                makeInvariant([]),
            );
            const base = {
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: "/work/repository",
                issue,
                checkpoint: CHECKPOINT,
                decision: attentionDecision,
                request: attentionRequest,
            };
            const current = await recovery.handleNeedsAttention({
                ...base,
                fingerprint: currentFingerprint,
            });
            const changed = await recovery.handleNeedsAttention({
                ...base,
                fingerprint: changedFingerprint,
            });
            expect(changed.diagnosticsPath).not.toBe(current.diagnosticsPath);
            expect(
                trace.filter((entry) => entry === "createPatch"),
            ).toHaveLength(2);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("reports diagnostic capture failure as recoverable and never restores", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const trace: string[] = [];
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const git: GitIssueCheckpointService = {
                capture: async () => CHECKPOINT,
                createPatch: async () => {
                    trace.push("createPatch");
                    throw new Error("git diff failed");
                },
                restore: async () => {
                    trace.push("restore");
                },
            };
            const recovery = makeIssueRecoveryService(
                git,
                progress,
                makeInvariant([]),
            );
            const input: NeedsAttentionRecoveryInput = {
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: "/work/repository",
                issue,
                checkpoint: CHECKPOINT,
                fingerprint: currentFingerprint,
                decision: attentionDecision,
                request: attentionRequest,
            };
            await expect(
                recovery.handleNeedsAttention(input),
            ).rejects.toMatchObject({
                _tag: "RalphieError",
                message: expect.stringContaining(
                    "Failed to capture needs-attention diagnostics",
                ),
            });
            expect(trace).not.toContain("restore");
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("reports restoration failure as recoverable and emits a failed checkout-restore event", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const trace: string[] = [];
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const git: GitIssueCheckpointService = {
                capture: async () => CHECKPOINT,
                createPatch: async () => "--- a/x\n+++ b/x\n",
                restore: async () => {
                    trace.push("restore");
                    throw new Error("git clean failed");
                },
            };
            const verifyCalls: Array<{ branch: string; head: string }> = [];
            const recovery = makeIssueRecoveryService(
                git,
                progress,
                makeInvariant(verifyCalls),
            );
            const input: NeedsAttentionRecoveryInput = {
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: "/work/repository",
                issue,
                checkpoint: CHECKPOINT,
                fingerprint: currentFingerprint,
                decision: attentionDecision,
                request: attentionRequest,
            };
            await expect(
                recovery.handleNeedsAttention(input),
            ).rejects.toMatchObject({
                _tag: "RalphieError",
                message: expect.stringContaining(
                    "Failed to restore the clean checkout",
                ),
            });
            expect(trace).toContain("restore");
            expect(verifyCalls).toEqual([]);
            expect(events).toContainEqual(
                expect.objectContaining({
                    stage: "checkout-restore",
                    status: "failed",
                }),
            );
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("reports invariant verification failure as recoverable rather than successful", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const events: ProgressUpdate[] = [];
            const progress = makeProgressRecorder(events);
            const git: GitIssueCheckpointService = {
                capture: async () => CHECKPOINT,
                createPatch: async () => "--- a/x\n+++ b/x\n",
                restore: async () => {},
            };
            const invariant: GitRepositoryInvariantService = {
                capture: async () => INVARIANT,
                verify: async () => {
                    throw new RalphieError({
                        message:
                            "Repository branch changed from develop to main.",
                    });
                },
            };
            const recovery = makeIssueRecoveryService(git, progress, invariant);
            const input: NeedsAttentionRecoveryInput = {
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: "/work/repository",
                issue,
                checkpoint: CHECKPOINT,
                fingerprint: currentFingerprint,
                decision: attentionDecision,
                request: attentionRequest,
            };
            await expect(
                recovery.handleNeedsAttention(input),
            ).rejects.toMatchObject({
                _tag: "RalphieError",
                message: expect.stringContaining("branch changed"),
            });
            expect(events).toContainEqual(
                expect.objectContaining({
                    stage: "checkout-restore",
                    status: "failed",
                }),
            );
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });
});