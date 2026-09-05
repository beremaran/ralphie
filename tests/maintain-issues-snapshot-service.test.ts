import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import type {
    GroundingReadOutcome,
    GroundingReaderService,
    GuidanceBundle,
} from "../src/maintain-issues-grounding-reader.ts";
import {
    makeMaintenanceSnapshotService,
    type MaintenanceSnapshotGitHubReader,
} from "../src/maintain-issues-snapshot-service.ts";
import type { MaintainableSnapshot } from "../src/maintain/github-reader.ts";
import type { MaintainableIssueSummary } from "../src/maintain/github-reader/lists.ts";
import {
    createMaintainableIssue,
    type MaintainableIssue,
    type MaintainableSkip,
} from "../src/maintain-issues-snapshot.ts";

const CLIENT = {} as Octokit;
const REPOSITORY = "owner/repository";
const REPOSITORY_PATH = "/tmp/ralphie-maintenance-repository";
const CAPTURED_AT = "2026-09-05T00:00:00.000Z";

const guidance = (content = "readme guidance"): GuidanceBundle => ({
    files: [
        {
            path: "README.md",
            state: "available",
            content,
            byteLength: Buffer.byteLength(content),
            truncated: false,
            omitted: false,
            marker: null,
            detail: null,
            originalByteLength: Buffer.byteLength(content),
            limit: 16_384,
        },
    ],
    totalByteLength: Buffer.byteLength(content),
    truncated: false,
    omitted: false,
    perFileByteLimit: 16_384,
    aggregateByteLimit: 65_536,
});

const grounded = (head = "a".repeat(40)): GroundingReadOutcome => ({
    status: "grounded",
    grounding: {
        branch: "main",
        head,
        clean: true,
        readOnly: true,
    },
    guidance: guidance(),
});

const comment = (body: string) => ({
    id: 900,
    databaseId: 900,
    nodeId: "C_900",
    url: "https://github.com/owner/repository/comments/900",
    htmlUrl: "https://github.com/owner/repository/comments/900",
    author: null,
    authorAssociation: "NONE" as const,
    body,
    content: body,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    isRalphieManaged: false,
    marker: undefined,
});

const makeIssue = (body = "issue body"): MaintainableIssue =>
    createMaintainableIssue({
        number: 7,
        nodeId: "I_7",
        title: "Maintenance subject",
        body,
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
            comments: [comment("a long comment body")],
            totalCount: 1,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        },
    });

const makeSummary = (description = "Ready"): MaintainableIssueSummary =>
    ({
        number: 7,
        nodeId: "I_7",
        title: "Maintenance subject",
        url: "https://github.com/owner/repository/issues/7",
        htmlUrl: "https://github.com/owner/repository/issues/7",
        labels: [{ name: "ready", description, color: "00ff00" }],
        author: { login: "author", type: "User", nodeId: "U_1" },
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        commentCount: 1,
        state: "open",
        isOpen: true,
        raw: {},
    }) as MaintainableIssueSummary;

const makeSource = (
    input: {
        readonly issue?: MaintainableIssue;
        readonly summaryDescription?: string;
        readonly labels?: ReadonlyArray<{
            readonly name: string;
            readonly description: string | null;
            readonly color: string | null;
        }>;
        readonly skips?: ReadonlyArray<MaintainableSkip>;
    } = {},
): MaintainableSnapshot => {
    const issue = input.issue ?? makeIssue();
    return {
        repository: {
            fullName: REPOSITORY,
            defaultBranch: "main",
            htmlUrl: "https://github.com/owner/repository",
            rawDefaultBranch: "main",
            raw: {},
        },
        labels: input.labels ?? [
            { name: "z", description: null, color: "ffffff" },
            { name: "a", description: null, color: "000000" },
        ],
        openIssueSummaries: [makeSummary(input.summaryDescription)],
        selectedIssueNumbers: [issue.number],
        selectedDetails: [],
        selectedIssues: [issue],
        skips: input.skips ?? [],
        selection: {
            issueLabels: ["ready"],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
        },
    };
};

const makeReaders = (
    source: MaintainableSnapshot,
    outcome: GroundingReadOutcome,
) => {
    const calls = { initialize: 0, github: 0, grounding: 0 };
    const githubReader: MaintenanceSnapshotGitHubReader = {
        read: async (input) => {
            calls.github += 1;
            expect(input.client).toBe(CLIENT);
            return source;
        },
    };
    const groundingReader: GroundingReaderService = {
        read: async (input, options) => {
            calls.grounding += 1;
            expect(input.repositoryPath).toBe(REPOSITORY_PATH);
            expect(input.branch).toBe("main");
            expect(options).toEqual({
                perFileByteLimit: 12,
                aggregateByteLimit: 40,
            });
            return outcome;
        },
    };
    const service = makeMaintenanceSnapshotService({
        githubClient: {
            initialize: async () => {
                calls.initialize += 1;
                return CLIENT;
            },
        },
        githubReader,
        groundingReader,
        clock: () => CAPTURED_AT,
    });
    return { calls, service };
};

const request = {
    repository: REPOSITORY,
    repositoryPath: REPOSITORY_PATH,
    branch: "main",
    runId: "run-7",
    selection: {
        issueLabels: ["ready"],
        issueSort: IssueSort.Created,
        issueOrder: IssueOrder.Ascending,
    },
    commentPromptLimit: 12,
    threadPromptLimit: 80,
    aggregatePromptLimit: 80,
    guidancePerFileByteLimit: 12,
    guidanceAggregateByteLimit: 40,
    capturedAt: CAPTURED_AT,
};

describe("maintenance snapshot assembler", () => {
    test("loads each source once, applies budgets, and returns isolated immutable context", async () => {
        const source = makeSource();
        const { calls, service } = makeReaders(source, grounded());
        const snapshot = await service.capture(request);

        expect(calls).toEqual({ initialize: 1, github: 1, grounding: 1 });
        expect(snapshot.schemaVersion).toBe(1);
        expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(snapshot.metadata.sources).toEqual({
            github: "complete",
            grounding: "grounded",
            guidance: "available",
        });
        expect(snapshot.metadata.counts).toMatchObject({
            labelCount: 2,
            openIssueSummaryCount: 1,
            selectedIssueCount: 1,
            fetchedCommentCount: 1,
            guidanceFileCount: 1,
        });
        expect(snapshot.selectedDetails[0]?.threadProjection.commentLimit).toBe(
            12,
        );
        expect(snapshot.guidance?.perFileByteLimit).toBe(12);
        expect(snapshot.guidance?.aggregateByteLimit).toBe(40);
        expect(snapshot.labels.map((label) => label.name)).toEqual(["a", "z"]);
        expect(snapshot.grounding?.head).toBe("a".repeat(40));

        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.metadata)).toBe(true);
        expect(Object.isFrozen(snapshot.labels)).toBe(true);
        expect(Object.isFrozen(snapshot.labels[0])).toBe(true);
        expect(Object.isFrozen(snapshot.selectedIssues)).toBe(true);
        expect(Object.isFrozen(snapshot.selectedIssues[0])).toBe(true);
        expect(Object.isFrozen(snapshot.selectedDetails[0]?.thread)).toBe(true);
        expect(Object.isFrozen(snapshot.guidance)).toBe(true);
        expect(Object.isFrozen(snapshot.guidance?.files)).toBe(true);

        const mutableSource = source.labels as unknown as Array<
            Record<string, unknown>
        >;
        mutableSource.push({ name: "injected" });
        expect(snapshot.labels).toHaveLength(2);
        expect(snapshot.repository).not.toBe(source.repository);
        expect(snapshot.selectedIssues[0]).not.toBe(source.selectedIssues[0]);
        expect(snapshot.selectedDetails[0]?.thread.comments[0]).not.toBe(
            source.selectedIssues[0]?.selectedThread.comments[0],
        );
    });

    test("fingerprints equivalent values canonically and changes for plan context", async () => {
        const capture = async (
            input: {
                readonly source?: MaintainableSnapshot;
                readonly outcome?: GroundingReadOutcome;
            } = {},
        ) => {
            const { service } = makeReaders(
                input.source ?? makeSource(),
                input.outcome ?? grounded(),
            );
            return service.capture(request);
        };

        const first = await capture();
        const equivalent = await capture({
            source: makeSource({
                labels: [
                    { name: "a", description: null, color: "000000" },
                    { name: "z", description: null, color: "ffffff" },
                ],
            }),
        });
        expect(equivalent.fingerprint).toBe(first.fingerprint);

        const changedLabel = await capture({
            source: makeSource({ summaryDescription: "Changed" }),
        });
        expect(changedLabel.fingerprint).not.toBe(first.fingerprint);

        const changedComment = await capture({
            source: makeSource({ issue: makeIssue("changed issue body") }),
        });
        expect(changedComment.fingerprint).not.toBe(first.fingerprint);

        const changedGrounding = await capture({
            outcome: grounded("b".repeat(40)),
        });
        expect(changedGrounding.fingerprint).not.toBe(first.fingerprint);
    });

    test("preserves typed skips and explicit prompt omission/truncation metadata", async () => {
        const skip = {
            reason: "inaccessible" as const,
            detail: "permission denied",
            issueNumber: 99,
        };
        const issue = makeIssue();
        const { service } = makeReaders(
            makeSource({ issue, skips: [skip] }),
            grounded(),
        );
        const snapshot = await service.capture({
            ...request,
            commentPromptLimit: 12,
            threadPromptLimit: 20,
            aggregatePromptLimit: 20,
        });

        expect(snapshot.skips).toContainEqual(skip);
        const projection = snapshot.selectedDetails[0]?.threadProjection;
        expect(projection?.comments[0]?.state).toBe("truncated");
        expect(projection?.comments[0]?.marker).toBe("[truncated]");
        expect(projection?.comments[0]?.content.length).toBeLessThanOrEqual(12);
        expect(projection?.thread.limit).toBe(20);
        expect(projection?.aggregate.limit).toBe(20);
        expect(snapshot.selectedDetails[0]?.thread.fetchedCount).toBe(1);
        expect(snapshot.selectedDetails[0]?.thread.complete).toBe(true);
    });

    test("keeps a grounding skip as a typed, fingerprinted outcome", async () => {
        const outcome: GroundingReadOutcome = {
            status: "skipped",
            skip: {
                reason: "dirty-checkout",
                detail: "checkout has uncommitted changes",
            },
        };
        const { service } = makeReaders(makeSource(), outcome);
        const snapshot = await service.capture(request);

        expect(snapshot.grounding).toBeUndefined();
        expect(snapshot.guidance).toBeUndefined();
        expect(snapshot.groundingStatus).toBe("skipped");
        expect(snapshot.groundingSkip).toEqual(outcome.skip);
        expect(snapshot.groundingOutcome).toEqual(outcome);
        expect(snapshot.metadata.sources.guidance).toBe("unavailable");
        expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    test("propagates cancellation and hard reader diagnostics without downgrading them", async () => {
        const controller = new AbortController();
        const reason = new Error("operator cancelled capture");
        controller.abort(reason);
        const { calls, service } = makeReaders(makeSource(), grounded());
        await expect(
            service.capture({ ...request, signal: controller.signal }),
        ).rejects.toBe(reason);
        expect(calls).toEqual({ initialize: 0, github: 0, grounding: 0 });

        const paginationError = new Error("pagination failed at page 2");
        const diagnosticService = makeMaintenanceSnapshotService({
            githubClient: { initialize: async () => CLIENT },
            githubReader: {
                read: async () => {
                    throw paginationError;
                },
            },
            groundingReader: {
                read: async () => grounded(),
            },
        });
        await expect(diagnosticService.capture(request)).rejects.toBe(
            paginationError,
        );
    });
});