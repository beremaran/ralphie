import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { NeedsAttentionReason } from "../../src/issues/decisions.ts";
import {
    GitHubNeedsAttentionNotificationRecoveryError,
    makeGitHubNeedsAttentionNotificationService,
    needsAttentionMarker,
    needsAttentionMarkerEnd,
    renderNeedsAttentionComment,
    type NeedsAttentionNotificationInput,
} from "../../src/github/needs-attention.ts";

const service = makeGitHubNeedsAttentionNotificationService();

const notification: NeedsAttentionNotificationInput = {
    reason: NeedsAttentionReason.MissingInformation,
    summary: "The required deployment target is not specified.",
    evidence: ["src/deploy.ts: the target is read from configuration."],
    questions: ["Which deployment target should this issue use?"],
};

type TestClient = {
    readonly rest: {
        readonly issues: {
            readonly listComments: symbol;
            readonly createComment: (
                parameters: Record<string, unknown>,
            ) => Promise<unknown>;
            readonly updateComment: (
                parameters: Record<string, unknown>,
            ) => Promise<unknown>;
            readonly addLabels: (
                parameters: Record<string, unknown>,
            ) => Promise<unknown>;
            readonly get: () => Promise<{
                readonly data: {
                    readonly labels: Array<string | { readonly name: string }>;
                };
            }>;
        };
    };
    readonly paginate: () => Promise<
        Array<{ readonly id: number; body: string }>
    >;
    readonly requests: Array<Record<string, unknown>>;
    readonly comments: Array<{ readonly id: number; body: string }>;
    readonly labels: Array<string | { readonly name: string }>;
};

const asOctokit = (client: TestClient): Octokit => client as unknown as Octokit;

const makeClient = (input?: {
    readonly comments?: Array<{ readonly id: number; body: string }>;
    readonly labels?: Array<string | { readonly name: string }>;
    readonly lostCreate?: boolean;
    readonly lostUpdate?: boolean;
    readonly labelFailure?: "lost" | "failed";
}): TestClient => {
    const comments = [...(input?.comments ?? [])];
    const labels = [...(input?.labels ?? [])];
    const requests: Array<Record<string, unknown>> = [];
    return {
        rest: {
            issues: {
                listComments: Symbol("listComments"),
                createComment: async (parameters) => {
                    requests.push({
                        operation: "createComment",
                        ...parameters,
                    });
                    comments.push({
                        id: comments.length + 1,
                        body: String(parameters.body),
                    });
                    if (input?.lostCreate) throw new Error("response lost");
                    return { data: {} };
                },
                updateComment: async (parameters) => {
                    requests.push({
                        operation: "updateComment",
                        ...parameters,
                    });
                    const comment = comments.find(
                        ({ id }) => id === parameters.comment_id,
                    );
                    if (comment) comment.body = String(parameters.body);
                    if (input?.lostUpdate) throw new Error("response lost");
                    return { data: {} };
                },
                addLabels: async (parameters) => {
                    requests.push({ operation: "addLabels", ...parameters });
                    if (input?.labelFailure === "failed") {
                        throw new Error("label unavailable");
                    }
                    for (const label of parameters.labels as string[]) {
                        if (!labels.some((value) => value === label))
                            labels.push(label);
                    }
                    if (input?.labelFailure === "lost") {
                        throw new Error("response lost");
                    }
                    return { data: [] };
                },
                get: async () => ({ data: { labels } }),
            },
        },
        paginate: async () => comments,
        requests,
        comments,
        labels,
    };
};

describe("GitHub needs-attention notifications", () => {
    test("creates one deterministic structured comment", async () => {
        const client = makeClient();

        const result = await service.notify(
            asOctokit(client),
            "https://github.com/owner/repository.git",
            42,
            notification,
        );

        expect(result).toEqual({ comment: "created", label: "not-configured" });
        expect(client.requests).toEqual([
            {
                operation: "createComment",
                owner: "owner",
                repo: "repository",
                issue_number: 42,
                body: renderNeedsAttentionComment(42, notification),
            },
        ]);
        expect(client.comments[0]?.body).toContain(
            '"reason": "missing_information"',
        );
        expect(client.comments[0]?.body).toContain(needsAttentionMarkerEnd);
    });

    test("updates the single stable marker and treats an identical body as success", async () => {
        const oldBody = `${needsAttentionMarker(42)}\nold\n${needsAttentionMarkerEnd}`;
        const client = makeClient({ comments: [{ id: 9, body: oldBody }] });

        const updated = await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            notification,
        );
        const unchanged = await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            notification,
        );

        expect(updated.comment).toBe("updated");
        expect(unchanged.comment).toBe("unchanged");
        expect(
            client.requests.filter(
                ({ operation }) => operation === "updateComment",
            ),
        ).toHaveLength(1);
        expect(client.comments).toHaveLength(1);
    });

    test("reconciles a lost create response without creating a duplicate", async () => {
        const client = makeClient({ lostCreate: true });

        await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            notification,
        );
        await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            notification,
        );

        expect(
            client.requests.filter(
                ({ operation }) => operation === "createComment",
            ),
        ).toHaveLength(1);
        expect(client.comments).toHaveLength(1);
    });

    test("reconciles a lost update response", async () => {
        const client = makeClient({
            comments: [
                {
                    id: 13,
                    body: `${needsAttentionMarker(42)}\nold\n${needsAttentionMarkerEnd}`,
                },
            ],
            lostUpdate: true,
        });

        const result = await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            notification,
        );

        expect(result.comment).toBe("updated");
        expect(client.comments).toHaveLength(1);
        expect(client.comments[0]?.body).toBe(
            renderNeedsAttentionComment(42, notification),
        );
    });

    test("fails on multiple markers without another comment", async () => {
        const client = makeClient({
            comments: [
                { id: 1, body: needsAttentionMarker(42) },
                { id: 2, body: needsAttentionMarker(42) },
            ],
        });

        await expect(
            service.notify(
                asOctokit(client),
                "owner/repository",
                42,
                notification,
            ),
        ).rejects.toBeInstanceOf(GitHubNeedsAttentionNotificationRecoveryError);
        expect(client.requests).toHaveLength(0);
    });

    test("adds only the configured label and preserves existing labels", async () => {
        const client = makeClient({ labels: ["bug", { name: "priority" }] });

        const result = await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            { ...notification, labelName: "needs-attention" },
        );

        expect(result.label).toBe("applied");
        expect(client.requests.at(-1)).toEqual({
            operation: "addLabels",
            owner: "owner",
            repo: "repository",
            issue_number: 42,
            labels: ["needs-attention"],
        });
        expect(client.labels).toEqual([
            "bug",
            { name: "priority" },
            "needs-attention",
        ]);
    });

    test("reconciles a lost label response and accepts an existing label", async () => {
        const client = makeClient({ labelFailure: "lost" });

        const result = await service.notify(
            asOctokit(client),
            "owner/repository",
            42,
            { ...notification, labelName: "needs-attention" },
        );

        expect(result.label).toBe("applied");
        expect(client.labels).toContain("needs-attention");
    });

    test("reports partial comment progress when the label cannot be applied", async () => {
        const client = makeClient({ labelFailure: "failed" });

        const error = await service
            .notify(asOctokit(client), "owner/repository", 42, {
                ...notification,
                labelName: "needs-attention",
            })
            .catch((cause) => cause);

        expect(error).toBeInstanceOf(
            GitHubNeedsAttentionNotificationRecoveryError,
        );
        expect(
            (error as GitHubNeedsAttentionNotificationRecoveryError)
                .commentPublished,
        ).toBeTrue();
        expect(client.comments).toHaveLength(1);
    });

    test("has no Codex dependency", async () => {
        const source = await readFile(
            new URL("../../src/github/needs-attention.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toMatch(/(?:agent|codex)\//i);
        expect(source).not.toContain("CodexClient");
    });

    test("validates the needs-attention decision contract", async () => {
        const client = makeClient();

        await expect(
            service.notify(asOctokit(client), "owner/repository", 42, {
                ...notification,
                evidence: [],
            }),
        ).rejects.toThrow("Invalid needs-attention notification payload");
        expect(client.requests).toHaveLength(0);
    });
});