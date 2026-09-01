import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    CODEX_DECISION_PERMISSION_POLICY,
    makeCodexSessionDiagnostics,
} from "../../src/agent/task-session.ts";
import type { CodexClient } from "../../src/codex/client.ts";
import {
    IssueArtifactKind,
    makeIssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import {
    GroundingDisposition,
    NeedsAttentionReason,
} from "../../src/issues/decisions.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeNeedsAttentionRouterService } from "../../src/issues/needs-attention.ts";
import type { IssueRecoveryService } from "../../src/issues/recovery.ts";

const checkpoint = { branch: "main", sha: "abc123" } as const;
const request = {
    reason: "external_dependency",
    message: "The generated client is unavailable.",
} as const;
const decision = {
    disposition: GroundingDisposition.NeedsAttention,
    reason: NeedsAttentionReason.ExternalDependency,
    summary: "The generated client is required.",
    evidence: ["src/client.ts imports a missing generated module."],
    questions: ["Can the generated client be provided?"],
} as const;

const context = (
    codex: CodexClient,
    updatedAt = "2026-08-28T00:00:00.000Z",
    invariantChecks: unknown[] = [],
    diagnostics = makeCodexSessionDiagnostics(),
): IssueExecutionContext => ({
    issue: {
        number: 42,
        title: "Use generated client",
        url: "https://github.com/owner/repo/issues/42",
        body: "Use the generated client.",
        labels: [],
        updatedAt,
        commentCount: 0,
    },
    repository: "owner/repo",
    repositoryPath: "/workspace/repo",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "run-1",
    octokit: {} as Octokit,
    codex,
    codexSelection: {
        agent: "build",
        model: { providerID: "openai", modelID: "grounding-model" },
        variant: "base-variant",
    },
    codexStageVariants: { grounding: "grounding-variant" },
    codexDiagnostics: diagnostics,
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: checkpoint.sha }),
        verify: async (repositoryPath, expected) => {
            invariantChecks.push({ repositoryPath, expected });
        },
    },
});

const client = (
    outputs: ReadonlyArray<unknown>,
    sessions: string[],
    permissions: unknown[],
    prompts: unknown[] = [],
): CodexClient => {
    let output = 0;
    return {
        session: {
            create: async (input: { permission?: unknown }) => {
                const id = `verifier-${sessions.length + 1}`;
                sessions.push(id);
                permissions.push(input.permission);
                return { data: { id } };
            },
            prompt: async (input: unknown) => {
                prompts.push(input);
                return {
                    data: {
                        info: { structured: outputs[output++] },
                        parts: [],
                        // A verifier-emitted signal is deliberately ignored.
                        needsAttention: request,
                    },
                };
            },
        },
    } as unknown as CodexClient;
};

const recovery = (
    calls: string[],
    fail = { value: false },
    beforeRecovery: () => void = () => {},
): IssueRecoveryService => ({
    handleReviewExhaustion: async () => {
        throw new Error("unused");
    },
    handleNeedsAttention: async (input) => {
        beforeRecovery();
        calls.push(input.decision.summary);
        if (fail.value) throw new Error("recovery interrupted");
        return { diagnosticsPath: "/workspace/diagnostics" };
    },
});

describe("needs-attention router", () => {
    test("uses one fresh read-only verifier and persists confirmation before recovery", async () => {
        const sessions: string[] = [];
        const permissions: unknown[] = [];
        const prompts: unknown[] = [];
        const invariantChecks: unknown[] = [];
        const diagnostics = makeCodexSessionDiagnostics();
        diagnostics.record("run-1", {
            sessionID: "originating-session",
            directory: "/workspace/repo",
            agent: "build",
        });
        const artifacts = await makeIssueArtifactStore(42);
        const recoveryCalls: string[] = [];
        let decisionExistedBeforeRecovery = false;
        const router = makeNeedsAttentionRouterService(
            recovery(recoveryCalls, { value: false }, () => {
                decisionExistedBeforeRecovery = artifacts.has(
                    IssueArtifactKind.NeedsAttentionDecision,
                );
            }),
        );

        const result = await router.route({
            context: context(
                client([decision], sessions, permissions, prompts),
                "2026-08-28T00:00:00.000Z",
                invariantChecks,
                diagnostics,
            ),
            artifacts,
            request,
            checkpoint,
        });

        expect(result).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            summary: decision.summary,
            diagnosticsPath: "/workspace/diagnostics",
        });
        expect(sessions).toEqual(["verifier-1"]);
        expect(
            diagnostics.list("run-1").map(({ sessionID }) => sessionID),
        ).toEqual(["originating-session", "verifier-1"]);
        expect(permissions).toEqual([CODEX_DECISION_PERMISSION_POLICY]);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
            sessionID: "verifier-1",
            directory: "/workspace/repo",
            agent: "build",
            model: {
                providerID: "openai",
                modelID: "grounding-model",
            },
            variant: "grounding-variant",
        });
        expect(invariantChecks).toEqual([
            {
                repositoryPath: "/workspace/repo",
                expected: { branch: "main", head: checkpoint.sha },
            },
        ]);
        expect(decisionExistedBeforeRecovery).toBe(true);
        expect(recoveryCalls).toEqual([decision.summary]);
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            true,
        );
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
    });

    test("freshly verifies a new request even when a current confirmation exists", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(IssueArtifactKind.NeedsAttentionDecision, {
            decision: {
                ...decision,
                summary: "An older request was confirmed.",
            },
            fingerprint: {
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
        });
        const sessions: string[] = [];
        const recoveryCalls: string[] = [];

        await makeNeedsAttentionRouterService(recovery(recoveryCalls)).route({
            context: context(client([decision], sessions, [])),
            artifacts,
            request,
            checkpoint,
        });

        expect(sessions).toEqual(["verifier-1"]);
        expect(recoveryCalls).toEqual([decision.summary]);
        expect(
            (await artifacts.read(IssueArtifactKind.NeedsAttentionDecision))
                .decision,
        ).toEqual(decision);
    });

    test.each([
        { disposition: GroundingDisposition.Actionable },
        { disposition: GroundingDisposition.AlreadyResolved },
    ])("continues for $disposition", async (output) => {
        const artifacts = await makeIssueArtifactStore(42);
        const recoveryCalls: string[] = [];
        const result = await makeNeedsAttentionRouterService(
            recovery(recoveryCalls),
        ).route({
            context: context(client([output], [], [])),
            artifacts,
            request,
            checkpoint,
        });

        expect(result).toBeUndefined();
        expect(recoveryCalls).toEqual([]);
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
    });

    test("does not recursively route a verifier-emitted signal", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const sessions: string[] = [];
        const result = await makeNeedsAttentionRouterService(
            recovery([]),
        ).route({
            context: context(
                client(
                    [{ disposition: GroundingDisposition.Actionable }],
                    sessions,
                    [],
                ),
            ),
            artifacts,
            request,
            checkpoint,
        });

        expect(result).toBeUndefined();
        expect(sessions).toEqual(["verifier-1"]);
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
    });

    test("does nothing when no request or recoverable handoff exists", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const sessions: string[] = [];
        const result = await makeNeedsAttentionRouterService(
            recovery([]),
        ).route({
            context: context(client([], sessions, [])),
            artifacts,
        });

        expect(result).toBeUndefined();
        expect(sessions).toEqual([]);
    });

    test("resumes recovery without a second verifier after interruption", async () => {
        const sessions: string[] = [];
        const permissions: unknown[] = [];
        const artifacts = await makeIssueArtifactStore(42);
        const fail = { value: true };
        const recoveryCalls: string[] = [];
        const router = makeNeedsAttentionRouterService(
            recovery(recoveryCalls, fail),
        );
        const executionContext = context(
            client([decision], sessions, permissions),
        );

        await expect(
            router.route({
                context: executionContext,
                artifacts,
                request,
                checkpoint,
            }),
        ).rejects.toThrow("recovery interrupted");
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            true,
        );
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            true,
        );

        fail.value = false;
        const resumed = await router.route({
            context: executionContext,
            artifacts,
        });
        expect(resumed?.kind).toBe(IssueExecutionOutcomeKind.NeedsAttention);
        expect(sessions).toHaveLength(1);
        expect(recoveryCalls).toHaveLength(2);
    });

    test("retains the handoff when verification fails and retries fresh", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const failedClient = {
            session: {
                create: async () => ({ data: { id: "failed-verifier" } }),
                prompt: async () => {
                    throw new Error("verifier interrupted");
                },
            },
        } as unknown as CodexClient;
        const recoveryCalls: string[] = [];
        const router = makeNeedsAttentionRouterService(recovery(recoveryCalls));

        await expect(
            router.route({
                context: context(failedClient),
                artifacts,
                request,
                checkpoint,
            }),
        ).rejects.toThrow("Failed to get structured output");
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            true,
        );
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            false,
        );

        const sessions: string[] = [];
        const resumed = await router.route({
            context: context(client([decision], sessions, [])),
            artifacts,
        });
        expect(resumed?.kind).toBe(IssueExecutionOutcomeKind.NeedsAttention);
        expect(sessions).toEqual(["verifier-1"]);
        expect(recoveryCalls).toHaveLength(1);
    });

    test("retains the handoff when verifier output is rejected", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const sessions: string[] = [];
        const router = makeNeedsAttentionRouterService(recovery([]));

        await expect(
            router.route({
                context: context(
                    client(
                        [{ disposition: GroundingDisposition.NeedsAttention }],
                        sessions,
                        [],
                    ),
                ),
                artifacts,
                request,
                checkpoint,
            }),
        ).rejects.toThrow("Failed to get structured output");

        expect(sessions).toEqual(["verifier-1"]);
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            true,
        );
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            false,
        );
    });

    test("invalidates a pending handoff when issue freshness changes", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(IssueArtifactKind.NeedsAttentionHandoff, {
            request,
            checkpoint,
            fingerprint: {
                updatedAt: "2026-08-28T00:00:00.000Z",
                commentCount: 0,
            },
        });
        const result = await makeNeedsAttentionRouterService(
            recovery([]),
        ).route({
            context: context(client([], [], []), "2026-08-29T00:00:00.000Z"),
            artifacts,
        });

        expect(result).toBeUndefined();
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
    });
});