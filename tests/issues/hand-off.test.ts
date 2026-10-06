import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { AgentSessions } from "../../src/agent/sessions.ts";
import type {
    HarnessOutcome,
    HarnessRole,
    HarnessService,
    SessionRequest,
} from "../../src/harness/ports.ts";
import { sessionsFor } from "../shared/agent-sessions.ts";
import { type GitHubIssue } from "../../src/github/domain.ts";
import { type GitIssueCheckpointService } from "../../src/git/ports.ts";
import { type IssueCheckpoint } from "../../src/git/ports.ts";
import { type GitIssuePreparationService } from "../../src/issues/ports.ts";
import { type GitIssueOperationsService } from "../../src/git/ports.ts";
import { type GitRemoteSafetyService } from "../../src/git/ports.ts";
import {
    type GitRepositoryInvariant,
    type GitRepositoryInvariantService,
} from "../../src/git/ports.ts";
import { type GitHubIssueRelationshipService } from "../../src/github/ports.ts";
import { type GitHubIssueMutationService } from "../../src/github/ports.ts";
import { type GitHubIssuesService } from "../../src/github/ports.ts";
import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import { type HandOffRequest } from "../../src/agent/task-session.ts";
import {
    IssueArtifactKind,
    makeIssueArtifactStore,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
    type IssueFreshnessFingerprint,
} from "../../src/issues/app/artifacts.ts";
import {
    makeDecompositionExecutorService,
    type DecompositionExecutorService,
} from "../../src/issues/app/decomposition-executor.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    IssueResolutionStatus,
    HandOffReason,
    groundingDecisionSchema,
    preflightDecisionSchema,
    type GroundingDecision,
} from "../../src/issues/domain/decisions.ts";
import {
    implementationResultSchema,
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "../../src/issues/app/implementation-executor.ts";
import type { PreflightAssessmentService } from "../../src/issues/app/preflight.ts";
import {
    type IssueExecutionContext,
    IssueExecutionOutcomeKind,
} from "../../src/issues/app/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/app/executor.ts";
import {
    makeHandOffRouterService,
    type HandOffRouterService,
} from "../../src/issues/app/hand-off.ts";
import { nodeRecoveryFileSystem } from "../../src/issues/adapters/recovery-file-system.ts";
import {
    makeIssueRecoveryService,
    type IssueRecoveryService,
    type HandOffRecoveryInput,
} from "../../src/issues/app/recovery.ts";
import { makeResolutionVerificationService } from "../../src/issues/app/resolution-verification.ts";
import {
    IssueQueueResumeStrategy,
    REVIEW_ITERATION_LIMIT,
} from "../../src/issues/domain/stage.ts";
import {
    type IssueVerificationService,
    VerificationCommandError,
} from "../../src/issues/app/verification.ts";
import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/progress/ports.ts";
import { makeTestProgressRecorder } from "../shared/progress-recorder.ts";
import { countingIds, fixedClock, testLayout } from "../shared/test-values.ts";
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
const VERIFIER_TITLE = "Verify hand-off request for issue #42";

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

const attentionRequest: HandOffRequest = {
    reason: "missing_information",
    message: "The request is blocked on a prerequisite.",
};

const attentionDecision = {
    disposition: GroundingDisposition.HandOff as const,
    reason: HandOffReason.MissingInformation as const,
    summary: "A prerequisite is still open.",
    evidence: ["Issue body links the open prerequisite."],
    questions: ["Complete the prerequisite, then retry."],
};

const confirmedVerifierOutput: GroundingDecision = attentionDecision;

const commitMessage = { subject: "Implement the requested behavior" };
const implementationChanged = {
    status: "done",
    summary: "Implemented the requested behavior.",
    commitMessage,
};
const implementationHandoff = {
    status: "needs_attention",
    summary: "The premise is outdated.",
    needsAttention: {
        reason: "outdated_premise",
        questions: ["Is the old API still wanted?"],
    },
};
const approvedReview = {
    summary: "The candidate commits address the issue.",
    findings: [],
};
const changesRequestedReview = (description: string) => ({
    summary: `Findings remain: ${description}`,
    findings: [
        {
            kind: "violation",
            standard: "AGENTS.md: keep functions small",
            description,
        },
    ],
});
const approvedSpecReview = {
    summary: "The brief is satisfied.",
    findings: [],
};

/** Scripts for the two parallel review sessions of one review round. */
const reviewScripts = (
    standards: FakeScript["result"],
    spec: FakeScript["result"] = { structured: approvedSpecReview },
): FakeScript[] => [
    { titlePrefix: "Review standards for issue #42", result: standards },
    { titlePrefix: "Review spec for issue #42", result: spec },
];

type FakeStructuredResponse = {
    readonly structured?: unknown;
    readonly handOff?: unknown;
    readonly error?: boolean;
};

type FakeScript = {
    readonly titlePrefix: string;
    readonly count?: number;
    readonly result:
        | FakeStructuredResponse
        | ((served: number, request: SessionRequest) => FakeStructuredResponse);
};

type RecordedCreate = {
    readonly sessionID: string;
    readonly title?: string;
    readonly role: HarnessRole;
};

type RecordedPrompt = {
    readonly sessionID: string;
    readonly title: string;
};

/**
 * Deterministic harness. Each structured call is one session, so responses are
 * matched by the session title. A script is served up to `count` times in
 * order; the first matching script with remaining budget wins. Scripted
 * values go through the request's result schema like the real service does.
 */
const fakePi = (
    scripts: ReadonlyArray<FakeScript>,
    beforeRun?: (request: SessionRequest) => Promise<void>,
) => {
    const creates: RecordedCreate[] = [];
    const prompts: RecordedPrompt[] = [];
    const fullPrompts: Array<{ title: string; prompt: string }> = [];
    const served = new Map<string, number>();
    const requests: SessionRequest[] = [];
    const nextResponse = (
        title: string,
        request: SessionRequest,
    ): FakeStructuredResponse => {
        const index = scripts.findIndex((script) => {
            const remaining =
                (script.count ?? Number.POSITIVE_INFINITY) -
                (served.get(script.titlePrefix) ?? 0);
            return title.startsWith(script.titlePrefix) && remaining > 0;
        });
        const script = scripts[index];
        if (script === undefined) {
            throw new Error(`Fake agent has no response for ${title}`);
        }
        const servedCount = (served.get(script.titlePrefix) ?? 0) + 1;
        served.set(script.titlePrefix, servedCount);
        return typeof script.result === "function"
            ? script.result(servedCount, request)
            : script.result;
    };
    const run = async (
        request: SessionRequest & { readonly resultSchema?: z.ZodType },
    ): Promise<HarnessOutcome<unknown>> => {
        await beforeRun?.(request);
        await beforeRun?.(request);
        const title = request.title ?? "";
        const sessionID = `session-${creates.length + 1}`;
        creates.push({ sessionID, title, role: request.role });
        requests.push(request);
        const response = nextResponse(title, request);
        prompts.push({ sessionID, title });
        fullPrompts.push({ title, prompt: request.prompt });
        if (response.error === true) {
            return {
                ok: false,
                failure: {
                    kind: "harness",
                    message: `fake prompt failure for ${title}`,
                },
            };
        }
        const parsed = request.resultSchema?.safeParse({
            result: response.structured,
            ...(response.handOff === undefined
                ? {}
                : { handOff: response.handOff }),
        });
        if (parsed !== undefined && !parsed.success) {
            return {
                ok: false,
                failure: {
                    kind: "invalid_result",
                    message: z.prettifyError(parsed.error),
                },
            };
        }
        return {
            ok: true,
            harnessSessionID: sessionID,
            text: "",
            value: parsed?.data,
        };
    };
    const client: AgentSessions = sessionsFor({
        run: run as HarnessService["run"],
    });
    return { client, creates, prompts, fullPrompts, requests };
};

const verifierPromptsOf = (prompts: ReadonlyArray<RecordedPrompt>) =>
    prompts.filter(({ title }) => title.startsWith(VERIFIER_TITLE));

const makeContext = (options: {
    readonly agent: AgentSessions;
    readonly invariant: GitRepositoryInvariantService;
    readonly issueOverride?: GitHubIssue;
}): IssueExecutionContext => ({
    issue: options.issueOverride ?? issue,
    repository: "owner/repo",
    repositoryPath: "/work/repository",
    targetBranch: "develop",
    workspace: "/work/workspace",
    runId: "test-run",
    runLayout: testLayout("/work/workspace", "test-run"),
    agent: options.agent,
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
        readonly failHandOff?: boolean | (() => boolean);
        readonly trace?: string[];
    } = {},
): {
    readonly service: IssueRecoveryService;
    readonly recoveryInputs: HandOffRecoveryInput[];
} => {
    const recoveryInputs: HandOffRecoveryInput[] = [];
    return {
        service: {
            handleReviewExhaustion: async () => ({
                outcome: "escalated-to-decomposition",
                diagnosticsPath: "/diag/review-exhaustion",
                nextWorkflow: "decomposition",
                resume: IssueQueueResumeStrategy,
            }),
            handleHandOff: async (input) => {
                recoveryInputs.push(input);
                options.trace?.push("recovery:hand-off");
                const failing =
                    typeof options.failHandOff === "function"
                        ? options.failHandOff()
                        : options.failHandOff === true;
                if (failing) {
                    throw new RalphieError({
                        message: "hand-off recovery failed",
                    });
                }
                return { diagnosticsPath: "/diag/hand-off" };
            },
        },
        recoveryInputs,
    };
};

const makeRealRouter = (
    _progress: ProgressReporterService,
): {
    readonly router: HandOffRouterService;
    readonly recovery: IssueRecoveryService;
    readonly recoveryInputs: HandOffRecoveryInput[];
} => {
    const { service, recoveryInputs } = makeFakeRecovery();
    return {
        router: makeHandOffRouterService(service),
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
        write: async (kind, value, signal) => {
            throwIfFailing("write");
            await store.write(kind, value, signal);
        },
        read: store.read,
        has: store.has,
        recordResolutionDecision: async (value, signal) => {
            throwIfFailing("recordResolutionDecision");
            await store.recordResolutionDecision(value, signal);
        },
        beginPendingHandOff: async (value, signal) => {
            throwIfFailing("beginPendingHandOff");
            await store.beginPendingHandOff(value, signal);
        },
        recordHandOffDecision: async (value, signal) => {
            throwIfFailing("recordHandOffDecision");
            await store.recordHandOffDecision(value, signal);
        },
        appendReview: async (review, signal) => {
            throwIfFailing("appendReview");
            await store.appendReview(review, signal);
        },
        recordCreatedIssue: async (key, createdIssueNumber, signal) => {
            throwIfFailing("recordCreatedIssue");
            await store.recordCreatedIssue(key, createdIssueNumber, signal);
        },
        resetImplementationAttempt: async (signal) => {
            throwIfFailing("resetImplementationAttempt");
            await store.resetImplementationAttempt(signal);
        },
        clearUnresolvedResolutionDecision: async (signal) => {
            throwIfFailing("clearUnresolvedResolutionDecision");
            return store.clearUnresolvedResolutionDecision(signal);
        },
        invalidateStaleIssueDecisions: async (fingerprint, signal) => {
            throwIfFailing("invalidateStaleIssueDecisions");
            return store.invalidateStaleIssueDecisions(fingerprint, signal);
        },
        invalidateStaleHandOffDecision: async (fingerprint, signal) => {
            throwIfFailing("invalidateStaleHandOffDecision");
            return store.invalidateStaleHandOffDecision(fingerprint, signal);
        },
        invalidateHandOffDecision: async (fingerprint, signal) => {
            throwIfFailing("invalidateHandOffDecision");
            return store.invalidateHandOffDecision(fingerprint, signal);
        },
        clearPendingHandOff: async (signal) => {
            throwIfFailing("clearPendingHandOff");
            await store.clearPendingHandOff(signal);
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
    readonly grounding?: PreflightAssessmentService;
    readonly implementation?: ImplementationExecutorService;
    readonly decomposition?: DecompositionExecutorService;
    readonly withRouter?: boolean;
    readonly failPersist?: (method: string) => boolean;
};

const makeExecutorHarness = async (options: ExecutorHarnessOptions = {}) => {
    const trace = options.trace ?? [];
    const events: ProgressUpdate[] = [];
    const progress = makeTestProgressRecorder(events);
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
    const grounding: PreflightAssessmentService = options.grounding ?? {
        assess: async (context) => {
            trace.push(`preflight:${context.issue.number}`);
            return {
                decision: {
                    disposition: GroundingDisposition.Actionable,
                    fitsOneSession: true,
                },
                sessionID: "preflight-1",
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
            : makeHandOffRouterService(recovery);
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
    };
};

type ImplementationHarnessOptions = {
    readonly scripts?: ReadonlyArray<FakeScript>;
    readonly withRouter?: boolean;
    readonly recoveryFailure?: boolean;
    readonly budgets?: Pick<
        IssueExecutionContext,
        "reviewRounds" | "verificationFixes"
    >;
    readonly verification?: IssueVerificationService;
    readonly recovery?: IssueRecoveryService;
    readonly beforeRun?: (request: SessionRequest) => Promise<void>;
};

const makeImplementationHarness = async (
    options: ImplementationHarnessOptions = {},
) => {
    const events: ProgressUpdate[] = [];
    const progress = makeTestProgressRecorder(events);
    const { client, creates, prompts, fullPrompts, requests } = fakePi(
        options.scripts ?? [],
        options.beforeRun,
    );
    const store = await makeTrackedStore();
    const recoveryTrace: string[] = [];
    const fakeRecovery = makeFakeRecovery({
        failHandOff: options.recoveryFailure,
        trace: recoveryTrace,
    });
    const recovery = options.recovery ?? fakeRecovery.service;
    const { recoveryInputs } = fakeRecovery;
    const router =
        options.withRouter === false
            ? undefined
            : makeHandOffRouterService(recovery);
    const verifyCalls: Array<{ branch: string; head: string }> = [];
    const context = {
        ...makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        }),
        ...options.budgets,
    };
    const trace: string[] = [];
    const commitMessages: unknown[] = [];
    const candidateSubjects: string[] = [];
    const rangeDiffs: Array<{ base: string; head: string }> = [];
    const pushedShas: string[] = [];
    const operations: GitIssueOperationsService = {
        stageAll: async () => {
            trace.push("ops:stageAll");
        },
        readStagedBinaryDiff: async () => {
            trace.push("ops:readDiff");
            return "";
        },
        hasStagedChanges: async () => {
            trace.push("ops:hasStaged");
            return true;
        },
        commit: async (_path, message) => {
            commitMessages.push(message);
            trace.push("ops:commit");
            return { sha: "c".repeat(40), treeSha: "t".repeat(40) };
        },
        commitCandidate: async (_path, message) => {
            trace.push("ops:commitCandidate");
            candidateSubjects.push(message.subject);
            return { sha: "d".repeat(40), treeSha: "t".repeat(40) };
        },
        readRangeDiff: async (_path, base, head) => {
            trace.push("ops:readRangeDiff");
            rangeDiffs.push({ base, head });
            return "diff --git a/x b/x";
        },
        squashCandidates: async () => {
            trace.push("ops:squash");
        },
        push: async (_path, _branch, sha) => {
            trace.push("ops:push");
            pushedShas.push(sha);
        },
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
    };
    const verification: IssueVerificationService = options.verification ?? {
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
        commitMessages,
        candidateSubjects,
        rangeDiffs,
        pushedShas,
        fullPrompts,
        requests,
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
    const progress = makeTestProgressRecorder(events);
    const { client, creates, prompts } = fakePi(options.scripts ?? []);
    const store = await makeTrackedStore();
    const { service: recovery, recoveryInputs } = makeFakeRecovery();
    const router =
        options.withRouter === false
            ? undefined
            : makeHandOffRouterService(recovery);
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

describe("structured-output hand-off side channel", () => {
    test("surfaces a valid side-channel request from a grounding call", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Check readiness of issue #42",
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                    },
                    handOff: attentionRequest,
                },
            },
        ]);
        const result = await requestStructuredOutput(client, {
            role: "preflight",
            directory: "/work/repository",
            title: "Check readiness of issue #42",
            prompt: "ground the fixture issue",
            schema: groundingDecisionSchema,
        });
        expect(result.output).toEqual({
            disposition: GroundingDisposition.Actionable,
        });
        expect(result.handOff).toEqual(attentionRequest);
    });

    test("parses the side channel like every structured call, including the pre-flight schema", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Pre-flight issue #42",
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                        fitsOneSession: false,
                    },
                    handOff: attentionRequest,
                },
            },
        ]);
        const result = await requestStructuredOutput(client, {
            role: "preflight",
            directory: "/work/repository",
            title: "Pre-flight issue #42",
            prompt: "pre-flight the fixture issue",
            schema: preflightDecisionSchema,
        });
        expect(result.output).toEqual({
            disposition: GroundingDisposition.Actionable,
            fitsOneSession: false,
        });
        expect(result.handOff).toEqual(attentionRequest);
    });

    test("rejects an invalid side-channel value", async () => {
        const { client } = fakePi([
            {
                titlePrefix: "Check readiness of issue #42",
                result: {
                    structured: {
                        disposition: GroundingDisposition.Actionable,
                    },
                    handOff: { reason: "not-a-reason" },
                },
            },
        ]);
        await expect(
            requestStructuredOutput(client, {
                role: "preflight",
                directory: "/work/repository",
                title: "Check readiness of issue #42",
                prompt: "ground the fixture issue",
                schema: groundingDecisionSchema,
            }),
        ).rejects.toBeInstanceOf(RalphieError);
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
                role: "preflight",
                directory: "/work/repository",
                title: "Check readiness of issue #42",
                prompt: "ground the fixture issue",
                schema: groundingDecisionSchema,
            }),
        ).rejects.toBeInstanceOf(RalphieError);
    });
});

describe("hand-off router", () => {
    test("returns undefined without a handoff or request and starts no verifier session", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
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
            const progress = makeTestProgressRecorder(events);
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
            expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
            expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);
            expect(recoveryInputs).toHaveLength(0);
            expect(verifierPromptsOf(prompts)).toHaveLength(1);
        },
    );

    test("confirms with one fresh read-only verifier session and invokes recovery once", async () => {
        const { client, prompts, creates } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeHandOffRouterService(recovery);
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
            reason: HandOffReason.MissingInformation,
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
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(true);
    });

    test("resumes a pending handoff with a fresh verifier session", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        await store.beginPendingHandOff({
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("reuses a persisted decision without a fresh verifier session when recovery retries", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
        const { client, prompts } = fakePi([]);
        const store = await makeTrackedStore();
        await store.beginPendingHandOff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordHandOffDecision({
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(0);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("invalidates a stale persisted decision before verification", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        await store.recordHandOffDecision({
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("propagates verifier failures and keeps the handoff pending", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
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
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);
    });
});

describe("issue executor hand-off routing", () => {
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
        expect(harness.trace).toContain("preflight:42");
        expect(harness.trace).toContain("implementation:42");
        expect(harness.recoveryInputs).toHaveLength(0);
    });

    test("confirms a grounding signal with one fresh read-only verifier session and recovers once", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({
            trace,
            grounding: {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    handOff: attentionRequest,
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
            reason: HandOffReason.MissingInformation,
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

    test("does not treat a grounding hand_off result as confirmation when its side-channel request is rejected", async () => {
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
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
        const router = makeHandOffRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
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
                    handOff: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const outcome = await executor.execute(context);
        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            reason: HandOffReason.MissingInformation,
            artifactPath: context.runLayout.issueArtifactsPath(
                context.issue.number,
            ),
        });
        expect(outcome).not.toHaveProperty("diagnosticsPath");
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(0);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(true);
        expect(verifyCalls).toEqual([INVARIANT]);
    });

    test("routes fitsOneSession false to decomposition without implementing", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({
            trace,
            grounding: {
                assess: async () => ({
                    decision: {
                        disposition: GroundingDisposition.Actionable,
                        fitsOneSession: false,
                    },
                    sessionID: "preflight-1",
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Decomposed);
        expect(trace).toContain("decomposition:42");
        expect(trace).not.toContain("implementation:42");
    });

    test("skips an issue blocked by an open issue without implementing", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({
            trace,
            grounding: {
                assess: async () => ({
                    decision: {
                        disposition: GroundingDisposition.Blocked,
                        blockedBy: [7, 9],
                    },
                    sessionID: "preflight-1",
                }),
            },
        });
        const outcome = await harness.executor.execute(harness.context);
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Skipped,
            reason: "Blocked by open issues #7, #9.",
        });
        expect(trace).toEqual([]);
        expect(harness.store.has(IssueArtifactKind.PreflightDecision)).toBe(
            false,
        );
    });

    test("reuses a cached pre-flight decision on restart", async () => {
        const trace: string[] = [];
        const harness = await makeExecutorHarness({ trace });
        const first = await harness.executor.execute(harness.context);
        const second = await harness.executor.execute(harness.context);
        expect(first.kind).toBe(IssueExecutionOutcomeKind.Completed);
        expect(second.kind).toBe(IssueExecutionOutcomeKind.Completed);
        expect(trace.filter((entry) => entry === "preflight:42")).toHaveLength(
            1,
        );
        expect(
            trace.filter((entry) => entry === "implementation:42"),
        ).toHaveLength(2);
    });

    test("resumes a pending handoff after a verifier failure without trusting the signal", async () => {
        let failVerifier = true;
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
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
        const router = makeHandOffRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
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
                    handOff: attentionRequest,
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
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);

        failVerifier = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(2);
        expect(recoveryInputs).toHaveLength(1);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
    });

    test("halts on decision persistence failure and resumes with a fresh verifier", async () => {
        let failPersistence = true;
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore(
            (method) => failPersistence && method === "recordHandOffDecision",
        );
        const { service: recovery, recoveryInputs } = makeFakeRecovery();
        const router = makeHandOffRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
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
                    handOff: attentionRequest,
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
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);

        failPersistence = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(2);
        expect(recoveryInputs).toHaveLength(1);
    });

    test("recovery failure after decision persistence reuses the confirmed decision on restart", async () => {
        let failRecovery = true;
        const events: ProgressUpdate[] = [];
        const progress = makeTestProgressRecorder(events);
        const { client, prompts } = fakePi([
            {
                titlePrefix: VERIFIER_TITLE,
                result: { structured: confirmedVerifierOutput },
            },
        ]);
        const store = await makeTrackedStore();
        const { service: recovery, recoveryInputs } = makeFakeRecovery({
            failHandOff: () => failRecovery,
        });
        const router = makeHandOffRouterService(recovery);
        const verifyCalls: Array<{ branch: string; head: string }> = [];
        const context = makeContext({
            agent: client,
            invariant: makeInvariant(verifyCalls),
        });
        const executor = makeIssueExecutorService(
            { forIssue: async () => store },
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
                    handOff: attentionRequest,
                }),
            },
            resolutionVerification,
            progress,
            router,
        );
        const failed = await executor.execute(context);
        expect(failed).toMatchObject({
            kind: IssueExecutionOutcomeKind.Failed,
            message: "hand-off recovery failed",
        });
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);

        failRecovery = false;
        const resumed = await executor.execute(context);
        expect(resumed).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(prompts)).toHaveLength(1);
        expect(recoveryInputs).toHaveLength(2);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
    });

    test("fails closed when a signal arrives without a router", async () => {
        const harness = await makeExecutorHarness({
            withRouter: false,
            grounding: {
                assess: async () => ({
                    decision: attentionDecision,
                    sessionID: "grounding-1",
                    handOff: attentionRequest,
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
        expect(harness.store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
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

describe("implementation executor hand-off routing", () => {
    test("completes the full implementation flow with zero verifier sessions when no signal is present", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                ...reviewScripts({ structured: approvedReview }),
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
                            handOff: attentionRequest,
                        },
                    },
                    {
                        titlePrefix: VERIFIER_TITLE,
                        result: { structured: { disposition } },
                    },
                    ...reviewScripts({ structured: approvedReview }),
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
                        handOff: attentionRequest,
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
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
                ...reviewScripts({
                    structured: approvedReview,
                    handOff: attentionRequest,
                }),
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(1);
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.prompts).toHaveLength(4);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("routes a needs_attention implementer result to a hand-off before any stage or commit", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationHandoff },
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
        });
        expect(harness.recoveryInputs).toHaveLength(1);
        expect(harness.recoveryInputs[0]?.request?.reason).toBe(
            "outdated_premise",
        );
        expect(harness.trace).not.toContain("ops:stageAll");
        expect(harness.trace).not.toContain("ops:commit");
    });

    test("commits with the implementer's message and runs no commit-message session", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                ...reviewScripts({ structured: approvedReview }),
            ],
        });
        await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(harness.commitMessages).toEqual([commitMessage]);
        expect(
            harness.prompts.some(({ title }) =>
                title.startsWith("Generate commit message"),
            ),
        ).toBe(false);
    });

    test("rejects a done result without a commit message or an over-long subject", () => {
        expect(
            implementationResultSchema.safeParse({
                status: "done",
                summary: "x",
            }).success,
        ).toBe(false);
        expect(
            implementationResultSchema.safeParse({
                status: "done",
                summary: "x",
                commitMessage: { subject: "a".repeat(73) },
            }).success,
        ).toBe(false);
    });

    test("review exhaustion returns Escalated after the full iteration budget", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                ...reviewScripts((served) => ({
                    structured: changesRequestedReview(`Finding ${served}`),
                })),
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
            title.startsWith("Review standards for issue #42"),
        );
        expect(reviewPrompts).toHaveLength(REVIEW_ITERATION_LIMIT);
        expect(verifierPromptsOf(harness.prompts)).toHaveLength(0);
        expect(harness.trace).not.toContain("ops:commit");
        expect(harness.trace).not.toContain("ops:push");
    });

    test("review exhaustion follows the configured review rounds", async () => {
        for (const reviewRounds of [2, REVIEW_ITERATION_LIMIT + 1]) {
            const workspace = mkdtempSync(join(tmpdir(), "ralphie-rounds-"));
            try {
                const recovery = makeIssueRecoveryService(
                    {
                        fileSystem: nodeRecoveryFileSystem,
                        layout: testLayout(workspace, "run-1"),
                        clock: fixedClock(),
                        ids: countingIds("recovery"),
                    },
                    {
                        capture: async () => CHECKPOINT,
                        createPatch: async () => "",
                        restore: async () => {},
                    },
                    makeTestProgressRecorder([]),
                    makeInvariant([]),
                );
                const harness = await makeImplementationHarness({
                    budgets: { reviewRounds },
                    recovery,
                    scripts: [
                        {
                            titlePrefix: "Implement issue #42",
                            result: { structured: implementationChanged },
                        },
                        ...reviewScripts((served) => ({
                            structured: changesRequestedReview(
                                `Finding ${served}`,
                            ),
                        })),
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
                expect(
                    harness.prompts.filter(({ title }) =>
                        title.startsWith("Review standards for issue #42"),
                    ),
                ).toHaveLength(reviewRounds);
            } finally {
                rmSync(workspace, { recursive: true, force: true });
            }
        }
    });

    test("verification repair follows the configured verification fixes", async () => {
        const harness = await makeImplementationHarness({
            budgets: { verificationFixes: 2 },
            verification: {
                stagedTreeSha: async () => TREE_SHA,
                verify: async () => {
                    throw new VerificationCommandError({
                        stagedTreeSha: TREE_SHA,
                        commands: [
                            {
                                command: "bun test",
                                exitCode: 1,
                                stdout: "",
                                stderr: "still red",
                            },
                        ],
                    });
                },
            },
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: { structured: implementationChanged },
                },
                {
                    titlePrefix: "Repair verification for issue #42",
                    result: {},
                },
            ],
        });

        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });

        expect(outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.HandOff,
            reason: HandOffReason.ImplementationExhausted,
            summary: expect.stringContaining(
                "Deterministic verification still failed after 2 repair attempts:",
            ),
            diagnosticsPath: "/diag/hand-off",
        });
        expect(
            harness.prompts.filter(({ title }) =>
                title.startsWith("Repair verification for issue #42"),
            ),
        ).toHaveLength(2);
    });

    test("fails closed when an implementation signal arrives without a router", async () => {
        const harness = await makeImplementationHarness({
            withRouter: false,
            scripts: [
                {
                    titlePrefix: "Implement issue #42",
                    result: {
                        structured: implementationChanged,
                        handOff: attentionRequest,
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

describe("decomposition executor hand-off routing", () => {
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
                        handOff: attentionRequest,
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
            kind: IssueExecutionOutcomeKind.HandOff,
            diagnosticsPath: "/diag/hand-off",
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
                        handOff: attentionRequest,
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

describe("hand-off artifacts", () => {
    test("beginPendingHandOff discards a prior decision and records the request", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.recordHandOffDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        await store.beginPendingHandOff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);
        const handoff = await store.read(IssueArtifactKind.PendingHandOff);
        expect(handoff.request).toEqual(attentionRequest);
        expect(handoff.checkpoint).toEqual(CHECKPOINT);
        expect(handoff.fingerprint).toEqual(currentFingerprint);
    });

    test("clearPendingHandOff keeps the confirmed decision", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.beginPendingHandOff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordHandOffDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        await store.clearPendingHandOff();
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
    });

    test("invalidateStaleHandOffDecision drops mismatched state and keeps matching state", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.beginPendingHandOff({
            request: attentionRequest,
            fingerprint: currentFingerprint,
            checkpoint: CHECKPOINT,
        });
        await store.recordHandOffDecision({
            decision: attentionDecision,
            fingerprint: currentFingerprint,
        });
        expect(
            await store.invalidateStaleHandOffDecision(currentFingerprint),
        ).toBe(false);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(true);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(true);
        expect(
            await store.invalidateStaleHandOffDecision(changedFingerprint),
        ).toBe(true);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.PendingHandOff)).toBe(false);
    });

    test("invalidateStaleIssueDecisions clears stale decisions across kinds", async () => {
        const store = await makeIssueArtifactStore(issue.number);
        await store.write(IssueArtifactKind.PreflightDecision, {
            decision: { fitsOneSession: true },
            fingerprint: changedFingerprint,
        });
        await store.write(IssueArtifactKind.HandOffDecision, {
            decision: attentionDecision,
            fingerprint: changedFingerprint,
        });
        expect(
            await store.invalidateStaleIssueDecisions(currentFingerprint),
        ).toBe(true);
        expect(store.has(IssueArtifactKind.PreflightDecision)).toBe(false);
        expect(store.has(IssueArtifactKind.HandOffDecision)).toBe(false);
    });
});

describe("hand-off recovery diagnostics", () => {
    test("reuses a matching diagnostic and restores without creating a new patch", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "ralphie-recovery-"));
        try {
            const trace: string[] = [];
            const events: ProgressUpdate[] = [];
            const progress = makeTestProgressRecorder(events);
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
            const recovery = makeIssueRecoveryService(
                {
                    fileSystem: nodeRecoveryFileSystem,
                    layout: testLayout(workspace, "run-1"),
                    clock: fixedClock(),
                    ids: countingIds("recovery"),
                },
                git,
                progress,
                invariant,
            );
            const input: HandOffRecoveryInput = {
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
            const first = await recovery.handleHandOff(input);
            const second = await recovery.handleHandOff(input);
            expect(second.diagnosticsPath).toBe(first.diagnosticsPath);
            expect(second.diagnosticsPath).toMatch(/hand-off-/);
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
            const progress = makeTestProgressRecorder(events);
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
                {
                    fileSystem: nodeRecoveryFileSystem,
                    layout: testLayout(workspace, "run-1"),
                    clock: fixedClock(),
                    ids: countingIds("recovery"),
                },
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
            const current = await recovery.handleHandOff({
                ...base,
                fingerprint: currentFingerprint,
            });
            const changed = await recovery.handleHandOff({
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
            const progress = makeTestProgressRecorder(events);
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
                {
                    fileSystem: nodeRecoveryFileSystem,
                    layout: testLayout(workspace, "run-1"),
                    clock: fixedClock(),
                    ids: countingIds("recovery"),
                },
                git,
                progress,
                makeInvariant([]),
            );
            const input: HandOffRecoveryInput = {
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
            await expect(recovery.handleHandOff(input)).rejects.toMatchObject({
                name: "RalphieError",
                message: expect.stringContaining(
                    "Failed to capture hand-off diagnostics",
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
            const progress = makeTestProgressRecorder(events);
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
                {
                    fileSystem: nodeRecoveryFileSystem,
                    layout: testLayout(workspace, "run-1"),
                    clock: fixedClock(),
                    ids: countingIds("recovery"),
                },
                git,
                progress,
                makeInvariant(verifyCalls),
            );
            const input: HandOffRecoveryInput = {
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
            await expect(recovery.handleHandOff(input)).rejects.toMatchObject({
                name: "RalphieError",
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
            const progress = makeTestProgressRecorder(events);
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
            const recovery = makeIssueRecoveryService(
                {
                    fileSystem: nodeRecoveryFileSystem,
                    layout: testLayout(workspace, "run-1"),
                    clock: fixedClock(),
                    ids: countingIds("recovery"),
                },
                git,
                progress,
                invariant,
            );
            const input: HandOffRecoveryInput = {
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
            await expect(recovery.handleHandOff(input)).rejects.toMatchObject({
                name: "RalphieError",
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
describe("two-axis review gate", () => {
    const run = async (
        harness: Awaited<ReturnType<typeof makeImplementationHarness>>,
    ) =>
        await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
    const implement = {
        titlePrefix: "Implement issue #42",
        result: { structured: implementationChanged },
    };
    const smell = {
        kind: "smell",
        standard: "Feature Envy",
        description: "A helper reaches into another module's data.",
    };
    const specFinding = (kind: string) => ({
        kind,
        requirement: "The command prints a summary.",
        description: `Spec finding: ${kind}`,
    });

    test("runs both reviewers in parallel against the candidate commit", async () => {
        const started = new Set<string>();
        let release: () => void = () => {};
        const bothStarted = new Promise<void>((resolve) => {
            release = resolve;
        });
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts({ structured: approvedReview }),
            ],
            beforeRun: async (request) => {
                if (
                    request.role !== "standards-reviewer" &&
                    request.role !== "spec-reviewer"
                ) {
                    return;
                }
                started.add(request.role);
                if (started.size === 2) release();
                await bothStarted;
            },
        });
        const outcome = await run(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        expect([...started].sort()).toEqual([
            "spec-reviewer",
            "standards-reviewer",
        ]);
        expect(harness.rangeDiffs).toEqual([
            { base: CHECKPOINT.sha, head: "d".repeat(40) },
        ]);
    });

    test("reviewers get the range, diff and their axis sources in the prompt", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts({ structured: approvedReview }),
            ],
        });
        await run(harness);
        const standards = harness.fullPrompts.find((p: { title: string }) =>
            p.title.startsWith("Review standards"),
        );
        const spec = harness.fullPrompts.find((p: { title: string }) =>
            p.title.startsWith("Review spec"),
        );
        expect(standards?.prompt).toContain(`Fixed point: ${CHECKPOINT.sha}`);
        expect(standards?.prompt).toContain("AGENTS.md");
        expect(standards?.prompt).toContain("<candidate-diff>");
        expect(spec?.prompt).toContain("The issue body is the contract.");
        expect(spec?.prompt).toContain(`Fixed point: ${CHECKPOINT.sha}`);
    });

    test("smells never block", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts({
                    structured: {
                        summary: "Smelly but standard.",
                        findings: [smell],
                    },
                }),
            ],
        });
        const outcome = await run(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        expect(harness.candidateSubjects).toHaveLength(1);
    });

    test("a documented-standard violation blocks until fixed", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts((served) => ({
                    structured:
                        served === 1
                            ? changesRequestedReview("Too long")
                            : approvedReview,
                })),
                { titlePrefix: "Address review for issue #42", result: {} },
            ],
        });
        const outcome = await run(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        expect(harness.candidateSubjects).toEqual([
            commitMessage.subject,
            "Address review findings (round 2)",
        ]);
    });

    test.each(["missing", "partial", "wrong", "scope_creep"])(
        "a %s spec finding blocks",
        async (kind) => {
            const harness = await makeImplementationHarness({
                budgets: { reviewRounds: 1 },
                scripts: [
                    implement,
                    ...reviewScripts(
                        { structured: approvedReview },
                        {
                            structured: {
                                summary: "Gap.",
                                findings: [specFinding(kind)],
                            },
                        },
                    ),
                ],
            });
            const outcome = await run(harness);
            expect(outcome.kind).toBe(IssueExecutionOutcomeKind.Escalated);
            expect(harness.trace).not.toContain("ops:commit");
            expect(harness.trace).not.toContain("ops:push");
        },
    );

    test("delivers exactly one created commit and never pushes a candidate", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts((served) => ({
                    structured:
                        served < 3
                            ? changesRequestedReview(`Finding ${served}`)
                            : approvedReview,
                })),
                { titlePrefix: "Address review for issue #42", result: {} },
            ],
        });
        const outcome = await run(harness);
        expect(outcome).toMatchObject({
            completion: "pushed-commit",
            commitSha: "c".repeat(40),
        });
        const candidates = harness.trace.filter(
            (entry) => entry === "ops:commitCandidate",
        );
        expect(candidates).toHaveLength(3);
        expect(harness.trace.filter((e) => e === "ops:commit")).toHaveLength(1);
        expect(harness.trace.filter((e) => e === "ops:push")).toHaveLength(1);
        expect(harness.pushedShas).toEqual(["c".repeat(40)]);
        const squash = harness.trace.indexOf("ops:squash");
        expect(squash).toBeGreaterThan(
            harness.trace.lastIndexOf("ops:commitCandidate"),
        );
        expect(harness.trace.indexOf("ops:commit")).toBeGreaterThan(squash);
        expect(harness.commitMessages).toEqual([commitMessage]);
    });

    test("re-reviews when the final reverification repair changes the approved tree", async () => {
        let verifications = 0;
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts({ structured: approvedReview }),
                {
                    titlePrefix: "Repair verification for issue #42",
                    result: {},
                },
            ],
            verification: {
                stagedTreeSha: async () => TREE_SHA,
                verify: async () => {
                    verifications += 1;
                    if (verifications === 2) {
                        throw new VerificationCommandError({
                            stagedTreeSha: TREE_SHA,
                            commands: [
                                {
                                    command: "test",
                                    exitCode: 1,
                                    stdout: "",
                                    stderr: "boom",
                                },
                            ],
                        });
                    }
                    return {
                        stagedTreeSha:
                            verifications < 2 ? TREE_SHA : "9".repeat(40),
                        commands: [
                            {
                                command: "test",
                                exitCode: 0,
                                stdout: "",
                                stderr: "",
                            },
                        ],
                    };
                },
            },
        });
        const outcome = await run(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        expect(
            harness.prompts.filter(({ title }) =>
                title.startsWith("Review standards for issue #42"),
            ),
        ).toHaveLength(2);
        expect(
            harness.trace.filter((entry) => entry === "ops:commitCandidate"),
        ).toHaveLength(2);
    });
});
describe("fixes resume the implementer session", () => {
    const implement: FakeScript = {
        titlePrefix: "Implement issue #42",
        result: { structured: implementationChanged },
    };
    const redOnce = (): IssueVerificationService => {
        let calls = 0;
        return {
            stagedTreeSha: async () => TREE_SHA,
            verify: async () => {
                calls += 1;
                if (calls === 1) {
                    throw new VerificationCommandError({
                        stagedTreeSha: TREE_SHA,
                        commands: [
                            {
                                command: "bun test",
                                exitCode: 1,
                                stdout: "",
                                stderr: "boom in parser",
                            },
                        ],
                    });
                }
                return {
                    stagedTreeSha: TREE_SHA,
                    commands: [
                        {
                            command: "test",
                            exitCode: 0,
                            stdout: "",
                            stderr: "",
                        },
                    ],
                };
            },
        };
    };
    const execute = (harness: {
        readonly executor: ImplementationExecutorService;
        readonly context: IssueExecutionContext;
        readonly store: IssueArtifactStore;
    }) =>
        harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
    const fixRequests = (
        requests: ReadonlyArray<SessionRequest>,
        titlePrefix: string,
    ) => requests.filter(({ title }) => title?.startsWith(titlePrefix));
    const blockThenApprove = (served: number, blocked = 1) => ({
        structured:
            served <= blocked
                ? changesRequestedReview(`Finding ${served}`)
                : approvedReview,
    });

    test("a verification failure resumes the implementer with /diagnosing-bugs", async () => {
        const harness = await makeImplementationHarness({
            verification: redOnce(),
            scripts: [
                implement,
                ...reviewScripts({ structured: approvedReview }),
                {
                    titlePrefix: "Repair verification for issue #42",
                    result: {},
                },
            ],
        });
        const outcome = await execute(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        const [repair] = fixRequests(
            harness.requests,
            "Repair verification for issue #42",
        );
        expect(repair?.role).toBe("fixer");
        expect(repair?.resumeSessionID).toBe("session-1");
        expect(repair?.prompt).toContain("/diagnosing-bugs");
        expect(repair?.prompt).toContain("boom in parser");
    });

    test("a review failure resumes the implementer with /implement and the findings", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts((served) => blockThenApprove(served)),
                { titlePrefix: "Address review for issue #42", result: {} },
            ],
        });
        const outcome = await execute(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        const [fix] = fixRequests(
            harness.requests,
            "Address review for issue #42",
        );
        expect(fix?.resumeSessionID).toBe("session-1");
        expect(fix?.prompt).toContain("/implement");
        expect(fix?.prompt).toContain("Finding 1");
    });

    test("the next fix continues the session that did the last fix", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts((served) => blockThenApprove(served, 2)),
                { titlePrefix: "Address review for issue #42", result: {} },
            ],
        });
        await execute(harness);
        const fixes = fixRequests(
            harness.requests,
            "Address review for issue #42",
        );
        expect(fixes).toHaveLength(2);
        const firstFix = harness.creates.find(({ title }) =>
            title?.startsWith("Address review for issue #42 (attempt 1)"),
        );
        expect(fixes[1]?.resumeSessionID).toBe(firstFix?.sessionID);
    });

    test("a failed resume falls back to a fresh fixer session", async () => {
        const harness = await makeImplementationHarness({
            scripts: [
                implement,
                ...reviewScripts((served) => blockThenApprove(served)),
                {
                    titlePrefix: "Address review for issue #42",
                    result: (_served, request) =>
                        request.resumeSessionID === undefined
                            ? {}
                            : { error: true },
                },
            ],
        });
        const outcome = await execute(harness);
        expect(outcome).toMatchObject({ completion: "pushed-commit" });
        const fixes = fixRequests(
            harness.requests,
            "Address review for issue #42",
        );
        expect(fixes).toHaveLength(2);
        expect(fixes[0]?.resumeSessionID).toBe("session-1");
        expect(fixes[1]?.resumeSessionID).toBeUndefined();
        expect(fixes[1]?.role).toBe("fixer");
        expect(fixes[1]?.prompt).toContain("fresh context");
        expect(fixes[1]?.prompt).toContain("Finding 1");
        expect(
            harness.events.some(
                (event) =>
                    event.status === "info" &&
                    event.message.includes("fresh fixer session"),
            ),
        ).toBe(true);
        expect(
            harness.events.some(
                (event) =>
                    event.stage === "review-fix" && event.status === "failed",
            ),
        ).toBe(false);
    });

    test("verification fixes still stop at their budget while resuming", async () => {
        const harness = await makeImplementationHarness({
            budgets: { verificationFixes: 2 },
            verification: {
                stagedTreeSha: async () => TREE_SHA,
                verify: async () => {
                    throw new VerificationCommandError({
                        stagedTreeSha: TREE_SHA,
                        commands: [
                            {
                                command: "bun test",
                                exitCode: 1,
                                stdout: "",
                                stderr: "still red",
                            },
                        ],
                    });
                },
            },
            scripts: [
                implement,
                {
                    titlePrefix: "Repair verification for issue #42",
                    result: {},
                },
            ],
        });
        const outcome = await execute(harness);
        expect(outcome.kind).toBe(IssueExecutionOutcomeKind.HandOff);
        expect(
            fixRequests(harness.requests, "Repair verification for issue #42"),
        ).toHaveLength(2);
    });
});