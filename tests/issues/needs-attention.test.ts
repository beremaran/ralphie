import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    PI_DECISION_PERMISSION_POLICY,
    makePiSessionDiagnostics,
} from "../../src/agent/task-session.ts";
import type { PiClient } from "../../src/pi/client.ts";
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
    pi: PiClient,
    updatedAt = "2026-08-28T00:00:00.000Z",
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
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(),
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: checkpoint.sha }),
        verify: async () => {},
    },
});

const client = (
    outputs: ReadonlyArray<unknown>,
    sessions: string[],
    permissions: unknown[],
): PiClient => {
    let output = 0;
    return {
        session: {
            create: async (input: { permission?: unknown }) => {
                const id = `verifier-${sessions.length + 1}`;
                sessions.push(id);
                permissions.push(input.permission);
                return { data: { id } };
            },
            prompt: async () => ({
                data: {
                    info: { structured: outputs[output++] },
                    parts: [],
                    needsAttention: request,
                },
            }),
        },
    } as unknown as PiClient;
};

const recovery = (
    calls: string[],
    fail = { value: false },
): IssueRecoveryService => ({
    handleReviewExhaustion: async () => {
        throw new Error("unused");
    },
    handleNeedsAttention: async (input) => {
        calls.push(input.decision.summary);
        if (fail.value) throw new Error("recovery interrupted");
        return { diagnosticsPath: "/workspace/diagnostics" };
    },
});

describe("needs-attention router", () => {
    test("uses one fresh read-only verifier and persists confirmation before recovery", async () => {
        const sessions: string[] = [];
        const permissions: unknown[] = [];
        const artifacts = await makeIssueArtifactStore(42);
        const recoveryCalls: string[] = [];
        const router = makeNeedsAttentionRouterService(recovery(recoveryCalls));

        const result = await router.route({
            context: context(client([decision], sessions, permissions)),
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
        expect(permissions).toEqual([PI_DECISION_PERMISSION_POLICY]);
        expect(recoveryCalls).toEqual([decision.summary]);
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
            true,
        );
        expect(artifacts.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
            false,
        );
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
        } as unknown as PiClient;
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