import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    maintenanceActionBodySha256,
    maintenanceActionMarker,
    maintenanceActionMarkerOwnsBody,
    makeGitHubIssueMaintenanceService,
    normalizeMaintenanceCommentText,
    parseMaintenanceActionMarker,
    parseMaintenanceActionMarkers,
    planAdditiveLabels,
    renderMaintenanceActionComment,
    renderMaintenanceActionMarker,
    type MaintenanceMutationRequest,
} from "../../src/github/issue-maintenance.ts";
import { maintenanceActionKey } from "../../src/maintain-issues-plan.ts";
import type { MaintenanceSnapshot } from "../../src/maintain-issues-snapshot-service.ts";

const repository = "owner/repository";
const actor = "ralphie-bot";
const issueUrl = (number: number): string =>
    `https://github.com/${repository}/issues/${String(number)}`;
const commentUrl = (issueNumber: number, id: number): string =>
    `${issueUrl(issueNumber)}#issuecomment-${String(id)}`;
const fingerprint = "snapshot-fingerprint";

const response = (data: unknown): unknown => ({ data, status: 200 });

type MutableComment = {
    id: number;
    body: string;
    html_url: string;
    created_at: string;
    updated_at: string;
    user?: { login: string };
};

type MutableIssue = {
    number: number;
    title: string;
    html_url: string;
    state: "open" | "closed";
    locked: boolean;
    labels: Array<{ name: string }>;
    comments: MutableComment[];
    permissions?: Record<string, boolean>;
};

type FakeOptions = {
    readonly issue?: Partial<MutableIssue>;
    readonly labels?: ReadonlyArray<string>;
    readonly comments?: ReadonlyArray<MutableComment>;
    readonly actorLogin?: string;
    readonly repoPermissions?: Record<string, boolean>;
    readonly calls?: string[];
    readonly addLabels?: (
        issue: MutableIssue,
        labels: ReadonlyArray<string>,
    ) => unknown;
    readonly createComment?: (
        issue: MutableIssue,
        body: string,
        nextId: number,
    ) => unknown;
    readonly updateComment?: (
        issue: MutableIssue,
        commentId: number,
        body: string,
    ) => unknown;
};

const makeIssue = (options: FakeOptions = {}): MutableIssue => ({
    number: 7,
    title: "Deployment question",
    html_url: issueUrl(7),
    state: "open",
    locked: false,
    labels: [],
    comments: [...(options.comments ?? [])],
    ...(options.issue ?? {}),
});

const makeClient = (
    options: FakeOptions = {},
): { readonly client: Octokit; readonly issue: MutableIssue } => {
    const calls = options.calls ?? [];
    const issue = makeIssue(options);
    let nextCommentId =
        Math.max(0, ...issue.comments.map((comment) => comment.id)) + 1;
    const labels = [...(options.labels ?? ["bug", "Ready", "maintenance"])].map(
        (name) => ({ name }),
    );
    const issues = {
        get: async (parameters: Record<string, unknown>) => {
            calls.push("issues.get");
            expect(parameters.owner).toBe("owner");
            expect(parameters.repo).toBe("repository");
            return response({
                ...issue,
                labels: issue.labels.map((label) => ({ ...label })),
                comments: issue.comments.length,
                ...(issue.permissions === undefined
                    ? {}
                    : { permissions: issue.permissions }),
            });
        },
        listComments: async () => {
            calls.push("issues.listComments");
            return response(
                issue.comments.map((comment) => ({
                    ...comment,
                    user:
                        comment.user === undefined
                            ? undefined
                            : { ...comment.user },
                })),
            );
        },
        listLabelsForRepo: async () => {
            calls.push("issues.listLabelsForRepo");
            return response(labels.map((label) => ({ ...label })));
        },
        addLabels: async (parameters: Record<string, unknown>) => {
            calls.push("issues.addLabels");
            const requested = Array.isArray(parameters.labels)
                ? parameters.labels.filter(
                      (label): label is string => typeof label === "string",
                  )
                : [];
            const custom = options.addLabels?.(issue, requested);
            if (custom instanceof Error) throw custom;
            if (custom !== undefined) return custom;
            for (const name of requested) {
                if (
                    !issue.labels.some(
                        (label) =>
                            label.name.toLowerCase() === name.toLowerCase(),
                    )
                ) {
                    issue.labels.push({ name });
                }
            }
            return response({
                labels: issue.labels.map((label) => ({ ...label })),
            });
        },
        createComment: async (parameters: Record<string, unknown>) => {
            calls.push("issues.createComment");
            const body =
                typeof parameters.body === "string" ? parameters.body : "";
            const custom = options.createComment?.(issue, body, nextCommentId);
            if (custom instanceof Error) throw custom;
            if (custom !== undefined) return custom;
            const comment: MutableComment = {
                id: nextCommentId++,
                body,
                html_url: commentUrl(issue.number, nextCommentId - 1),
                created_at: "2026-09-05T00:00:00.000Z",
                updated_at: "2026-09-05T00:00:00.000Z",
                user: { login: options.actorLogin ?? actor },
            };
            issue.comments.push(comment);
            return response({ ...comment });
        },
        updateComment: async (parameters: Record<string, unknown>) => {
            calls.push("issues.updateComment");
            const id = parameters.comment_id;
            const body =
                typeof parameters.body === "string" ? parameters.body : "";
            const custom = options.updateComment?.(issue, Number(id), body);
            if (custom instanceof Error) throw custom;
            if (custom !== undefined) return custom;
            const comment = issue.comments.find(
                (candidate) => candidate.id === id,
            );
            if (comment === undefined) throw new Error("comment missing");
            comment.body = body;
            comment.updated_at = "2026-09-05T00:00:01.000Z";
            return response({ ...comment });
        },
    };
    const client = {
        rest: {
            issues,
            users: {
                getAuthenticated: async () => {
                    calls.push("users.getAuthenticated");
                    return response({ login: options.actorLogin ?? actor });
                },
            },
            repos: {
                get: async () => {
                    calls.push("repos.get");
                    return response({
                        permissions: options.repoPermissions,
                    });
                },
            },
        },
        paginate: async (
            endpoint: unknown,
            parameters: Record<string, unknown>,
        ) => {
            const method = endpoint as (
                input: Record<string, unknown>,
            ) => Promise<unknown>;
            const result = await method(parameters);
            return responseData(result);
        },
    } as unknown as Octokit;
    return { client, issue };
};

const responseData = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "data" in value
        ? (value as { readonly data: unknown }).data
        : undefined;

const askAction = (question = "Which deployment is affected?") => ({
    action: "ask-question" as const,
    issueNumber: 7,
    question,
    rationale: "The captured issue does not identify the deployment.",
});

const answerAction = (overrides: Record<string, unknown> = {}) => ({
    action: "answer-question" as const,
    issueNumber: 7,
    commentId: 11,
    answer: "Use the blue deployment.",
    sourceUrl: commentUrl(7, 11),
    sourceFingerprint: fingerprint,
    rationale: "The source comment supplies the answer.",
    ...overrides,
});

const addLabelsAction = (labels: ReadonlyArray<string> = ["Ready"]) => ({
    action: "add-labels" as const,
    issueNumber: 7,
    labels: [...labels],
    rationale: "The label is an additive catalog value.",
});

const request = (
    action: MaintenanceMutationRequest["action"],
    extra: Partial<MaintenanceMutationRequest> = {},
): MaintenanceMutationRequest => ({ action, ...extra });

const snapshotWithSource = (
    sourceBody = "Which deployment is affected?",
): MaintenanceSnapshot =>
    ({
        fingerprint,
        selectedIssues: [
            {
                number: 7,
                selectedThread: {
                    comments: [
                        {
                            id: 11,
                            databaseId: 11,
                            nodeId: "C_11",
                            url: commentUrl(7, 11),
                            htmlUrl: commentUrl(7, 11),
                            author: {
                                login: "human",
                                type: "User",
                                nodeId: null,
                            },
                            authorAssociation: "NONE",
                            body: sourceBody,
                            content: sourceBody,
                            createdAt: "2026-09-05T00:00:00.000Z",
                            updatedAt: "2026-09-05T00:00:00.000Z",
                            isRalphieManaged: false,
                            marker: undefined,
                        },
                    ],
                },
            },
        ],
        selectedDetails: [],
    }) as unknown as MaintenanceSnapshot;

describe("maintenance label reconciliation", () => {
    test("subtracts existing labels case-insensitively and preserves catalog spelling", () => {
        const plan = planAdditiveLabels({
            requested: ["bug", "READY"],
            current: ["BUG"],
            catalog: ["bug", "Ready", "maintenance"],
        });
        expect(plan).toMatchObject({
            status: "ready",
            exactCatalogLabels: ["bug", "Ready"],
            alreadyPresent: ["bug"],
            toAdd: ["Ready"],
        });
    });

    test("fails closed for missing, removal, duplicate, and ambiguous catalog labels", () => {
        expect(
            planAdditiveLabels({
                requested: ["missing"],
                current: [],
                catalog: ["bug"],
            }),
        ).toMatchObject({ status: "skipped", reason: "label-not-in-catalog" });
        expect(
            planAdditiveLabels({
                requested: ["-bug"],
                current: [],
                catalog: ["bug"],
            }),
        ).toMatchObject({ status: "skipped", reason: "label-not-additive" });
        expect(
            planAdditiveLabels({
                requested: ["Bug", "bug"],
                current: [],
                catalog: ["bug"],
            }),
        ).toMatchObject({ status: "skipped", reason: "duplicate-label" });
        expect(
            planAdditiveLabels({
                requested: ["bug"],
                current: [],
                catalog: ["bug", "BUG"],
            }),
        ).toMatchObject({
            status: "skipped",
            reason: "label-catalog-ambiguous",
        });
    });

    test("adds only missing exact catalog labels and never updates issue metadata", async () => {
        const calls: string[] = [];
        const { client, issue } = makeClient({
            calls,
            issue: { labels: [{ name: "BUG" }] },
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(addLabelsAction(["bug", "Ready"])),
        );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "labels-added",
            labels: ["Ready"],
        });
        expect(issue.labels.map((label) => label.name)).toEqual([
            "BUG",
            "Ready",
        ]);
        expect(calls).toEqual([
            "issues.get",
            "issues.listLabelsForRepo",
            "issues.addLabels",
        ]);
    });

    test("returns unchanged when every requested label is already present", async () => {
        const calls: string[] = [];
        const { client } = makeClient({
            calls,
            issue: { labels: [{ name: "READY" }] },
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(addLabelsAction(["ready"])),
        );
        expect(result).toMatchObject({ status: "unchanged", changed: false });
        expect(calls).not.toContain("issues.addLabels");
    });

    test("reconciles a lost label response from authoritative membership without retrying", async () => {
        const calls: string[] = [];
        const { client, issue } = makeClient({
            calls,
            addLabels: (current, labels) => {
                for (const name of labels) current.labels.push({ name });
                throw new Error("response lost");
            },
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(addLabelsAction()),
        );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "labels-added",
        });
        expect(
            calls.filter((call) => call === "issues.addLabels"),
        ).toHaveLength(1);
        expect(calls.filter((call) => call === "issues.get")).toHaveLength(2);
    });

    test("returns recovery-required when a partial label response cannot be confirmed", async () => {
        const { client } = makeClient({
            addLabels: (_issue, _labels) => response({ labels: [] }),
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(addLabelsAction()),
        );
        expect(result).toMatchObject({
            status: "recovery-required",
            operation: "add-labels",
        });
    });
});

describe("maintenance action markers", () => {
    test("parses the strict versioned marker and verifies the body digest", () => {
        const content = "managed content";
        const marker = renderMaintenanceActionMarker({
            issueNumber: 7,
            action: "ask-question",
            actionKey: "maintenance-action:test",
            bodySha256: maintenanceActionBodySha256(content),
        });
        const body = `${marker}\n${content}`;
        expect(parseMaintenanceActionMarker(body)).toMatchObject({
            version: 1,
            issueNumber: 7,
            action: "ask-question",
            actionKey: "maintenance-action:test",
        });
        const parsed = parseMaintenanceActionMarker(body);
        if (parsed === undefined) throw new Error("expected marker");
        expect(maintenanceActionMarkerOwnsBody(body, parsed)).toBe(true);
        expect(maintenanceActionMarkerOwnsBody(`${body}!`, parsed)).toBe(false);
        expect(
            parseMaintenanceActionMarkers(`${body}\n${marker}`),
        ).toHaveLength(2);
        expect(
            parseMaintenanceActionMarker(`${body}\n${marker}`),
        ).toBeUndefined();
        expect(
            parseMaintenanceActionMarker(`${marker} extra-field=x\n${content}`),
        ).toBe(undefined);
        expect(maintenanceActionMarker).toBe(renderMaintenanceActionMarker);
    });

    test("renders marker-owned question and answer bodies with stable action keys", () => {
        const question = askAction();
        const answer = answerAction();
        const questionBody = renderMaintenanceActionComment({
            action: question,
        });
        const answerBody = renderMaintenanceActionComment({ action: answer });
        expect(questionBody).toContain(
            "ralphie:maintain-action version=1 issue=7",
        );
        expect(questionBody).toContain("ask-question");
        expect(answerBody).toContain("answer-question");
        expect(answerBody).toContain("Source comment #11");
        expect(parseMaintenanceActionMarker(questionBody)?.actionKey).toBe(
            maintenanceActionKey(question),
        );
        expect(normalizeMaintenanceCommentText(" Which\n deployment? ")).toBe(
            "which deployment",
        );
    });
});

describe("maintenance comment reconciliation", () => {
    test("creates a managed question and makes an identical rerun unchanged", async () => {
        const calls: string[] = [];
        const { client, issue } = makeClient({ calls });
        const service = makeGitHubIssueMaintenanceService();
        const action = askAction();
        const first = await service.reconcile(
            client,
            repository,
            request(action, {
                authenticatedActorLogin: actor,
                snapshotFingerprint: fingerprint,
            }),
        );
        const second = await service.reconcile(
            client,
            repository,
            request(action, {
                authenticatedActorLogin: actor,
                snapshotFingerprint: fingerprint,
            }),
        );
        expect(first).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
        expect(second).toMatchObject({ status: "unchanged", commentId: 1 });
        expect(issue.comments).toHaveLength(1);
        expect(
            calls.filter((call) => call === "issues.createComment"),
        ).toHaveLength(1);
    });

    test("recreates a deleted managed comment only after live marker discovery finds no copy", async () => {
        const calls: string[] = [];
        const { client, issue } = makeClient({ calls });
        const service = makeGitHubIssueMaintenanceService();
        const action = askAction();
        const first = await service.reconcile(
            client,
            repository,
            request(action, { authenticatedActorLogin: actor }),
        );
        issue.comments.length = 0;
        const recreated = await service.reconcile(
            client,
            repository,
            request(action, { authenticatedActorLogin: actor }),
        );
        expect(first).toMatchObject({ status: "applied" });
        expect(recreated).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
        expect(
            calls.filter((call) => call === "issues.listComments"),
        ).toHaveLength(4);
        expect(
            calls.filter((call) => call === "issues.createComment"),
        ).toHaveLength(2);
    });

    test("does not duplicate an equivalent human question that already has an answer", async () => {
        const comments: MutableComment[] = [
            {
                id: 1,
                body: "Which deployment is affected?",
                html_url: commentUrl(7, 1),
                created_at: "2026-09-01T00:00:00.000Z",
                updated_at: "2026-09-01T00:00:00.000Z",
                user: { login: "human" },
            },
            {
                id: 2,
                body: "The blue deployment.",
                html_url: commentUrl(7, 2),
                created_at: "2026-09-02T00:00:00.000Z",
                updated_at: "2026-09-02T00:00:00.000Z",
                user: { login: "human" },
            },
        ];
        const calls: string[] = [];
        const { client } = makeClient({ calls, comments });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(askAction(), { authenticatedActorLogin: actor }),
        );
        expect(result).toMatchObject({
            status: "skipped",
            reason: "already-answered",
        });
        expect(calls).not.toContain("issues.createComment");
    });

    test("creates a grounded answer, then recognizes the marker on rerun", async () => {
        const source: MutableComment = {
            id: 11,
            body: "Which deployment is affected?",
            html_url: commentUrl(7, 11),
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            user: { login: "human" },
        };
        const calls: string[] = [];
        const { client, issue } = makeClient({ calls, comments: [source] });
        const service = makeGitHubIssueMaintenanceService();
        const action = answerAction();
        const first = await service.reconcile(
            client,
            repository,
            request(action, {
                authenticatedActorLogin: actor,
                snapshot: snapshotWithSource(),
            }),
        );
        const second = await service.reconcile(
            client,
            repository,
            request(action, {
                authenticatedActorLogin: actor,
                snapshot: snapshotWithSource(),
            }),
        );
        expect(first).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
        expect(second).toMatchObject({ status: "unchanged" });
        expect(issue.comments).toHaveLength(2);
        expect(
            calls.filter((call) => call === "issues.createComment"),
        ).toHaveLength(1);
    });

    test("does not duplicate an equivalent human answer", async () => {
        const source: MutableComment = {
            id: 11,
            body: "Which deployment is affected?",
            html_url: commentUrl(7, 11),
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            user: { login: "human" },
        };
        const humanAnswer: MutableComment = {
            id: 12,
            body: "Use the blue deployment.",
            html_url: commentUrl(7, 12),
            created_at: "2026-09-02T00:00:00.000Z",
            updated_at: "2026-09-02T00:00:00.000Z",
            user: { login: "human" },
        };
        const calls: string[] = [];
        const { client } = makeClient({
            calls,
            comments: [source, humanAnswer],
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(answerAction(), {
                authenticatedActorLogin: actor,
                snapshot: snapshotWithSource(),
            }),
        );
        expect(result).toMatchObject({ status: "unchanged" });
        expect(calls).not.toContain("issues.createComment");
    });

    test("updates an unedited managed comment in place but preserves human edits", async () => {
        const original = askAction();
        const oldBody = renderMaintenanceActionComment({ action: original });
        const changed = {
            ...original,
            rationale: "A more precise grounded rationale.",
        };
        const managed: MutableComment = {
            id: 21,
            body: oldBody,
            html_url: commentUrl(7, 21),
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            user: { login: actor },
        };
        const calls: string[] = [];
        const { client, issue } = makeClient({ calls, comments: [managed] });
        const service = makeGitHubIssueMaintenanceService();
        const updated = await service.reconcile(
            client,
            repository,
            request(changed, { authenticatedActorLogin: actor }),
        );
        expect(updated).toMatchObject({
            status: "applied",
            mutation: "comment-updated",
        });
        expect(issue.comments[0]?.body).toBe(
            renderMaintenanceActionComment({ action: changed }),
        );

        issue.comments[0]!.body += "\nHuman edit";
        const conflict = await service.reconcile(
            client,
            repository,
            request(changed, { authenticatedActorLogin: actor }),
        );
        expect(conflict).toMatchObject({
            status: "skipped",
            reason: "human-edited-managed-comment",
        });
        expect(
            calls.filter((call) => call === "issues.updateComment"),
        ).toHaveLength(1);
    });

    test("rejects duplicate, foreign-owner, and malformed markers without overwriting comments", async () => {
        const action = askAction();
        const body = renderMaintenanceActionComment({ action });
        const comments: MutableComment[] = [
            {
                id: 31,
                body,
                html_url: commentUrl(7, 31),
                created_at: "2026-09-01T00:00:00.000Z",
                updated_at: "2026-09-01T00:00:00.000Z",
                user: { login: actor },
            },
            {
                id: 32,
                body,
                html_url: commentUrl(7, 32),
                created_at: "2026-09-02T00:00:00.000Z",
                updated_at: "2026-09-02T00:00:00.000Z",
                user: { login: actor },
            },
        ];
        const calls: string[] = [];
        const { client } = makeClient({ calls, comments });
        const duplicate = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(action, { authenticatedActorLogin: actor }),
        );
        expect(duplicate).toMatchObject({
            status: "skipped",
            reason: "duplicate-marker",
        });
        expect(calls).not.toContain("issues.updateComment");
        expect(calls).not.toContain("issues.createComment");

        const foreignOwner = makeClient({
            calls: [],
            comments: [
                {
                    ...comments[0]!,
                    user: { login: "human" },
                },
            ],
        });
        const foreignOwnerResult =
            await makeGitHubIssueMaintenanceService().reconcile(
                foreignOwner.client,
                repository,
                request(action, { authenticatedActorLogin: actor }),
            );
        expect(foreignOwnerResult).toMatchObject({
            status: "skipped",
            reason: "managed-comment-ownership",
        });

        const foreignAction = askAction("Which region is affected?");
        const foreignMarker = makeClient({
            calls: [],
            comments: [
                {
                    ...comments[0]!,
                    body: renderMaintenanceActionComment({
                        action: foreignAction,
                    }),
                    user: { login: "human" },
                },
            ],
        });
        const foreignMarkerResult =
            await makeGitHubIssueMaintenanceService().reconcile(
                foreignMarker.client,
                repository,
                request(action, { authenticatedActorLogin: actor }),
            );
        expect(foreignMarkerResult).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
        expect(foreignMarkerResult).not.toHaveProperty("reason");

        const malformedCalls: string[] = [];
        const malformed = makeClient({
            calls: malformedCalls,
            comments: [
                {
                    ...comments[0]!,
                    body: body.replace(" -->", " extra-field=x -->"),
                    user: { login: actor },
                },
            ],
        });
        const malformedResult =
            await makeGitHubIssueMaintenanceService().reconcile(
                malformed.client,
                repository,
                request(action, { authenticatedActorLogin: actor }),
            );
        expect(malformedResult).toMatchObject({
            status: "skipped",
            reason: "marker-malformed",
        });
        expect(malformedCalls).not.toContain("issues.updateComment");
        expect(malformedCalls).not.toContain("issues.createComment");
    });

    test("refuses self-replies, stale source comments, and wrong source URLs", async () => {
        const selfSource: MutableComment = {
            id: 11,
            body: "Which deployment is affected?",
            html_url: commentUrl(7, 11),
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            user: { login: actor },
        };
        const service = makeGitHubIssueMaintenanceService();
        const self = makeClient({ comments: [selfSource] });
        expect(
            await service.reconcile(
                self.client,
                repository,
                request(answerAction(), {
                    authenticatedActorLogin: actor,
                    snapshot: snapshotWithSource(),
                }),
            ),
        ).toMatchObject({ status: "skipped", reason: "self-reply" });

        const stale = makeClient({
            comments: [
                {
                    ...selfSource,
                    user: { login: "human" },
                    body: "Changed question",
                },
            ],
        });
        expect(
            await service.reconcile(
                stale.client,
                repository,
                request(answerAction(), {
                    authenticatedActorLogin: actor,
                    snapshot: snapshotWithSource(),
                }),
            ),
        ).toMatchObject({ status: "skipped", reason: "stale-answer" });

        const wrongUrl = makeClient({
            comments: [{ ...selfSource, user: { login: "human" } }],
        });
        expect(
            await service.reconcile(
                wrongUrl.client,
                repository,
                request(answerAction({ sourceUrl: commentUrl(7, 99) }), {
                    authenticatedActorLogin: actor,
                    snapshot: snapshotWithSource(),
                }),
            ),
        ).toMatchObject({ status: "skipped", reason: "comment-url-mismatch" });

        const sourceIssueMismatch = makeClient({
            comments: [{ ...selfSource, user: { login: "human" } }],
        });
        expect(
            await service.reconcile(
                sourceIssueMismatch.client,
                repository,
                request(answerAction({ sourceIssueNumber: 8 }), {
                    authenticatedActorLogin: actor,
                    snapshot: snapshotWithSource(),
                }),
            ),
        ).toMatchObject({ status: "skipped", reason: "source-issue-mismatch" });

        const noSnapshot = makeClient({
            comments: [{ ...selfSource, user: { login: "human" } }],
        });
        expect(
            await service.reconcile(
                noSnapshot.client,
                repository,
                request(answerAction(), { authenticatedActorLogin: actor }),
            ),
        ).toMatchObject({ status: "skipped", reason: "stale-fingerprint" });
    });

    test("requires GitHub confirmation before commenting on a locked issue", async () => {
        const calls: string[] = [];
        const { client } = makeClient({ calls, issue: { locked: true } });
        const skipped = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(askAction(), { authenticatedActorLogin: actor }),
        );
        expect(skipped).toMatchObject({
            status: "skipped",
            reason: "locked-comment-permission-unknown",
        });
        expect(calls).toContain("repos.get");
        expect(calls).not.toContain("issues.createComment");

        const allowed = makeClient({
            issue: { locked: true },
            repoPermissions: { push: true },
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            allowed.client,
            repository,
            request(askAction(), { authenticatedActorLogin: actor }),
        );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
    });

    test("reconciles an ambiguous comment create and never blindly retries", async () => {
        const calls: string[] = [];
        let applied = false;
        const { client, issue } = makeClient({
            calls,
            createComment: (current, body, nextId) => {
                if (!applied) {
                    applied = true;
                    current.comments.push({
                        id: nextId,
                        body,
                        html_url: commentUrl(7, nextId),
                        created_at: "2026-09-05T00:00:00.000Z",
                        updated_at: "2026-09-05T00:00:00.000Z",
                        user: { login: actor },
                    });
                    throw new Error("lost create response");
                }
                throw new Error("must not retry");
            },
        });
        const result = await makeGitHubIssueMaintenanceService().reconcile(
            client,
            repository,
            request(askAction(), { authenticatedActorLogin: actor }),
        );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "comment-created",
        });
        expect(issue.comments).toHaveLength(1);
        expect(
            calls.filter((call) => call === "issues.createComment"),
        ).toHaveLength(1);
    });
});