import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type {
    MaintenanceCandidate,
    MaintenanceCandidateEvidence,
} from "../../src/maintain-issues-candidates.ts";
import type { IssueMaintenanceAction } from "../../src/maintain-issues-plan.ts";
import {
    makeGitHubIssueMaintenanceRelationshipService,
    parseMaintenanceRelationshipMarker,
    renderMaintenanceRelationshipComment,
    type MaintenanceRelationshipMutationRequest,
} from "../../src/github/issue-maintenance-relationships.ts";

const repository = "owner/repository";
const actor = "ralphie-bot";
const snapshotFingerprint = "snapshot-fingerprint";

const issueUrl = (number: number): string =>
    `https://github.com/${repository}/issues/${String(number)}`;

const commentUrl = (issueNumber: number, id: number): string =>
    `${issueUrl(issueNumber)}#issuecomment-${String(id)}`;

type MutableComment = {
    id: number;
    body: string;
    html_url: string;
    created_at: string;
    updated_at: string;
    user: { login: string };
};

type MutableIssue = {
    number: number;
    title: string;
    html_url: string;
    state: "open" | "closed";
    state_reason?: string;
    body: string | null;
    created_at: string;
    updated_at: string;
    locked: boolean;
    labels: Array<{ name: string }>;
    comments: MutableComment[];
};

type FakeClientOptions = {
    readonly issues: ReadonlyArray<MutableIssue>;
    readonly labelsCatalog?: ReadonlyArray<string>;
    readonly calls?: string[];
    readonly failCreateFor?: ReadonlyArray<number>;
    readonly ambiguousCreateFor?: ReadonlyArray<number>;
    readonly ambiguousAddLabelsFor?: ReadonlyArray<number>;
    readonly throwAfterClose?: boolean;
};

type FakeClientResult = {
    readonly client: Octokit;
    readonly issues: Map<number, MutableIssue>;
    readonly calls: string[];
};

const response = (data: unknown): unknown => ({ data, status: 200 });

const githubError = (
    status: number,
): Error & { response: { status: number } } =>
    Object.assign(new Error(`GitHub ${String(status)}`), {
        response: { status },
    });

const makeIssue = (
    number: number,
    title: string,
    overrides: Partial<MutableIssue> = {},
): MutableIssue => ({
    number,
    title,
    html_url: issueUrl(number),
    state: "open",
    body: null,
    created_at: `2026-01-${String(number).padStart(2, "0")}T00:00:00.000Z`,
    updated_at: "2026-09-05T00:00:00.000Z",
    locked: false,
    labels: [],
    comments: [],
    ...overrides,
});

const serializedIssue = (issue: MutableIssue): Record<string, unknown> => ({
    ...issue,
    labels: issue.labels.map((label) => ({ ...label })),
    comments: issue.comments.length,
});

const makeClient = (options: FakeClientOptions): FakeClientResult => {
    const calls = options.calls ?? [];
    const issues = new Map(
        options.issues.map((issue) => [issue.number, issue]),
    );
    const labelsCatalog = [...(options.labelsCatalog ?? ["bug", "duplicate"])];
    const failedCreates = new Set(options.failCreateFor ?? []);
    const ambiguousCreates = new Set(options.ambiguousCreateFor ?? []);
    const ambiguousAdds = new Set(options.ambiguousAddLabelsFor ?? []);
    let nextCommentId =
        Math.max(
            0,
            ...[...issues.values()].flatMap((issue) =>
                issue.comments.map((comment) => comment.id),
            ),
        ) + 1;
    let closeResponseLost = options.throwAfterClose === true;

    const issueFor = (number: unknown): MutableIssue => {
        const issue = issues.get(Number(number));
        if (issue === undefined) throw githubError(404);
        return issue;
    };

    const issueEndpoints = {
        get: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.get:${String(issue.number)}`);
            return response(serializedIssue(issue));
        },
        listComments: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.listComments:${String(issue.number)}`);
            return response(
                issue.comments.map((comment) => ({
                    ...comment,
                    user: { ...comment.user },
                })),
            );
        },
        listLabelsForRepo: async () => {
            calls.push("issues.listLabelsForRepo");
            return response(labelsCatalog.map((name) => ({ name })));
        },
        addLabels: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.addLabels:${String(issue.number)}`);
            const labels = Array.isArray(parameters.labels)
                ? parameters.labels.filter(
                      (label): label is string => typeof label === "string",
                  )
                : [];
            for (const name of labels) {
                if (
                    !issue.labels.some(
                        (label) =>
                            label.name.toLocaleLowerCase("en-US") ===
                            name.toLocaleLowerCase("en-US"),
                    )
                ) {
                    issue.labels.push({ name });
                }
            }
            return ambiguousAdds.has(issue.number)
                ? response({})
                : response(serializedIssue(issue));
        },
        createComment: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.createComment:${String(issue.number)}`);
            const body =
                typeof parameters.body === "string" ? parameters.body : "";
            if (failedCreates.has(issue.number)) {
                failedCreates.delete(issue.number);
                throw new Error(
                    `lost create response for #${String(issue.number)}`,
                );
            }
            const comment: MutableComment = {
                id: nextCommentId++,
                body,
                html_url: commentUrl(issue.number, nextCommentId - 1),
                created_at: "2026-09-05T00:00:01.000Z",
                updated_at: "2026-09-05T00:00:01.000Z",
                user: { login: actor },
            };
            issue.comments.push(comment);
            return ambiguousCreates.has(issue.number)
                ? response({})
                : response({ ...comment, user: { ...comment.user } });
        },
        updateComment: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.updateComment:${String(issue.number)}`);
            const comment = issue.comments.find(
                (candidate) => candidate.id === Number(parameters.comment_id),
            );
            if (comment === undefined) throw githubError(404);
            comment.body =
                typeof parameters.body === "string" ? parameters.body : "";
            comment.updated_at = "2026-09-05T00:00:02.000Z";
            return response({ ...comment, user: { ...comment.user } });
        },
        update: async (parameters: Record<string, unknown>) => {
            const issue = issueFor(parameters.issue_number);
            calls.push(`issues.update:${String(issue.number)}`);
            if (parameters.state === "closed") {
                issue.state = "closed";
                issue.state_reason =
                    typeof parameters.state_reason === "string"
                        ? parameters.state_reason
                        : undefined;
                issue.updated_at = "2026-09-05T00:00:03.000Z";
                if (closeResponseLost) {
                    closeResponseLost = false;
                    throw new Error("lost close response");
                }
            }
            return response(serializedIssue(issue));
        },
    };

    const client = {
        rest: {
            issues: issueEndpoints,
            users: {
                getAuthenticated: async () => {
                    calls.push("users.getAuthenticated");
                    return response({ login: actor });
                },
            },
            repos: {
                get: async () => {
                    calls.push("repos.get");
                    return response({ permissions: { push: true } });
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
            return responseData(await method(parameters));
        },
    } as unknown as Octokit;
    return { client, issues, calls };
};

const responseData = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "data" in value
        ? (value as { readonly data: unknown }).data
        : undefined;

const evidence: ReadonlyArray<MaintenanceCandidateEvidence> = [
    { kind: "exact-title", detail: "normalized titles match", value: null },
];

const candidateFor = (
    kind: "duplicate" | "related",
    overrides: Partial<MaintenanceCandidate> = {},
): MaintenanceCandidate => ({
    pairId: "issue:7->8",
    candidateId: "issue:7->8",
    subjectIssueNumber: 7,
    subjectUrl: issueUrl(7),
    targetIssueNumber: 8,
    targetUrl: issueUrl(8),
    targetTitle: "Canonical issue",
    targetCreatedAt: "2026-01-08T00:00:00.000Z",
    kind,
    evidenceScore: 100,
    evidence,
    canonical:
        kind === "duplicate"
            ? { status: "resolved", issueNumber: 8, source: "oldest-open" }
            : undefined,
    mutationEligible: true,
    snapshotFingerprint,
    ...overrides,
});

const duplicateAction = (
    action: "link-duplicate" | "close-duplicate" = "link-duplicate",
): IssueMaintenanceAction => {
    const common = {
        issueNumber: 7,
        targetIssueNumber: 8,
        targetUrl: issueUrl(8),
        candidateId: "issue:7->8",
        sourceFingerprint: snapshotFingerprint,
        rationale: "The candidate has deterministic duplicate evidence.",
    };
    return action === "close-duplicate"
        ? { ...common, action, reason: "duplicate" }
        : { ...common, action };
};

const relatedAction = (): IssueMaintenanceAction => ({
    action: "link-related",
    issueNumber: 7,
    targetIssueNumber: 8,
    targetUrl: issueUrl(8),
    candidateId: "issue:7->8",
    sourceFingerprint: snapshotFingerprint,
    rationale: "The candidate has deterministic relationship evidence.",
});

const requestFor = (
    action: IssueMaintenanceAction,
    candidate: MaintenanceCandidate,
): MaintenanceRelationshipMutationRequest => ({
    action: action as MaintenanceRelationshipMutationRequest["action"],
    candidate,
    snapshotFingerprint,
    authenticatedActorLogin: actor,
});

const openPair = (): ReadonlyArray<MutableIssue> => [
    makeIssue(7, "Duplicate issue"),
    makeIssue(8, "Canonical issue"),
];

describe("maintenance relationship markers", () => {
    test("renders a stable pair marker and rejects marker duplication", () => {
        const body = renderMaintenanceRelationshipComment({
            issueNumber: 7,
            targetIssueNumber: 8,
            relation: "related",
            targetUrl: issueUrl(8),
            candidateId: "issue:7->8",
            snapshotFingerprint,
            rationale: "The issues share a subsystem.",
        });
        const marker = parseMaintenanceRelationshipMarker(body);
        expect(marker).toMatchObject({
            version: 1,
            issueNumber: 7,
            relation: "related",
            targetIssueNumber: 8,
            pairKey: "relationship:related:7:8",
        });
        expect(
            parseMaintenanceRelationshipMarker(`${body}\n${body}`),
        ).toBeUndefined();
    });
});

describe("maintenance duplicate and related-issue reconciliation", () => {
    test("links one duplicate comment, preserves human links, and is idempotent", async () => {
        const fake = makeClient({ issues: openPair() });
        const service = makeGitHubIssueMaintenanceRelationshipService();
        const candidate = candidateFor("duplicate");
        const action = duplicateAction();
        const first = await service.reconcile(
            fake.client,
            repository,
            requestFor(action, candidate),
        );
        const second = await service.reconcile(
            fake.client,
            repository,
            requestFor(action, candidate),
        );
        expect(first).toMatchObject({
            status: "applied",
            mutation: "duplicate-linked",
        });
        expect(second).toMatchObject({ status: "unchanged", changed: false });
        expect(fake.issues.get(7)?.comments).toHaveLength(1);
        expect(fake.issues.get(8)?.comments).toHaveLength(0);
        expect(
            fake.calls.filter((call) => call === "issues.createComment:7"),
        ).toHaveLength(1);
        expect(fake.issues.get(7)?.comments[0]?.body).toContain(
            "This issue is a duplicate of",
        );
    });

    test("reconciles an ambiguous relationship-comment response without retrying", async () => {
        const fake = makeClient({
            issues: openPair(),
            ambiguousCreateFor: [7],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("duplicate")),
            );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "duplicate-linked",
        });
        expect(fake.issues.get(7)?.comments).toHaveLength(1);
        expect(
            fake.calls.filter((call) => call === "issues.createComment:7"),
        ).toHaveLength(1);
    });

    test("does not overwrite an equivalent human relationship", async () => {
        const fake = makeClient({
            issues: [
                makeIssue(7, "Duplicate issue", {
                    comments: [
                        {
                            id: 1,
                            body: "This is a duplicate of #8.",
                            html_url: commentUrl(7, 1),
                            created_at: "2026-09-01T00:00:00.000Z",
                            updated_at: "2026-09-01T00:00:00.000Z",
                            user: { login: "human" },
                        },
                    ],
                }),
                makeIssue(8, "Canonical issue"),
            ],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("duplicate")),
            );
        expect(result).toMatchObject({
            status: "skipped",
            reason: "human-relationship-conflict",
        });
        expect(fake.calls).not.toContain("issues.createComment:7");
        expect(fake.calls).not.toContain("issues.updateComment:7");
    });

    test("preserves a human edit to a managed relationship comment", async () => {
        const candidate = candidateFor("duplicate");
        const action = duplicateAction();
        const managedBody = renderMaintenanceRelationshipComment({
            issueNumber: 7,
            targetIssueNumber: 8,
            relation: "duplicate",
            targetUrl: issueUrl(8),
            candidateId: candidate.candidateId,
            snapshotFingerprint,
            rationale: action.rationale,
            evidence,
        });
        const fake = makeClient({
            issues: [
                makeIssue(7, "Duplicate issue", {
                    comments: [
                        {
                            id: 2,
                            body: `${managedBody}\nHuman follow-up`,
                            html_url: commentUrl(7, 2),
                            created_at: "2026-09-01T00:00:00.000Z",
                            updated_at: "2026-09-01T00:00:00.000Z",
                            user: { login: actor },
                        },
                    ],
                }),
                makeIssue(8, "Canonical issue"),
            ],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(action, candidate),
            );
        expect(result).toMatchObject({
            status: "skipped",
            reason: "human-edited-managed-comment",
        });
        expect(fake.calls).not.toContain("issues.updateComment:7");
        expect(fake.issues.get(7)?.comments[0]?.body).toContain(
            "Human follow-up",
        );
    });

    test("reconciles reciprocal related comments in issue-number order", async () => {
        const fake = makeClient({ issues: openPair() });
        const candidate = candidateFor("related");
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(relatedAction(), candidate),
            );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "related-pair-linked",
            completedSides: ["lower-issue", "higher-issue"],
        });
        expect(fake.calls.indexOf("issues.createComment:7")).toBeLessThan(
            fake.calls.indexOf("issues.createComment:8"),
        );
        expect(fake.issues.get(7)?.comments[0]?.body).toContain(
            "This issue is related to",
        );
        expect(fake.issues.get(8)?.comments[0]?.body).toContain(
            "This issue is related to",
        );
    });

    test("reports a partial related pair and resumes only the missing side", async () => {
        const fake = makeClient({ issues: openPair(), failCreateFor: [8] });
        const service = makeGitHubIssueMaintenanceRelationshipService();
        const candidate = candidateFor("related");
        const action = relatedAction();
        const partial = await service.reconcile(
            fake.client,
            repository,
            requestFor(action, candidate),
        );
        expect(partial).toMatchObject({
            status: "recovery-required",
            operation: "related-pair",
            completedSides: ["lower-issue"],
        });
        const resumed = await service.reconcile(
            fake.client,
            repository,
            requestFor(action, candidate),
        );
        expect(resumed).toMatchObject({
            status: "applied",
            mutation: "related-pair-linked",
            completedSides: ["lower-issue", "higher-issue"],
        });
        expect(
            fake.calls.filter((call) => call === "issues.createComment:7"),
        ).toHaveLength(1);
        expect(
            fake.calls.filter((call) => call === "issues.createComment:8"),
        ).toHaveLength(2);
    });

    test("skips stale, closed, missing, and invalid candidates before mutation", async () => {
        const changedTarget = makeIssue(8, "Changed canonical issue");
        const changedFake = makeClient({
            issues: [makeIssue(7, "Duplicate issue"), changedTarget],
        });
        const changed =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                changedFake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("duplicate")),
            );
        expect(changed).toMatchObject({
            status: "skipped",
            reason: "pair-changed",
        });
        expect(changedFake.calls).not.toContain("issues.createComment:7");

        const closedFake = makeClient({
            issues: [
                makeIssue(7, "Duplicate issue"),
                makeIssue(8, "Canonical issue", { state: "closed" }),
            ],
        });
        const closed =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                closedFake.client,
                repository,
                requestFor(relatedAction(), candidateFor("related")),
            );
        expect(closed).toMatchObject({
            status: "skipped",
            reason: "pair-closed",
        });

        const missingFake = makeClient({
            issues: [makeIssue(7, "Duplicate issue")],
        });
        const missing =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                missingFake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("duplicate")),
            );
        expect(missing).toMatchObject({
            status: "skipped",
            reason: "pair-missing",
        });

        const invalid =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                missingFake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("related")),
            );
        expect(invalid).toMatchObject({
            status: "skipped",
            reason: "candidate-kind-mismatch",
        });
    });

    test("closes only the duplicate, adds a cataloged label, and reconciles a lost close response", async () => {
        const fake = makeClient({ issues: openPair(), throwAfterClose: true });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(
                    duplicateAction("close-duplicate"),
                    candidateFor("duplicate"),
                ),
            );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "duplicate-closed",
        });
        expect(fake.issues.get(7)?.state).toBe("closed");
        expect(fake.issues.get(7)?.state_reason).toBe("duplicate");
        expect(fake.issues.get(7)?.labels).toEqual([{ name: "duplicate" }]);
        expect(fake.issues.get(8)?.state).toBe("open");
        expect(
            fake.calls.filter((call) => call === "issues.update:7"),
        ).toHaveLength(1);
        expect(fake.calls).toContain("issues.addLabels:7");
    });

    test("does not invent a duplicate label when the catalog does not contain one", async () => {
        const fake = makeClient({ issues: openPair(), labelsCatalog: ["bug"] });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(
                    duplicateAction("close-duplicate"),
                    candidateFor("duplicate"),
                ),
            );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "duplicate-closed",
        });
        expect(fake.calls).not.toContain("issues.addLabels:7");
    });

    test("reconciles an ambiguous duplicate-label response before closing", async () => {
        const fake = makeClient({
            issues: openPair(),
            ambiguousAddLabelsFor: [7],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(
                    duplicateAction("close-duplicate"),
                    candidateFor("duplicate"),
                ),
            );
        expect(result).toMatchObject({
            status: "applied",
            mutation: "duplicate-closed",
        });
        expect(
            fake.calls.filter((call) => call === "issues.addLabels:7"),
        ).toHaveLength(1);
        expect(
            fake.calls.filter((call) => call === "issues.update:7"),
        ).toHaveLength(1);
    });

    test("withholds closure for a reciprocal duplicate marker cycle", async () => {
        const reciprocal = renderMaintenanceRelationshipComment({
            issueNumber: 8,
            targetIssueNumber: 7,
            relation: "duplicate",
            targetUrl: issueUrl(7),
            candidateId: "issue:8->7",
            snapshotFingerprint,
            rationale: "Reciprocal marker for cycle test.",
        });
        const fake = makeClient({
            issues: [
                makeIssue(7, "Duplicate issue"),
                makeIssue(8, "Canonical issue", {
                    comments: [
                        {
                            id: 3,
                            body: reciprocal,
                            html_url: commentUrl(8, 3),
                            created_at: "2026-09-01T00:00:00.000Z",
                            updated_at: "2026-09-01T00:00:00.000Z",
                            user: { login: actor },
                        },
                    ],
                }),
            ],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(
                    duplicateAction("close-duplicate"),
                    candidateFor("duplicate"),
                ),
            );
        expect(result).toMatchObject({
            status: "skipped",
            reason: "duplicate-cycle",
        });
        expect(fake.issues.get(7)?.state).toBe("open");
        expect(fake.calls).not.toContain("issues.createComment:7");
        expect(fake.calls).not.toContain("issues.update:7");
    });

    test("does not add a duplicate link when the canonical already links back", async () => {
        const reciprocal = renderMaintenanceRelationshipComment({
            issueNumber: 8,
            targetIssueNumber: 7,
            relation: "duplicate",
            targetUrl: issueUrl(7),
            candidateId: "issue:8->7",
            snapshotFingerprint,
            rationale: "Reciprocal marker for cycle test.",
        });
        const fake = makeClient({
            issues: [
                makeIssue(7, "Duplicate issue"),
                makeIssue(8, "Canonical issue", {
                    comments: [
                        {
                            id: 4,
                            body: reciprocal,
                            html_url: commentUrl(8, 4),
                            created_at: "2026-09-01T00:00:00.000Z",
                            updated_at: "2026-09-01T00:00:00.000Z",
                            user: { login: actor },
                        },
                    ],
                }),
            ],
        });
        const result =
            await makeGitHubIssueMaintenanceRelationshipService().reconcile(
                fake.client,
                repository,
                requestFor(duplicateAction(), candidateFor("duplicate")),
            );
        expect(result).toMatchObject({
            status: "skipped",
            reason: "duplicate-cycle",
        });
        expect(fake.calls).not.toContain("issues.createComment:7");
    });
});