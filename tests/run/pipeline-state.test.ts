import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { normalizePipelineSnapshot } from "../../src/github/pipeline-snapshot.ts";
import {
    makePipelineRunState,
    makePipelineRunStatePersistence,
    PipelineRunStateStoreLive,
    pipelineRunStateSchema,
    reconcilePipelineRunStateOnResume,
    safePipelineSnapshot,
    setPipelineRunPhase,
    updatePipelineRunState,
    validatePipelineResumeState,
} from "../../src/run/pipeline-state.ts";
import type {
    PipelineDeliveryOutcome,
    PipelineDeliveryPersistenceEvent,
} from "../../src/issues/pipeline-delivery-loop.ts";

const BASE = "a".repeat(40);
const CREATED = "b".repeat(40);
const OTHER = "c".repeat(40);
const TREE = "d".repeat(40);
const NOW = new Date("2026-09-05T10:00:00.000Z");
const REQUEST = {
    repository: "owner/repository",
    branch: "main",
    commitSha: BASE,
};

const snapshot = normalizePipelineSnapshot({
    ...REQUEST,
    checkRuns: [
        {
            name: "build",
            head_sha: BASE,
            head_branch: "main",
            status: "completed",
            conclusion: "failure",
            malicious: "<do not follow>",
        },
    ],
});

const stateFor = () =>
    makePipelineRunState({
        runId: "pipeline-run",
        repository: REQUEST.repository,
        branch: REQUEST.branch,
        workspace: "/tmp/ralphie-workspace",
        deadlineAtMs: NOW.getTime() + 60_000,
        maxAttempts: 3,
        currentRemoteSha: BASE,
        now: NOW,
    });

describe("pipeline run state", () => {
    test("stores a bounded snapshot projection without raw provider values", () => {
        const safe = safePipelineSnapshot(snapshot);

        expect(safe.request).toEqual(REQUEST);
        expect(safe.items).toEqual([
            {
                source: "check-run",
                provider: "github.check-run",
                name: "build",
                status: "failing",
            },
        ]);
        expect(safe).not.toHaveProperty("diagnostics");
        expect(safe).not.toHaveProperty("rawValues");
        expect(pipelineRunStateSchema.shape.snapshot.parse(safe)).toEqual(safe);
    });

    test("persists atomically and leaves the prior state intact after invalid input", async () => {
        const root = await mkdtemp(join(tmpdir(), "ralphie-pipeline-state-"));
        const path = join(root, "nested", "state.json");
        try {
            const state = stateFor();
            await PipelineRunStateStoreLive.save(path, state);
            expect(await PipelineRunStateStoreLive.load(path)).toEqual(state);

            await expect(
                PipelineRunStateStoreLive.save(path, {
                    ...state,
                    currentRemoteSha: "invalid",
                } as typeof state),
            ).rejects.toBeDefined();
            expect(await PipelineRunStateStoreLive.load(path)).toEqual(state);
            expect(await readdir(join(root, "nested"))).toEqual(["state.json"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("migrates the version-zero pipeline state and rewrites it as version one", async () => {
        const root = await mkdtemp(join(tmpdir(), "ralphie-pipeline-state-"));
        const path = join(root, "state.json");
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: 0,
                    runId: "legacy-run",
                    repository: REQUEST.repository,
                    branch: REQUEST.branch,
                    workspace: "/tmp/legacy",
                    deadlineAtMs: NOW.getTime() + 60_000,
                    maxAttempts: 2,
                    currentRemoteSha: BASE,
                }),
            );
            const loaded = await PipelineRunStateStoreLive.load(path);
            expect(loaded.version).toBe(1);
            expect(loaded.phase).toBe("observation");
            expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("invalidates a stale snapshot and diagnostic reference when the remote head advances", () => {
        const state = updatePipelineRunState(
            stateFor(),
            {
                phase: "repair",
                snapshot: safePipelineSnapshot(snapshot),
                diagnostics: {
                    path: "/tmp/diagnostics.json",
                    commitSha: BASE,
                    failureFingerprint: "failure",
                },
                failureFingerprint: "failure",
            },
            NOW,
        );
        const result = reconcilePipelineRunStateOnResume({
            state,
            remoteSha: OTHER,
            now: NOW,
        });

        expect(result.action).toBe("resume-observation");
        expect(result.state.currentRemoteSha).toBe(OTHER);
        expect(result.state.phase).toBe("observation");
        expect(result.state.snapshot).toBeUndefined();
        expect(result.state.diagnostics).toBeUndefined();
        expect(result.state.failureFingerprint).toBeUndefined();
    });

    test("reconciles a remote-created commit exactly once and never duplicates its push charge", () => {
        const pending = updatePipelineRunState(
            stateFor(),
            {
                phase: "push",
                checkpoint: { branch: "main", sha: BASE },
                createdCommit: {
                    sha: CREATED,
                    parentSha: BASE,
                    treeSha: TREE,
                },
            },
            NOW,
        );
        const first = reconcilePipelineRunStateOnResume({
            state: pending,
            remoteSha: CREATED,
            now: NOW,
        });
        const second = reconcilePipelineRunStateOnResume({
            state: first.state,
            remoteSha: CREATED,
            now: new Date(NOW.getTime() + 1),
        });

        expect(first.action).toBe("reconciled-push");
        expect(first.state.pushedAttempts).toBe(1);
        expect(first.state.pushedCommit?.sha).toBe(CREATED);
        expect(second.state.pushedAttempts).toBe(1);
        expect(second.state.pushedCommit?.sha).toBe(CREATED);
    });

    test("allows only the recorded commit to resume an ambiguous push", () => {
        const pending = updatePipelineRunState(
            stateFor(),
            {
                phase: "push",
                checkpoint: { branch: "main", sha: BASE },
                createdCommit: {
                    sha: CREATED,
                    parentSha: BASE,
                    treeSha: TREE,
                },
            },
            NOW,
        );
        const result = reconcilePipelineRunStateOnResume({
            state: pending,
            remoteSha: BASE,
            now: NOW,
        });

        expect(result.action).toBe("resume-push");
        expect(result.state.createdCommit?.sha).toBe(CREATED);
        expect(result.state.pushedAttempts).toBe(0);
    });

    test("stops safely on an unrelated remote during a pending commit and preserves the original deadline", () => {
        const pending = updatePipelineRunState(
            stateFor(),
            {
                phase: "push",
                checkpoint: { branch: "main", sha: BASE },
                createdCommit: {
                    sha: CREATED,
                    parentSha: BASE,
                    treeSha: TREE,
                },
            },
            NOW,
        );
        const result = reconcilePipelineRunStateOnResume({
            state: pending,
            remoteSha: OTHER,
            now: NOW,
        });

        expect(result.action).toBe("stale-remote");
        expect(result.state.status).toBe("stopped");
        expect(result.state.deadlineAtMs).toBe(pending.deadlineAtMs);
        expect(result.state.pushedAttempts).toBe(0);
    });

    test("does not restart an expired original deadline on resume", () => {
        const state = updatePipelineRunState(
            stateFor(),
            { phase: "observation" },
            NOW,
        );
        const result = reconcilePipelineRunStateOnResume({
            state,
            remoteSha: BASE,
            now: new Date(state.deadlineAtMs),
        });

        expect(result.action).toBe("deadline-expired");
        expect(result.state.status).toBe("stopped");
        expect(result.state.deadlineAtMs).toBe(state.deadlineAtMs);
    });

    test("does not report a saved green result after the remote head advances", () => {
        const state = updatePipelineRunState(
            stateFor(),
            {
                status: "complete",
                phase: "complete",
                snapshot: safePipelineSnapshot({
                    ...snapshot,
                    commitSha: BASE,
                }),
                outcome: {
                    kind: "green",
                    remoteSha: BASE,
                    pushedAttempts: 0,
                },
            },
            NOW,
        );
        const result = reconcilePipelineRunStateOnResume({
            state,
            remoteSha: OTHER,
            now: NOW,
        });

        expect(result.action).toBe("resume-observation");
        expect(result.state.status).toBe("active");
        expect(result.state.snapshot).toBeUndefined();
        expect(result.state.outcome).toBeUndefined();
    });

    test("validates repository and branch compatibility before resume", () => {
        const state = stateFor();
        expect(() =>
            validatePipelineResumeState(state, {
                repository: "other/repository",
                branch: "main",
            }),
        ).toThrow(/saved repository/);
        expect(() =>
            validatePipelineResumeState(state, {
                repository: REQUEST.repository,
                branch: "release",
            }),
        ).toThrow(/saved branch/);
    });

    test("persists phase boundaries and terminal outcome without charging a push twice", async () => {
        const writes: ReturnType<typeof stateFor>[] = [];
        const state = stateFor();
        const persistence = makePipelineRunStatePersistence({
            path: "/tmp/pipeline-state.json",
            initialState: state,
            now: () => NOW,
            store: {
                save: async (_path, next) => {
                    writes.push(structuredClone(next));
                },
                load: async () => state,
                remove: async () => {},
            },
        });
        const createdSha = CREATED;
        const attempt = {
            attempt: 1,
            baseSha: BASE,
            failureFingerprint: "normalized-failure",
            repair: "approved" as const,
            commit: {
                status: "created" as const,
                sha: createdSha,
                parentSha: BASE,
                treeSha: TREE,
            },
            push: {
                status: "confirmed" as const,
                response: "accepted" as const,
                remoteSha: createdSha,
            },
        };
        const prepare: PipelineDeliveryPersistenceEvent = {
            phase: "prepare",
            status: "before",
            currentRemoteSha: BASE,
            pushedAttempts: 0,
            externalMovements: 0,
        };
        await persistence.onPhase(prepare);
        expect(persistence.getState().checkpoint).toEqual({
            branch: "main",
            sha: BASE,
        });

        const push: PipelineDeliveryPersistenceEvent = {
            phase: "push",
            status: "reconciled",
            currentRemoteSha: BASE,
            pushedAttempts: 0,
            externalMovements: 0,
            failureFingerprint: "normalized-failure",
            snapshot,
            diagnosticsPath: "/tmp/diagnostics.json",
            attempt: 1,
            attemptState: attempt,
            commit: {
                sha: createdSha,
                parentSha: BASE,
                treeSha: TREE,
            },
        };
        await persistence.onPhase(push);
        await persistence.onPhase(push);
        expect(persistence.getState().pushedAttempts).toBe(1);
        expect(persistence.getState().createdCommit?.sha).toBe(createdSha);
        expect(persistence.getState().diagnostics?.path).toBe(
            "/tmp/diagnostics.json",
        );

        const outcome: PipelineDeliveryOutcome = {
            kind: "green",
            status: "green",
            source: "pushed-repair",
            repository: REQUEST.repository,
            branch: REQUEST.branch,
            remoteSha: createdSha,
            failureFingerprint: "normalized-failure",
            diagnosticsPath: "/tmp/diagnostics.json",
            pushedAttempts: 1,
            externalMovements: 0,
            attempts: [attempt],
            phases: [],
            snapshot: {
                ...snapshot,
                commitSha: createdSha,
            },
        };
        await persistence.onOutcome(outcome);
        expect(persistence.getState().status).toBe("complete");
        expect(persistence.getState().phase).toBe("complete");
        expect(persistence.getState().pushedAttempts).toBe(1);
        expect(persistence.getState().outcome?.kind).toBe("green");
        expect(writes.length).toBe(4);
        expect(JSON.stringify(persistence.getState())).not.toContain(
            "rawValues",
        );
    });
});