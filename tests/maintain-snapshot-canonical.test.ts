import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    canonicalMaintenanceJson,
    makeMaintenanceSnapshotService,
} from "../src/maintain-issues-snapshot-service.ts";
import { mapMaintainRepositoryIdentity } from "../src/maintain/github-reader/lists.ts";
import { analyzeMaintenanceCandidates } from "../src/maintain-issues-candidates.ts";
import { projectThreadPrompt } from "../src/maintain-thread-projection.ts";
import {
    createMaintenanceComment,
    createMaintenanceCommentThread,
    createMaintenanceIssue,
    createMaintenanceRepository,
    createMaintenanceUnknown,
    isMaintenanceIssueOpen,
    isMaintenanceManaged,
    isMaintenanceUnknown,
    normalizeMaintenanceAvailability,
    parseAllMaintenanceMarkers,
    parseMaintenanceMarker,
    renderMaintenanceMarker,
} from "../src/maintain/snapshot.ts";

const rawIssue = () => ({
    number: 7,
    nodeId: "I_7",
    title: "Maintenance subject",
    body: "issue body",
    url: "https://github.com/owner/repository/issues/7",
    state: "open",
    author: { login: "author", type: "User", nodeId: "U_1" },
    authorAssociation: "OWNER",
    labels: [{ name: "ready", description: "Ready", color: "00ff00" }],
    assignees: [],
    milestone: null,
    locked: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    selectedThread: {
        comments: [
            {
                id: 900,
                nodeId: "C_900",
                url: "https://github.com/owner/repository/comments/900",
                author: null,
                authorAssociation: "NONE",
                body: "a long comment body",
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-01T00:00:00.000Z",
            },
        ],
        totalCount: 1,
        complete: true,
        availability: { kind: "available", reason: null, detail: null },
    },
});

describe("canonical maintenance snapshot seam", () => {
    test("covers repository, issue, comment thread, availability, and unknown evidence", () => {
        const repository = createMaintenanceRepository(
            {
                fullName: "owner/repository",
                defaultBranch: "main",
                htmlUrl: "https://github.com/owner/repository",
            },
            "owner/repository",
        );
        expect(repository.fullName).toBe("owner/repository");
        expect(repository.defaultBranch).toBe("main");

        const issue = createMaintenanceIssue(rawIssue());
        expect(issue.number).toBe(7);
        expect(issue.selectedThread.comments).toHaveLength(1);
        expect(issue.selectedThread.complete).toBe(true);
        expect(issue).not.toHaveProperty("thread");
        expect(issue).not.toHaveProperty("commentThread");
        expect(issue).not.toHaveProperty("htmlUrl");
        expect(issue).not.toHaveProperty("content");
        expect(issue).not.toHaveProperty("isOpen");
        expect(issue).not.toHaveProperty("open");
        expect(issue).not.toHaveProperty("databaseId");

        const thread = createMaintenanceCommentThread({
            comments: [
                {
                    id: 1,
                    nodeId: "C1",
                    url: "https://example.test/c/1",
                    author: null,
                    authorAssociation: "NONE",
                    body: "hello",
                    createdAt: "2026-09-01T00:00:00.000Z",
                    updatedAt: "2026-09-01T00:00:00.000Z",
                },
            ],
            totalCount: 1,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        });
        expect(thread.fetchedCount).toBe(1);

        const availability = normalizeMaintenanceAvailability({
            kind: "partial",
            reason: "partial",
            detail: "truncated",
        });
        expect(availability.kind).toBe("partial");

        const unknown = createMaintenanceUnknown("future-value");
        expect(unknown).toEqual({ kind: "unknown", value: "future-value" });
        expect(isMaintenanceUnknown(unknown)).toBe(true);
    });

    test("canonical model accepts only canonical keys, never provider variations", () => {
        const issue = createMaintenanceIssue({
            number: 7,
            nodeId: "canonical-node",
            title: "Canonical",
            body: "body",
            url: "https://example.test/canonical",
            state: "open",
            author: { login: "author", type: "User", nodeId: "U_1" },
            authorAssociation: "OWNER",
            labels: [],
            assignees: [],
            milestone: null,
            locked: false,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
            selectedThread: { comments: [] },
        } as Record<string, unknown> as Parameters<
            typeof createMaintenanceIssue
        >[0]);
        expect(issue.nodeId).toBe("canonical-node");
        expect(issue.url).toBe("https://example.test/canonical");

        const snakeIssue = createMaintenanceIssue({
            number: 7,
            node_id: "SNAKE",
            title: "Snake",
            body: "body",
            html_url: "https://example.test/snake",
            state: "open",
            author: { login: "author", type: "User", nodeId: "U_1" },
            authorAssociation: "OWNER",
            labels: [],
            assignees: [],
            milestone: null,
            locked: false,
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-02T00:00:00.000Z",
            selectedThread: { comments: [] },
        } as unknown as Parameters<typeof createMaintenanceIssue>[0]);
        expect(snakeIssue.nodeId).toBe("");
        expect(snakeIssue.url).toBe("");
        expect(snakeIssue.createdAt).toBe("");
        expect(snakeIssue).not.toHaveProperty("node_id");
        expect(snakeIssue).not.toHaveProperty("html_url");

        const snakeComment = createMaintenanceComment({
            id: 1,
            node_id: "SNAKE",
            html_url: "https://example.test/snake",
            author: null,
            author_association: "NONE",
            body: "hello",
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
        } as unknown as Parameters<typeof createMaintenanceComment>[0]);
        expect(snakeComment.nodeId).toBe("");
        expect(snakeComment.url).toBe("");
        expect(snakeComment.authorAssociation).toEqual({
            kind: "unknown",
            value: "missing",
        });

        const marker = renderMaintenanceMarker(12);
        expect(parseMaintenanceMarker(marker)?.kind).toBe("maintain");
        expect(parseAllMaintenanceMarkers(marker)).toHaveLength(1);
        expect(isMaintenanceManaged(marker)).toBe(true);
    });

    test("equivalent evidence yields equivalent planning data and snapshot identity", async () => {
        const canonicalIssue = createMaintenanceIssue(rawIssue());

        expect(canonicalMaintenanceJson(canonicalIssue)).toContain(
            '"selectedThread"',
        );
        expect(canonicalMaintenanceJson(canonicalIssue)).not.toContain(
            '"commentThread"',
        );

        const limits = {
            commentPromptLimit: 12,
            threadPromptLimit: 80,
            aggregatePromptLimit: 80,
        };
        const projection = projectThreadPrompt({
            thread: canonicalIssue.selectedThread,
            ...limits,
        });
        expect(projection.comments[0]?.state).toBe("truncated");

        const captureWith = async (issue: typeof canonicalIssue) => {
            const service = makeMaintenanceSnapshotService({
                githubClient: {
                    initialize: async () => ({}) as Octokit,
                },
                githubReader: {
                    read: async () => ({
                        repository: {
                            fullName: "owner/repository",
                            defaultBranch: "main",
                            htmlUrl: "https://github.com/owner/repository",
                            rawDefaultBranch: "main",
                            raw: {},
                        },
                        labels: [],
                        openIssueSummaries: [],
                        selectedIssueNumbers: [issue.number],
                        selectedDetails: [],
                        selectedIssues: [issue],
                        skips: [],
                        selection: {},
                    }),
                },
                groundingReader: {
                    read: async () => ({
                        status: "skipped" as const,
                        skip: {
                            reason: "dirty-checkout" as const,
                            detail: "dirty",
                        },
                    }),
                },
                clock: () => "2026-09-05T00:00:00.000Z",
            });
            return service.capture({
                repository: "owner/repository",
                repositoryPath: "/tmp/ralphie-maintenance-repository",
                branch: "main",
                capturedAt: "2026-09-05T00:00:00.000Z",
            });
        };

        const first = await captureWith(canonicalIssue);
        const second = await captureWith(createMaintenanceIssue(rawIssue()));
        expect(second.fingerprint).toBe(first.fingerprint);

        const analysis = analyzeMaintenanceCandidates(first, 7);
        expect(analysis.status).toBe("analyzed");
    });

    test("REST variations translate once at the reader boundary", async () => {
        const { maintenanceCommentInputFromRest } = await import(
            "../src/maintain/github-reader/translate.ts"
        );
        const { maintenanceIssueInputFromRest } = await import(
            "../src/maintain/github-reader/translate.ts"
        );
        const { maintenanceRepositoryInputFromRest } = await import(
            "../src/maintain/github-reader/translate.ts"
        );

        const repositoryInput = maintenanceRepositoryInputFromRest(
            {
                full_name: "owner/repository",
                default_branch: "main",
                html_url: "https://github.com/owner/repository",
            },
            "owner/repository",
        );
        expect(repositoryInput).toEqual({
            fullName: "owner/repository",
            defaultBranch: "main",
            htmlUrl: "https://github.com/owner/repository",
        });
        expect(createMaintenanceRepository(repositoryInput).defaultBranch).toBe(
            "main",
        );

        const issueInput = maintenanceIssueInputFromRest(
            {
                number: 7,
                node_id: "I_7",
                title: "REST subject",
                body: "body",
                html_url: "https://github.com/owner/repository/issues/7",
                state: "open",
                user: { login: "author", type: "User", node_id: "U_1" },
                author_association: "OWNER",
                labels: [],
                assignees: [],
                milestone: null,
                locked: false,
                created_at: "2026-09-01T00:00:00.000Z",
                updated_at: "2026-09-02T00:00:00.000Z",
            },
            7,
        );
        expect(issueInput).toMatchObject({
            number: 7,
            nodeId: "I_7",
            url: "https://github.com/owner/repository/issues/7",
            createdAt: "2026-09-01T00:00:00.000Z",
        });
        expect(issueInput).not.toHaveProperty("node_id");
        expect(issueInput).not.toHaveProperty("html_url");
        expect(issueInput).not.toHaveProperty("author_association");
        expect(issueInput).not.toHaveProperty("created_at");
        const issue = createMaintenanceIssue({
            ...issueInput,
            selectedThread: {
                comments: [],
                totalCount: 0,
                complete: true,
                availability: { kind: "available", reason: null, detail: null },
            },
        });
        expect(issue.nodeId).toBe("I_7");

        const commentInput = maintenanceCommentInputFromRest({
            id: 1,
            node_id: "C_1",
            html_url: "https://github.com/owner/repository/comments/1",
            user: null,
            author_association: "NONE",
            body: "hello",
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
        });
        expect(commentInput).toMatchObject({
            id: 1,
            nodeId: "C_1",
            author: null,
            authorAssociation: "NONE",
        });
        expect(commentInput).not.toHaveProperty("node_id");
        const comment = createMaintenanceComment(commentInput);
        expect(comment.author).toBeNull();
        expect(comment.body).toBe("hello");
    });

    test("unknown values, unavailable threads, bounded evidence, and fail-closed completeness are preserved", async () => {
        const unknownIssue = createMaintenanceIssue({
            ...rawIssue(),
            state: "future-state",
            authorAssociation: "FUTURE_ROLE",
        });
        expect(unknownIssue.state).toEqual({
            kind: "unknown",
            value: "future-state",
        });
        expect(isMaintenanceIssueOpen(unknownIssue.state)).toBe(false);

        const unavailable = createMaintenanceCommentThread({});
        expect(unavailable.complete).toBe(false);
        expect(unavailable.availability.reason).not.toBeNull();

        const truncated = createMaintenanceCommentThread({
            comments: [
                {
                    id: 1,
                    nodeId: "C1",
                    url: "https://example.test/c/1",
                    author: null,
                    authorAssociation: "NONE",
                    body: "hello",
                    createdAt: "2026-09-01T00:00:00.000Z",
                    updatedAt: "2026-09-01T00:00:00.000Z",
                },
            ],
            totalCount: 5,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        });
        expect(truncated.complete).toBe(false);
        expect(truncated.availability.kind).toBe("partial");

        const projection = projectThreadPrompt({
            thread: createMaintenanceCommentThread({
                comments: [
                    {
                        id: 1,
                        nodeId: "C1",
                        url: "https://example.test/c/1",
                        author: null,
                        authorAssociation: "NONE",
                        body: "a long comment body",
                        createdAt: "2026-09-01T00:00:00.000Z",
                        updatedAt: "2026-09-01T00:00:00.000Z",
                    },
                ],
                totalCount: 1,
                complete: true,
                availability: { kind: "available", reason: null, detail: null },
            }),
            commentPromptLimit: 12,
            threadPromptLimit: 80,
            aggregatePromptLimit: 80,
        });
        expect(projection.comments[0]?.state).toBe("truncated");
        expect(projection.comments[0]?.marker).toBe("[truncated]");

        const contradictory = normalizeMaintenanceAvailability({
            kind: "available",
            reason: "deleted",
            detail: null,
        });
        expect(contradictory.kind).toBe("unavailable");
    });

    test("readonly canonical values and boundary copies survive later source mutations", () => {
        const input = rawIssue();
        const snapshot = createMaintenanceIssue(input);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.labels)).toBe(true);
        expect(Object.isFrozen(snapshot.selectedThread)).toBe(true);
        expect(Object.isFrozen(snapshot.selectedThread.comments)).toBe(true);
        expect(Object.isFrozen(snapshot.selectedThread.comments[0])).toBe(true);

        (input.labels as Array<Record<string, unknown>>).push({
            name: "injected",
        });
        ((input.labels[0] as Record<string, unknown>).name as string) =
            "mutated";
        (input.selectedThread.comments as Array<Record<string, unknown>>).push({
            id: 999,
        });
        expect(snapshot.labels).toHaveLength(1);
        expect(snapshot.labels[0]?.name).toBe("ready");
        expect(snapshot.selectedThread.comments).toHaveLength(1);

        const author = { login: "octocat", type: "User", nodeId: null };
        const comment = createMaintenanceComment({
            id: 1,
            nodeId: "C1",
            url: "https://example.test/c/1",
            author,
            authorAssociation: "OWNER",
            body: "body",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        author.login = "mutated";
        expect(comment.author?.login).toBe("octocat");
        expect(Object.isFrozen(comment)).toBe(true);

        expect(
            mapMaintainRepositoryIdentity(
                {
                    full_name: "owner/repository",
                    default_branch: "main",
                    html_url: "https://github.com/owner/repository",
                },
                "owner/repository",
            ).fullName,
        ).toBe("owner/repository");
    });
});