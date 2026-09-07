import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    canonicalMaintenanceJson,
    makeMaintenanceSnapshotService,
} from "../src/maintain-issues-snapshot-service.ts";
import {
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    createUnknownValue,
    maintainMarker,
    normalizeMaintainableAvailability,
    parseRalphieMarker,
} from "../src/maintain-issues-snapshot.ts";
import { mapMaintainRepositoryIdentity } from "../src/maintain/github-reader/lists.ts";
import { analyzeMaintenanceCandidates } from "../src/maintain-issues-candidates.ts";
import { projectThreadPrompt } from "../src/maintain-thread-projection.ts";
import {
    cloneMaintenanceComment,
    cloneMaintenanceCommentThread,
    cloneMaintenanceIssue,
    createMaintenanceComment,
    createMaintenanceCommentThread,
    createMaintenanceIssue,
    createMaintenanceRepository,
    createMaintenanceUnknown,
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
                full_name: "owner/repository",
                default_branch: "main",
                html_url: "https://github.com/owner/repository",
            },
            "owner/repository",
        );
        expect(repository.fullName).toBe("owner/repository");
        expect(repository.defaultBranch).toBe("main");

        const issue = createMaintenanceIssue(rawIssue());
        expect(issue.number).toBe(7);
        expect(issue.commentThread.comments).toHaveLength(1);
        expect(issue.commentThread.complete).toBe(true);

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

    test("canonical and compatibility paths produce equivalent values", () => {
        const raw = rawIssue();
        const canonical = createMaintenanceIssue(raw);
        const compat = createMaintainableIssue(raw);
        expect(canonical).toEqual(compat);
        expect(cloneMaintenanceIssue(canonical)).toEqual(compat);
        expect(cloneMaintenanceIssue(compat)).toEqual(canonical);

        const canonicalComment = createMaintenanceComment({
            id: 5,
            nodeId: "C5",
            url: "https://example.test/c/5",
            author: null,
            authorAssociation: "NONE",
            body: "body",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
        });
        const compatComment = createMaintainableComment({
            id: 5,
            nodeId: "C5",
            url: "https://example.test/c/5",
            author: null,
            authorAssociation: "NONE",
            body: "body",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
        });
        expect(canonicalComment).toEqual(compatComment);
        expect(cloneMaintenanceComment(canonicalComment)).toEqual(
            compatComment,
        );

        const canonicalThread = createMaintenanceCommentThread({
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
        const compatThread = createMaintainableThread({
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
        expect(canonicalThread).toEqual(compatThread);
        expect(cloneMaintenanceCommentThread(canonicalThread)).toEqual(
            compatThread,
        );

        expect(createMaintenanceUnknown("future")).toEqual(
            createUnknownValue("future"),
        );
        expect(
            normalizeMaintenanceAvailability({
                kind: "available",
                reason: null,
                detail: null,
            }),
        ).toEqual(
            normalizeMaintainableAvailability({
                kind: "available",
                reason: null,
                detail: null,
            }),
        );
        expect(
            createMaintenanceRepository(
                {
                    full_name: "owner/repository",
                    default_branch: "main",
                    html_url: "https://github.com/owner/repository",
                },
                "owner/repository",
            ).fullName,
        ).toBe(
            mapMaintainRepositoryIdentity(
                {
                    full_name: "owner/repository",
                    default_branch: "main",
                    html_url: "https://github.com/owner/repository",
                },
                "owner/repository",
            ).fullName,
        );

        const marker = renderMaintenanceMarker(12);
        expect(marker).toBe(maintainMarker(12));
        expect(parseMaintenanceMarker(marker)).toEqual(
            parseRalphieMarker(marker),
        );
        expect(parseAllMaintenanceMarkers(marker)).toHaveLength(1);
        expect(isMaintenanceManaged(marker)).toBe(true);
    });

    test("equivalent evidence yields equivalent planning data and snapshot identity", async () => {
        const canonicalIssue = createMaintenanceIssue(rawIssue());
        const compatIssue = createMaintainableIssue(rawIssue());

        expect(canonicalMaintenanceJson(canonicalIssue)).toBe(
            canonicalMaintenanceJson(compatIssue),
        );

        const limits = {
            commentPromptLimit: 12,
            threadPromptLimit: 80,
            aggregatePromptLimit: 80,
        };
        const canonicalProjection = projectThreadPrompt({
            thread: canonicalIssue.selectedThread,
            ...limits,
        });
        const compatProjection = projectThreadPrompt({
            thread: compatIssue.selectedThread,
            ...limits,
        });
        expect(canonicalProjection).toEqual(compatProjection);

        const captureWith = async (issue: typeof compatIssue) => {
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

        const canonicalSnapshot = await captureWith(canonicalIssue);
        const compatSnapshot = await captureWith(compatIssue);
        expect(canonicalSnapshot.fingerprint).toBe(compatSnapshot.fingerprint);

        const canonicalAnalysis = analyzeMaintenanceCandidates(
            canonicalSnapshot,
            7,
        );
        const compatAnalysis = analyzeMaintenanceCandidates(compatSnapshot, 7);
        expect(canonicalAnalysis).toEqual(compatAnalysis);
    });
});