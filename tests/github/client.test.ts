import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Octokit } from "octokit";

import {
    GITHUB_REST_API_VERSION,
    GITHUB_REST_FIXTURE_TOKEN_ENV,
    GITHUB_REST_FIXTURE_URL_ENV,
    makeGitHubClientService,
} from "../../src/github/client.ts";
import type { CommandResult } from "../../src/process/command-runner.ts";

const fakeGhScript = `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' "$1 $2" "$*" "\${GH_TOKEN-<unset>}" "\${GITHUB_TOKEN-<unset>}" >> "$RALPHIE_FAKE_GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
    printf '%s\\n' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"
fi
`;

const testService = (calls: string[], results: CommandResult[]) =>
    makeGitHubClientService({
        run: async (command, args) => {
            calls.push(`${command} ${args.join(" ")}`);
            return (
                results.shift() ?? {
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                }
            );
        },
    });

type AuthenticationCase = {
    readonly ghToken: string | undefined;
    readonly githubToken: string | undefined;
    readonly expectedGh: string;
    readonly expectedGithub: string;
    readonly succeeds: boolean;
};

const setEnvironmentValue = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};

const restoreEnvironment = (
    environment: Readonly<Record<string, string | undefined>>,
): void => {
    for (const [key, value] of Object.entries(environment)) {
        setEnvironmentValue(key, value);
    }
};

const runAuthenticationCase = async (
    current: AuthenticationCase,
    logPath: string,
): Promise<void> => {
    setEnvironmentValue("GH_TOKEN", current.ghToken);
    setEnvironmentValue("GITHUB_TOKEN", current.githubToken);
    await writeFile(logPath, "");

    const initialization = makeGitHubClientService().initialize();
    if (current.succeeds) await initialization;
    else
        await expect(initialization).rejects.toThrow(
            "GitHub CLI returned an empty authentication token",
        );

    const calls = (await readFile(logPath, "utf8")).split("\n").slice(0, -1);
    expect(calls).toEqual([
        `auth status\tauth status\t${current.expectedGh}\t${current.expectedGithub}`,
        `auth token\tauth token\t${current.expectedGh}\t${current.expectedGithub}`,
    ]);
    const suppliedToken = current.ghToken || current.githubToken;
    if (suppliedToken !== undefined && suppliedToken.length > 0) {
        expect(calls.map((call) => call.split("\t")[1])).not.toContain(
            suppliedToken,
        );
    }
};

describe("GitHub client", () => {
    test("checks auth, retrieves the token, and initializes Octokit", async () => {
        const calls: string[] = [];
        const client = await testService(calls, [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "test-token", stderr: "" },
        ]).initialize();

        expect(client).toBeInstanceOf(Octokit);
        expect(GITHUB_REST_API_VERSION).toBe("2026-03-10");
        expect(calls).toEqual(["gh auth status", "gh auth token"]);
    });

    test("stops when authentication fails", async () => {
        const calls: string[] = [];
        const service = testService(calls, [
            { exitCode: 1, stdout: "", stderr: "not logged in" },
        ]);

        await expect(service.initialize()).rejects.toThrow(
            "GitHub authentication check failed",
        );
        expect(calls).toEqual(["gh auth status"]);
    });

    test("redacts tokens from authentication failures", async () => {
        const token = "private-auth-token";
        const original = process.env.GH_TOKEN;
        setEnvironmentValue("GH_TOKEN", token);
        try {
            const service = testService(
                [],
                [
                    {
                        exitCode: 1,
                        stdout: "",
                        stderr: `authentication failed for ${token}`,
                    },
                ],
            );
            const failure = await service.initialize().then(
                () => new Error("expected authentication failure"),
                (error) => error,
            );

            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).not.toContain(token);
            expect((failure as Error).message).toContain("GH_TOKEN");
        } finally {
            setEnvironmentValue("GH_TOKEN", original);
        }
    });

    test("rejects an empty token", async () => {
        const calls: string[] = [];
        const service = testService(calls, [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "", stderr: "" },
        ]);

        await expect(service.initialize()).rejects.toThrow(
            "GitHub CLI returned an empty authentication token",
        );
        expect(calls).toEqual(["gh auth status", "gh auth token"]);
    });

    test("keeps the public GitHub REST API by default with the version header", async () => {
        const calls: string[] = [];
        const client = await testService(calls, [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "default-token", stderr: "" },
        ]).initialize();

        const endpoint = client.rest.issues.get.endpoint({
            owner: "owner",
            repo: "repository",
            issue_number: 7,
        });
        expect(endpoint.url).toBe(
            "https://api.github.com/repos/owner/repository/issues/7",
        );
        expect(endpoint).toMatchObject({
            request: {
                headers: { "x-github-api-version": GITHUB_REST_API_VERSION },
            },
        });
        // The production default still runs gh CLI authentication.
        expect(calls).toEqual(["gh auth status", "gh auth token"]);
    });

    test("targets the explicit local fixture base URL only when the seam is configured", async () => {
        const calls: string[] = [];
        const runner = {
            run: async () => {
                calls.push("gh auth should never run in fixture mode");
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const client = await makeGitHubClientService(runner, {
            baseUrl: "http://127.0.0.1:43123",
            authToken: "fixture-token",
        }).initialize();

        const endpoint = client.rest.issues.listForRepo.endpoint({
            owner: "owner",
            repo: "repository",
        });
        expect(endpoint.url).toBe(
            "http://127.0.0.1:43123/repos/owner/repository/issues",
        );
        expect(calls).toEqual([]);
    });

    test("selects the local fixture path only from the test-only environment variables", async () => {
        const original = {
            [GITHUB_REST_FIXTURE_URL_ENV]:
                process.env[GITHUB_REST_FIXTURE_URL_ENV],
            [GITHUB_REST_FIXTURE_TOKEN_ENV]:
                process.env[GITHUB_REST_FIXTURE_TOKEN_ENV],
        };
        const calls: string[] = [];
        const runner = {
            run: async () => {
                calls.push("gh auth should never run in fixture mode");
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        try {
            setEnvironmentValue(
                GITHUB_REST_FIXTURE_URL_ENV,
                "http://127.0.0.1:43124",
            );
            setEnvironmentValue(
                GITHUB_REST_FIXTURE_TOKEN_ENV,
                "env-fixture-token",
            );
            const client = await makeGitHubClientService(runner).initialize();

            const endpoint = client.rest.issues.get.endpoint({
                owner: "owner",
                repo: "repository",
                issue_number: 1,
            });
            expect(endpoint.url).toBe(
                "http://127.0.0.1:43124/repos/owner/repository/issues/1",
            );
            expect(calls).toEqual([]);
        } finally {
            restoreEnvironment(original);
        }
    });

    test("refuses public or non-loopback base URLs in the test seam", () => {
        const invalidBaseUrls = [
            "https://api.github.com",
            "https://github.com",
            "http://example.com",
            "http://8.8.8.8",
            "https://127.0.0.1:443",
            "http://[::1]:1234",
            "http://127.0.0.1/base/path",
            "http://user:pass@127.0.0.1:9",
        ];
        for (const baseUrl of invalidBaseUrls) {
            expect(() =>
                makeGitHubClientService(
                    {
                        run: async () => ({
                            exitCode: 0,
                            stdout: "",
                            stderr: "",
                        }),
                    },
                    { baseUrl },
                ),
            ).toThrow();
        }
        expect(() =>
            makeGitHubClientService(
                {
                    run: async () => ({
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                    }),
                },
                { baseUrl: "https://api.github.com" },
            ),
        ).toThrow("Refusing to redirect GitHub REST traffic");

        for (const baseUrl of [
            "http://localhost:1234",
            "http://127.0.0.1:1234",
        ]) {
            expect(() =>
                makeGitHubClientService(
                    {
                        run: async () => ({
                            exitCode: 0,
                            stdout: "",
                            stderr: "",
                        }),
                    },
                    { baseUrl },
                ),
            ).not.toThrow();
        }
    });

    test("refuses a fixture auth token without a fixture URL", async () => {
        expect(() =>
            makeGitHubClientService(
                {
                    run: async () => ({
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                    }),
                },
                { authToken: "lonely-token" },
            ),
        ).toThrow("requires either a baseUrl");

        const original = process.env[GITHUB_REST_FIXTURE_TOKEN_ENV];
        try {
            setEnvironmentValue(GITHUB_REST_FIXTURE_TOKEN_ENV, "lonely-token");
            expect(() =>
                makeGitHubClientService({
                    run: async () => ({
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                    }),
                }),
            ).toThrow(`requires ${GITHUB_REST_FIXTURE_URL_ENV}`);
        } finally {
            setEnvironmentValue(GITHUB_REST_FIXTURE_TOKEN_ENV, original);
        }
    });

    test("passes GitHub.com token aliases to both gh auth commands", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-gh-auth-"));
        const executable = join(directory, "gh");
        const logPath = join(directory, "calls.log");
        const original = {
            PATH: process.env.PATH,
            GH_TOKEN: process.env.GH_TOKEN,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN,
            RALPHIE_FAKE_GH_LOG: process.env.RALPHIE_FAKE_GH_LOG,
        };
        await writeFile(executable, fakeGhScript);
        await chmod(executable, 0o755);
        process.env.PATH = `${directory}:${original.PATH ?? ""}`;
        process.env.RALPHIE_FAKE_GH_LOG = logPath;

        const cases: ReadonlyArray<AuthenticationCase> = [
            {
                ghToken: undefined,
                githubToken: undefined,
                expectedGh: "<unset>",
                expectedGithub: "<unset>",
                succeeds: false,
            },
            {
                ghToken: "",
                githubToken: "",
                expectedGh: "",
                expectedGithub: "",
                succeeds: false,
            },
            {
                ghToken: undefined,
                githubToken: "fallback-token",
                expectedGh: "fallback-token",
                expectedGithub: "fallback-token",
                succeeds: true,
            },
            {
                ghToken: "preferred-token",
                githubToken: "fallback-token",
                expectedGh: "preferred-token",
                expectedGithub: "fallback-token",
                succeeds: true,
            },
            {
                ghToken: "",
                githubToken: "fallback-token",
                expectedGh: "fallback-token",
                expectedGithub: "fallback-token",
                succeeds: true,
            },
        ];

        try {
            for (const current of cases) {
                await runAuthenticationCase(current, logPath);
            }
        } finally {
            restoreEnvironment(original);
            await rm(directory, { recursive: true, force: true });
        }
    });
});