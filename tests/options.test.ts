import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/domain.ts";
import {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
    DEFAULT_WORKSPACE,
    resolveRalphieConfig,
    type RalphieCliOptions,
} from "../src/options.ts";
import { parseSetOverride } from "../src/config/resolve.ts";
import { fakeConfigSource, fakeGitHubLogin } from "./shared/config-source.ts";

const resolve = async (
    options: RalphieCliOptions,
    document: unknown = {},
    login = "gh-user",
) =>
    resolveRalphieConfig({
        options,
        file: await fakeConfigSource(document).load(),
        login: fakeGitHubLogin(login).currentLogin,
    });

describe("configuration resolution", () => {
    test("requires a repository argument", async () => {
        await expect(resolve({})).rejects.toThrow("Missing repository");
    });

    test("resolves built-in defaults from an empty config", async () => {
        expect(await resolve({ repo: "owner/repo" })).toEqual({
            repo: "owner/repo",
            maxDecompositionDepth: DEFAULT_MAX_DECOMPOSITION_DEPTH,
            implementationAttempts: DEFAULT_IMPLEMENTATION_ATTEMPTS,
            reviewRounds: 5,
            verificationFixes: 5,
            notificationsEnabled: false,
            issueLabels: [],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
            labels: {
                "needs-triage": "needs-triage",
                "needs-info": "needs-info",
                "ready-for-agent": "ready-for-agent",
                "ready-for-human": "ready-for-human",
                wontfix: "wontfix",
            },
            verificationCommands: [],
            agent: "build",
            workspace: DEFAULT_WORKSPACE,
            json: false,
        });
    });

    test("applies top-level config, then the repos entry, then --set", async () => {
        const document = {
            workspace: "/work",
            labels: { "ready-for-agent": "afk" },
            limits: { reviewRounds: 4, implementationAttempts: 2 },
            repos: {
                "owner/repo": {
                    branch: "develop",
                    verify: ["bun run check"],
                    limits: { reviewRounds: 3 },
                },
                "other/repo": { branch: "never" },
            },
        };
        const config = await resolve(
            {
                repo: "owner/repo",
                overrides: [
                    parseSetOverride("limits.implementationAttempts=9"),
                    parseSetOverride('repos."owner/repo".workspace=/set'),
                    parseSetOverride('repos."other/repo".branch=nope'),
                ],
            },
            document,
        );
        expect(config).toMatchObject({
            repo: "owner/repo",
            branch: "develop",
            workspace: "/set",
            verificationCommands: ["bun run check"],
            reviewRounds: 3,
            implementationAttempts: 9,
            labels: { "ready-for-agent": "afk", wontfix: "wontfix" },
        });
    });

    test("--set beats a repos entry for the same top-level key", async () => {
        const config = await resolve(
            {
                repo: "owner/repo",
                overrides: [parseSetOverride("limits.reviewRounds=2")],
            },
            { repos: { "owner/repo": { limits: { reviewRounds: 8 } } } },
        );
        expect(config.reviewRounds).toBe(2);
    });

    test("matches repos entries case-insensitively and normalizes clone URLs", async () => {
        const config = await resolve(
            { repo: "https://github.com/Owner/Repo.git" },
            { repos: { "owner/repo": { branch: "develop" } } },
        );
        expect(config).toMatchObject({ repo: "Owner/Repo", branch: "develop" });
    });

    test("parses intake sort and required labels", async () => {
        expect(
            await resolve(
                { repo: "o/r" },
                {
                    intake: {
                        requireLabels: ["backend"],
                        sort: "updated:desc",
                    },
                },
            ),
        ).toMatchObject({
            issueLabels: ["backend"],
            issueSort: IssueSort.Updated,
            issueOrder: IssueOrder.Descending,
        });
    });

    test("owner defaults to defaultOwner, then the gh login", async () => {
        expect(
            await resolve({ repo: "widgets" }, { defaultOwner: "acme" }),
        ).toMatchObject({ repo: "acme/widgets" });
        expect(await resolve({ repo: "widgets" }, {}, "me")).toMatchObject({
            repo: "me/widgets",
        });
        expect(
            await resolve(
                {
                    repo: "widgets",
                    overrides: [parseSetOverride("defaultOwner=cli")],
                },
                { defaultOwner: "acme" },
            ),
        ).toMatchObject({ repo: "cli/widgets" });
    });

    test("does not look up the gh user when the owner is explicit", async () => {
        let lookups = 0;
        await resolveRalphieConfig({
            options: { repo: "owner/repo" },
            file: await fakeConfigSource({}).load(),
            login: async () => {
                lookups += 1;
                return "gh-user";
            },
        });
        expect(lookups).toBe(0);
    });

    test("rejects invalid repositories", async () => {
        await expect(resolve({ repo: "a/b/c" })).rejects.toThrow(
            "Invalid GitHub repository",
        );
    });

    test("rejects a notification label without notification opt-in", async () => {
        await expect(
            resolve({ repo: "owner/repo", needsAttentionLabel: "x" }),
        ).rejects.toThrow("requires --notify-needs-attention");
    });

    test("carries the temporary notification, model and output options", async () => {
        expect(
            await resolve({
                repo: "owner/repo",
                notifyNeedsAttention: true,
                needsAttentionLabel: "  blocked ",
                model: { providerID: "openai", modelID: "gpt-5" },
                thinking: "high",
                json: true,
            }),
        ).toMatchObject({
            notificationsEnabled: true,
            needsAttentionLabel: "blocked",
            model: { providerID: "openai", modelID: "gpt-5" },
            thinking: "high",
            json: true,
        });
    });
});

describe("configuration validation", () => {
    const messageFor = async (
        document: unknown,
        overrides: ReadonlyArray<string> = [],
    ): Promise<string> => {
        try {
            await resolve(
                {
                    repo: "owner/repo",
                    overrides: overrides.map(parseSetOverride),
                },
                document,
            );
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error("expected resolution to fail");
    };

    test("names the exact path of an unknown key", async () => {
        expect(await messageFor({ limits: { reviewRoundz: 2 } })).toContain(
            "limits.reviewRoundz: unknown key",
        );
        expect(await messageFor({ typo: true })).toContain("typo: unknown key");
        expect(
            await messageFor({ repos: { "owner/repo": { brnch: "x" } } }),
        ).toContain('repos."owner/repo".brnch: unknown key');
    });

    test("names the path of wrong types and unknown values", async () => {
        const message = await messageFor({
            limits: { reviewRounds: 0 },
            intake: { sort: "newest" },
            labels: { "ready-for-agent": "" },
            workspace: 5,
        });
        expect(message).toContain("limits.reviewRounds");
        expect(message).toContain("intake.sort");
        expect(message).toContain("labels.ready-for-agent");
        expect(message).toContain("workspace");
    });

    test("rejects malformed and duplicate repository keys", async () => {
        expect(await messageFor({ repos: { norepo: {} } })).toContain(
            "repos.norepo",
        );
        expect(await messageFor({ repos: { "A/b": {}, "a/B": {} } })).toContain(
            "duplicates",
        );
    });

    test("rejects a non-mapping configuration", async () => {
        expect(await messageFor(["a"])).toContain("Invalid configuration");
    });

    test("validates --set overrides, including ones for other repositories", async () => {
        expect(await messageFor({}, ["limits.nope=1"])).toContain(
            "limits.nope: unknown key",
        );
        expect(await messageFor({}, ['repos."other/repo".branch=1'])).toContain(
            'repos."other/repo".branch',
        );
        expect(
            await messageFor({ workspace: "/w" }, ["workspace.x=1"]),
        ).toContain("not a mapping");
    });
});

describe("--set parsing", () => {
    test("splits dotted paths and quoted keys that contain slashes or dots", () => {
        expect(
            parseSetOverride('repos."my.org/my.repo".branch=main').path,
        ).toEqual(["repos", "my.org/my.repo", "branch"]);
    });

    test("parses JSON values and falls back to literal text", () => {
        expect(parseSetOverride("a=3").value).toBe(3);
        expect(parseSetOverride("a=true").value).toBe(true);
        expect(parseSetOverride('a=["x","y"]').value).toEqual(["x", "y"]);
        expect(parseSetOverride("a=/tmp/work").value).toBe("/tmp/work");
        expect(parseSetOverride("a=x=y").value).toBe("x=y");
    });

    test("rejects missing values and empty segments", () => {
        expect(() => parseSetOverride("a.b")).toThrow("path=value");
        expect(() => parseSetOverride("a..b=1")).toThrow("empty segments");
        expect(() => parseSetOverride('a."b=1')).toThrow("unterminated quote");
    });
});