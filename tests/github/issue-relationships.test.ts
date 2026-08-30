import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { makeGitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";

const issueRecord = (number: number) => ({
    id: 1_000_000 + number,
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    body: null,
    labels: [],
    state: "open",
    updated_at: "2026-08-28T00:00:00.000Z",
    comments: 0,
});

/**
 * In-memory Octokit double for the sub-issues and dependencies endpoints.
 * `failNextPost` attaches/depends successfully and then throws, simulating a
 * request that reached GitHub but whose response was lost.
 */
const makeFakeOctokit = () => {
    const parents = new Map<number, number>();
    const subIssues = new Map<number, number[]>();
    const blockedBy = new Map<number, number[]>();
    const posts = { subIssues: 0, dependencies: 0 };
    let failNextPost: "sub_issues" | "dependencies" | undefined;

    const handleParent = async (issueNumber: number) => {
        const parent = parents.get(issueNumber);
        if (parent === undefined) throw { status: 404 };
        return { data: issueRecord(parent) };
    };

    const handleSubIssues = async (
        route: string,
        parameters: Record<string, unknown>,
        issueNumber: number,
    ) => {
        if (route.startsWith("GET")) {
            return {
                data: (subIssues.get(issueNumber) ?? []).map(issueRecord),
            };
        }
        posts.subIssues += 1;
        const childNumber = Number(parameters.sub_issue_id) - 1_000_000;
        const children = subIssues.get(issueNumber) ?? [];
        children.push(childNumber);
        subIssues.set(issueNumber, children);
        parents.set(childNumber, issueNumber);
        const pending = failNextPost;
        failNextPost = undefined;
        if (pending === "sub_issues") throw { status: 500 };
        return { data: issueRecord(issueNumber) };
    };

    const handleDependencies = async (
        route: string,
        parameters: Record<string, unknown>,
        issueNumber: number,
    ) => {
        if (route.startsWith("GET")) {
            return {
                data: (blockedBy.get(issueNumber) ?? []).map(issueRecord),
            };
        }
        posts.dependencies += 1;
        const blockerNumber = Number(parameters.issue_id) - 1_000_000;
        const blockers = blockedBy.get(issueNumber) ?? [];
        blockers.push(blockerNumber);
        blockedBy.set(issueNumber, blockers);
        const pending = failNextPost;
        failNextPost = undefined;
        if (pending === "dependencies") throw { status: 500 };
        return { data: issueRecord(issueNumber) };
    };

    const request = async (
        route: string,
        parameters: Record<string, unknown>,
    ) => {
        const issueNumber = Number(parameters.issue_number);
        if (route.includes("/parent")) return await handleParent(issueNumber);
        if (route.includes("/sub_issues"))
            return await handleSubIssues(route, parameters, issueNumber);
        if (route.includes("/dependencies/blocked_by"))
            return await handleDependencies(route, parameters, issueNumber);
        throw { status: 404 };
    };

    const client = {
        rest: {
            issues: {
                get: async (parameters: Record<string, unknown>) => ({
                    data: issueRecord(Number(parameters.issue_number)),
                }),
            },
        },
        request,
    } as unknown as Octokit;
    return {
        client,
        parents,
        subIssues,
        blockedBy,
        posts,
        setFailNextPost: (v: typeof failNextPost) => (failNextPost = v),
    };
};
describe("GitHub issue relationship service", () => {
    test("reads the native parent and sub-issues", async () => {
        const fake = makeFakeOctokit();
        const service = makeGitHubIssueRelationshipService();

        expect(
            await service.parentOf(fake.client, "owner/repository", 101),
        ).toBeUndefined();
        expect(
            await service.listSubIssues(fake.client, "owner/repository", 42),
        ).toEqual([]);

        await service.attachSubIssue(fake.client, "owner/repository", 42, 101);
        await service.attachSubIssue(fake.client, "owner/repository", 42, 102);

        const parent = await service.parentOf(
            fake.client,
            "owner/repository",
            101,
        );
        expect(parent?.number).toBe(42);
        expect(
            (
                await service.listSubIssues(fake.client, "owner/repository", 42)
            ).map(({ number }) => number),
        ).toEqual([101, 102]);
    });

    test("attach is idempotent and fails closed on a conflicting parent", async () => {
        const fake = makeFakeOctokit();
        const service = makeGitHubIssueRelationshipService();
        await service.attachSubIssue(fake.client, "owner/repository", 42, 101);
        await service.attachSubIssue(fake.client, "owner/repository", 42, 101);
        expect(fake.posts.subIssues).toBe(1);

        await service.attachSubIssue(fake.client, "owner/repository", 7, 102);
        await expect(
            service.attachSubIssue(fake.client, "owner/repository", 42, 102),
        ).rejects.toThrow("already a native sub-issue of #7");
    });

    test("reconciles a sub-issue attach whose response was lost", async () => {
        const fake = makeFakeOctokit();
        const service = makeGitHubIssueRelationshipService();
        fake.setFailNextPost("sub_issues");
        // The POST failed but the attach reached GitHub; the service's
        // reconcile confirms the parent instead of re-posting.
        await service.attachSubIssue(fake.client, "owner/repository", 42, 101);
        await service.attachSubIssue(fake.client, "owner/repository", 42, 101);
        expect(fake.posts.subIssues).toBe(1);
        expect(
            (await service.parentOf(fake.client, "owner/repository", 101))
                ?.number,
        ).toBe(42);
    });

    test("adds and lists native dependencies idempotently", async () => {
        const fake = makeFakeOctokit();
        const service = makeGitHubIssueRelationshipService();

        expect(
            await service.listBlockedBy(fake.client, "owner/repository", 102),
        ).toEqual([]);
        await service.addBlockedBy(fake.client, "owner/repository", 102, 101);
        await service.addBlockedBy(fake.client, "owner/repository", 102, 101);
        expect(fake.posts.dependencies).toBe(1);
        expect(
            (
                await service.listBlockedBy(
                    fake.client,
                    "owner/repository",
                    102,
                )
            ).map(({ number }) => number),
        ).toEqual([101]);
    });

    test("reconciles a dependency whose response was lost", async () => {
        const fake = makeFakeOctokit();
        const service = makeGitHubIssueRelationshipService();
        fake.setFailNextPost("dependencies");
        await service.addBlockedBy(fake.client, "owner/repository", 102, 101);
        await service.addBlockedBy(fake.client, "owner/repository", 102, 101);
        expect(fake.posts.dependencies).toBe(1);
        expect(
            (
                await service.listBlockedBy(
                    fake.client,
                    "owner/repository",
                    102,
                )
            ).map(({ number }) => number),
        ).toEqual([101]);
    });

    test("surfaces unsupported endpoints as actionable errors", async () => {
        const unsupported = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) => ({
                        data: issueRecord(Number(parameters.issue_number)),
                    }),
                },
            },
            request: async () => {
                throw { status: 404 };
            },
        } as unknown as Octokit;
        const service = makeGitHubIssueRelationshipService();
        await expect(
            service.listSubIssues(unsupported, "owner/repository", 42),
        ).rejects.toThrow("requires GitHub sub-issues support");
        await expect(
            service.listBlockedBy(unsupported, "owner/repository", 42),
        ).rejects.toThrow("requires GitHub issue-dependencies support");
    });
});