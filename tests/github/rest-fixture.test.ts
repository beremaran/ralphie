import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { makeGitHubClientService } from "../../src/github/client.ts";
import {
    IssueOrder,
    IssueSort,
    makeGitHubIssuesService,
} from "../../src/github/issues.ts";
import { makeGitHubIssueMutationsService } from "../../src/github/issue-mutations.ts";
import { makeGitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import {
    startGitHubRestFixture,
    type GitHubRestFixture,
} from "../../src/github/rest-fixture.ts";

const noopRunner = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

const labelNames = (
    labels: ReadonlyArray<string | { readonly name?: string | null }> = [],
): Array<string | undefined> =>
    labels.flatMap((label) =>
        typeof label === "string" ? [label] : label.name ? [label.name] : [],
    );

const REPOSITORY = "owner/repository";

const fixtureClient = (fixture: GitHubRestFixture): Promise<Octokit> =>
    makeGitHubClientService(noopRunner, {
        baseUrl: fixture.baseUrl,
        authToken: "fixture-test-token",
    }).initialize();

const seedRepository = (fixture: GitHubRestFixture): GitHubRestFixture =>
    fixture
        .seedIssue(REPOSITORY, {
            number: 12,
            title: "First issue",
            body: "Issue body",
            labels: ["bug", "priority"],
            updated_at: "2026-08-28T00:00:00.000Z",
        })
        .seedIssue(REPOSITORY, {
            number: 13,
            title: "Second issue",
            labels: ["bug"],
            updated_at: "2026-08-27T00:00:00.000Z",
        })
        .seedIssue(REPOSITORY, {
            number: 14,
            title: "Closed issue",
            state: "closed",
            state_reason: "completed",
            updated_at: "2026-08-26T00:00:00.000Z",
        })
        .seedComment(REPOSITORY, 12, { id: 901, body: "A bounded comment" });

describe("GitHub REST fixture", () => {
    let fixture: GitHubRestFixture;

    beforeEach(async () => {
        fixture = await startGitHubRestFixture();
    });

    afterEach(async () => {
        await fixture.close();
    });

    test("lists and paginates GitHub-shaped issues with comments through the real services", async () => {
        seedRepository(fixture);
        for (let index = 0; index < 120; index += 1) {
            fixture.seedIssue(REPOSITORY, {
                number: 1000 + index,
                title: `Bulk issue ${index}`,
                updated_at: "2026-08-25T00:00:00.000Z",
            });
        }
        const client = await fixtureClient(fixture);

        const issues = await makeGitHubIssuesService().listOpen(
            client,
            REPOSITORY,
            {
                labels: [],
                sort: IssueSort.Created,
                order: IssueOrder.Ascending,
            },
        );

        expect(issues).toHaveLength(122);
        expect(issues[0]).toMatchObject({
            number: 12,
            title: "First issue",
            url: `https://github.com/${REPOSITORY}/issues/12`,
            state: "open",
            commentCount: 1,
        });
        expect(issues[0]?.comments).toEqual([
            {
                id: 901,
                body: "A bounded comment",
                updatedAt: "2026-08-29T00:00:00.000Z",
            },
        ]);

        const listing = fixture
            .observations()
            .filter(
                (observation) =>
                    observation.method === "GET" &&
                    observation.path.startsWith(
                        `/repos/${REPOSITORY}/issues`,
                    ) &&
                    !observation.path.includes("/comments"),
            );
        expect(listing).toHaveLength(2);
        expect(
            listing.map((observation) => observation.path).join(" "),
        ).toContain("page=2");
        for (const observation of fixture.observations()) {
            expect(observation.authorization).toBe("token fixture-test-token");
            expect(observation.path).toMatch(/^\/repos\//);
        }
    });

    test("filters open issues by state and every configured label", async () => {
        seedRepository(fixture);
        const issues = await makeGitHubIssuesService().listOpen(
            await fixtureClient(fixture),
            REPOSITORY,
            {
                labels: ["BUG", "priority"],
                sort: IssueSort.Created,
                order: IssueOrder.Ascending,
            },
        );

        expect(issues.map((issue) => issue.number)).toEqual([12]);
    });

    test("creates, updates, and closes issues through the fixture", async () => {
        seedRepository(fixture);
        const mutations = makeGitHubIssueMutationsService();
        const client = await fixtureClient(fixture);

        const created = await mutations.create(client, REPOSITORY, {
            title: "New issue",
            body: "New body",
        });
        expect(created.number).toBe(15);
        expect(created.state).toBe("open");
        expect(fixture.issue(REPOSITORY, 15)?.title).toBe("New issue");

        const updated = await mutations.update(client, REPOSITORY, 15, {
            title: "Renamed issue",
        });
        expect(updated.title).toBe("Renamed issue");
        expect(fixture.issue(REPOSITORY, 15)?.title).toBe("Renamed issue");

        const closed = await mutations.close(
            client,
            REPOSITORY,
            15,
            "completed",
        );
        expect(closed.state).toBe("closed");
        expect(fixture.issue(REPOSITORY, 15)).toMatchObject({
            state: "closed",
            state_reason: "completed",
        });

        // Closing an already-closed issue with the same reason is a no-op.
        const closedAgain = await mutations.close(
            client,
            REPOSITORY,
            15,
            "completed",
        );
        expect(closedAgain.state).toBe("closed");

        const closeObservations = fixture
            .observations()
            .filter(
                (observation) =>
                    observation.method === "PATCH" &&
                    observation.path === `/repos/${REPOSITORY}/issues/15`,
            );
        expect(closeObservations.at(-1)).toMatchObject({
            method: "PATCH",
            body: { state: "closed", state_reason: "completed" },
        });
    });

    test("reconciles a close after a lost response from authoritative state", async () => {
        seedRepository(fixture);
        fixture.enqueue({
            method: "PATCH",
            path: `/repos/${REPOSITORY}/issues/12`,
            responses: [{ kind: "lost" }],
        });
        const client = await fixtureClient(fixture);

        const closed = await makeGitHubIssueMutationsService().close(
            client,
            REPOSITORY,
            12,
            "completed",
        );
        expect(closed.state).toBe("closed");
        expect(fixture.issue(REPOSITORY, 12)).toMatchObject({
            state: "closed",
            state_reason: "completed",
        });
    });

    test("forces controlled HTTP failures per operation and recovers on the next attempt", async () => {
        seedRepository(fixture);
        fixture.enqueue({
            method: "GET",
            path: `/repos/${REPOSITORY}/issues/13`,
            responses: [{ kind: "http", status: 500 }],
        });
        const client = await fixtureClient(fixture);
        const issues = makeGitHubIssuesService();

        await expect(issues.refresh(client, REPOSITORY, 13)).rejects.toThrow(
            "Failed to refresh issue #13",
        );

        // A sequence of [HTTP failure, success] drives the next close attempt
        // deterministically: the first PATCH fails (mutation not applied), the
        // follow-up attempt succeeds.
        fixture.enqueue({
            method: "PATCH",
            path: `/repos/${REPOSITORY}/issues/13`,
            responses: [{ kind: "http", status: 500 }, { kind: "success" }],
        });
        const mutations = makeGitHubIssueMutationsService();
        await expect(
            mutations.close(client, REPOSITORY, 13, "not_planned"),
        ).rejects.toThrow("Failed to close issue #13");
        const closed = await mutations.close(
            client,
            REPOSITORY,
            13,
            "not_planned",
        );
        expect(closed.state).toBe("closed");
        expect(fixture.issue(REPOSITORY, 13)?.state_reason).toBe("not_planned");
    });

    test("surfaces malformed service responses as loud failures", async () => {
        seedRepository(fixture);
        fixture.enqueue({
            method: "GET",
            path: `/repos/${REPOSITORY}/issues/13`,
            responses: [{ kind: "malformed" }],
        });
        const client = await fixtureClient(fixture);

        await expect(
            makeGitHubIssuesService().refresh(client, REPOSITORY, 13),
        ).rejects.toThrow("without a valid updated timestamp");
    });

    test("serves native sub-issue and dependency routes through client.request", async () => {
        seedRepository(fixture)
            .seedIssue(REPOSITORY, { number: 30, title: "Parent" })
            .seedIssue(REPOSITORY, { number: 31, title: "Child A" })
            .seedIssue(REPOSITORY, { number: 32, title: "Child B" })
            .seedIssue(REPOSITORY, { number: 33, title: "Child C" });
        const relationships = makeGitHubIssueRelationshipService();
        const client = await fixtureClient(fixture);

        await relationships.attachSubIssue(client, REPOSITORY, 30, 31);
        await relationships.attachSubIssue(client, REPOSITORY, 30, 32);
        // Idempotent repeat must not duplicate the attachment.
        await relationships.attachSubIssue(client, REPOSITORY, 30, 32);

        expect(
            (await relationships.parentOf(client, REPOSITORY, 31))?.number,
        ).toBe(30);
        expect(
            (await relationships.parentOf(client, REPOSITORY, 32))?.number,
        ).toBe(30);
        expect(
            (await relationships.listSubIssues(client, REPOSITORY, 30)).map(
                ({ number }) => number,
            ),
        ).toEqual([31, 32]);

        await relationships.addBlockedBy(client, REPOSITORY, 31, 32);
        await relationships.addBlockedBy(client, REPOSITORY, 31, 32);
        expect(
            (await relationships.listBlockedBy(client, REPOSITORY, 31)).map(
                ({ number }) => number,
            ),
        ).toEqual([32]);

        // A lost attach response still lands; reconciliation confirms it.
        fixture.enqueue({
            method: "POST",
            path: `/repos/${REPOSITORY}/issues/30/sub_issues`,
            responses: [{ kind: "lost" }],
        });
        await relationships.attachSubIssue(client, REPOSITORY, 30, 33);
        expect(fixture.subIssueNumbers(REPOSITORY, 30)).toContain(33);
        expect(fixture.blockedByNumbers(REPOSITORY, 31)).toEqual([32]);
    });

    test("rejects unexpected and public-shaped endpoints loudly", async () => {
        const client = await fixtureClient(fixture);
        await expect(
            client.request("GET /repos/{owner}/{repo}/pulls", {
                owner: "owner",
                repo: "repository",
            }),
        ).rejects.toThrow();

        const response = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/pulls`,
        );
        expect(response.status).toBe(500);
        const body = (await response.json()) as { readonly message?: string };
        expect(body.message).toContain("Refusing to forward");

        const root = await fetch(`${fixture.baseUrl}/`);
        expect(root.status).toBe(500);

        const rejected = fixture
            .observations()
            .find(
                (observation) =>
                    observation.path === "/repos/owner/repository/pulls",
            );
        expect(rejected).toMatchObject({
            method: "GET",
            authorization: "token fixture-test-token",
        });
    });

    test("records method, path, body, and authorization observations in memory", async () => {
        seedRepository(fixture);
        const mutations = makeGitHubIssueMutationsService();
        const client = await fixtureClient(fixture);
        await mutations.create(client, REPOSITORY, {
            title: "Observed issue",
            body: "Observed body",
        });

        const createObservation = fixture
            .observations()
            .find((observation) => observation.method === "POST");
        expect(createObservation).toMatchObject({
            method: "POST",
            path: `/repos/${REPOSITORY}/issues`,
            authorization: "token fixture-test-token",
            body: { title: "Observed issue", body: "Observed body" },
        });

        expect(fixture.takeObservations().length).toBeGreaterThan(0);
        expect(fixture.observations()).toEqual([]);
    });

    test("resets observations, sequences, and re-seeded state deterministically", async () => {
        seedRepository(fixture).seedIssue(REPOSITORY, {
            number: 40,
            title: "Reset me",
        });
        fixture.enqueue({
            method: "GET",
            path: `/repos/${REPOSITORY}/issues/40`,
            responses: [{ kind: "http", status: 503 }],
        });
        await fetch(`${fixture.baseUrl}/repos/owner/repository/issues/40`);

        fixture.reset();

        expect(fixture.observations()).toEqual([]);
        expect(fixture.issue(REPOSITORY, 12)?.title).toBe("First issue");
        expect(fixture.issue(REPOSITORY, 40)?.title).toBe("Reset me");
        const response = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/issues/40`,
        );
        expect(response.status).toBe(200);
    });

    test("runs the default fixture token through the real client seam", async () => {
        const client = await makeGitHubClientService(noopRunner, {
            baseUrl: fixture.baseUrl,
        }).initialize();
        await expect(
            client.rest.issues.get({
                owner: "owner",
                repo: "repository",
                issue_number: 1,
            }),
        ).rejects.toThrow("Not Found");
        const observed = fixture.observations().at(-1);
        expect(observed).toMatchObject({
            method: "GET",
            path: "/repos/owner/repository/issues/1",
            authorization: "token ralphie-local-fixture-token",
        });
    });

    test("sorts by comment count deterministically in both directions", async () => {
        // Seed deliberately out of comment-count order so a comparator no-op
        // (seed-order preservation) would fail the assertions below.
        fixture
            .seedIssue(REPOSITORY, { number: 61, title: "One comment" })
            .seedIssue(REPOSITORY, { number: 60, title: "No comments" })
            .seedIssue(REPOSITORY, { number: 62, title: "Two comments" })
            .seedComment(REPOSITORY, 61, { id: 800, body: "First" })
            .seedComment(REPOSITORY, 62, { id: 801, body: "Second" })
            .seedComment(REPOSITORY, 62, { id: 802, body: "Third" });
        const issues = makeGitHubIssuesService();
        const client = await fixtureClient(fixture);

        const ascending = await issues.listOpen(client, REPOSITORY, {
            labels: [],
            sort: IssueSort.Comments,
            order: IssueOrder.Ascending,
        });
        expect(ascending.map(({ number }) => number)).toEqual([60, 61, 62]);
        expect(ascending.map(({ commentCount }) => commentCount)).toEqual([
            0, 1, 2,
        ]);

        const descending = await issues.listOpen(client, REPOSITORY, {
            labels: [],
            sort: IssueSort.Comments,
            order: IssueOrder.Descending,
        });
        expect(descending.map(({ number }) => number)).toEqual([62, 61, 60]);
    });

    test("honors labels and state sent through create and update bodies", async () => {
        const client = await fixtureClient(fixture);

        const created = await client.rest.issues.create({
            owner: "owner",
            repo: "repository",
            title: "Labeled issue",
            body: "Issue body",
            labels: ["frontend", { name: "bug" }],
        });
        expect(created.data.number).toBe(1);
        expect(labelNames(created.data.labels).sort()).toEqual([
            "bug",
            "frontend",
        ]);

        // Updates carry GitHub-style replace semantics for labels.
        const relabeled = await client.rest.issues.update({
            owner: "owner",
            repo: "repository",
            issue_number: 1,
            labels: [{ name: "chore" }],
        });
        expect(labelNames(relabeled.data.labels)).toEqual(["chore"]);

        const cleared = await client.rest.issues.update({
            owner: "owner",
            repo: "repository",
            issue_number: 1,
            labels: [],
        });
        expect(labelNames(cleared.data.labels)).toEqual([]);

        const bornClosed = await client.request(
            "POST /repos/{owner}/{repo}/issues",
            {
                owner: "owner",
                repo: "repository",
                title: "Born closed",
                state: "closed",
                state_reason: "not_planned",
            },
        );
        expect(bornClosed.data).toMatchObject({
            state: "closed",
            state_reason: "not_planned",
        });
    });

    test("keeps comment counts deterministic regardless of seed order", async () => {
        fixture
            .seedComment(REPOSITORY, 77, { id: 700, body: "Early comment" })
            .seedIssue(REPOSITORY, { number: 77, title: "Late issue" });
        expect(fixture.issue(REPOSITORY, 77)?.comments).toBe(1);
    });

    test("gives a later-pushed response sequence precedence over an earlier one", async () => {
        seedRepository(fixture);
        fixture.enqueue({
            method: "GET",
            path: `/repos/${REPOSITORY}/issues/13`,
            responses: [{ kind: "http", status: 500 }],
        });
        fixture.enqueue({
            method: "GET",
            path: `/repos/${REPOSITORY}/issues/13`,
            responses: [{ kind: "http", status: 503 }],
        });
        const first = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/issues/13`,
        );
        expect(first.status).toBe(503);
        const second = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/issues/13`,
        );
        expect(second.status).toBe(500);
    });

    test("rejects non-numeric and zero pagination parameters loudly", async () => {
        seedRepository(fixture);
        for (const querystring of [
            "?page=",
            "?page=abc",
            "?page=0",
            "?per_page=0",
            "?per_page=12abc",
        ]) {
            const response = await fetch(
                `${fixture.baseUrl}/repos/owner/repository/issues${querystring}`,
            );
            expect(response.status).toBe(422);
        }
        const valid = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/issues?page=1&per_page=2`,
        );
        expect(valid.status).toBe(200);
    });

    test("rejects oversized request bodies with a loud fixture error", async () => {
        const response = await fetch(
            `${fixture.baseUrl}/repos/owner/repository/issues`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "x".repeat(2_000_000) }),
            },
        );
        expect(response.status).toBe(500);
        const body = (await response.json()) as { readonly message?: string };
        expect(body.message).toContain("exceeds 1 MiB");
    });
});