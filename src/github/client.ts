import { Octokit } from "octokit";

import {
    CommandRunnerLive,
    requireSuccess,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type GitHubClientService = {
    readonly initialize: () => Promise<Octokit>;
};

/** Current GitHub REST contract; 2022-11-28 retires on 2028-03-10. */
export const GITHUB_REST_API_VERSION = "2026-03-10";

/**
 * Environment name selecting the test-only local GitHub REST fixture. The
 * production command never sets it; an operator selects the fixture path for
 * disposable local scenarios by setting it on the same process boundary that
 * already supplies GH_TOKEN/GITHUB_TOKEN.
 */
export const GITHUB_REST_FIXTURE_URL_ENV = "RALPHIE_GITHUB_REST_FIXTURE_URL";
/** Environment name supplying the Authorization token for that fixture. */
export const GITHUB_REST_FIXTURE_TOKEN_ENV =
    "RALPHIE_GITHUB_REST_FIXTURE_TOKEN";
/** Deterministic token presented to the fixture when none is configured. */
export const GITHUB_REST_FIXTURE_DEFAULT_TOKEN = "ralphie-local-fixture-token";

/**
 * Explicit test-only client seam. Passing `baseUrl` switches the client from
 * `gh` CLI authentication to a deterministic fixture token and redirects REST
 * requests to exactly that URL; it is never used by ordinary production
 * construction. The base URL must be a loopback `http` host so a real public
 * GitHub request is impossible when the seam is in use.
 */
export type GitHubClientOptions = {
    readonly baseUrl?: string;
    readonly authToken?: string;
};

/** The resolved test-only fixture selection used instead of production auth. */
export type GitHubFixtureSelection = {
    readonly baseUrl: string;
    readonly authToken: string;
};

const githubAuthenticationContract =
    "Set GH_TOKEN (preferred) or GITHUB_TOKEN for github.com; interactive `gh auth login` and a mounted GitHub CLI profile are not required.";

const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.length === 0 ? undefined : value;

const fixtureHosts = new Set(["localhost", "127.0.0.1"]);

/**
 * Reject any test base URL that could reach a real public GitHub service.
 * Only an `http://` loopback host with no credentials and no base path is
 * accepted, so an accidental real request fails at construction instead of
 * escaping to the network.
 */
export const validateGitHubFixtureBaseUrl = (baseUrl: string): string => {
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new RalphieError({
            message: `Invalid base URL for the test-only GitHub REST fixture: ${baseUrl}.`,
        });
    }
    if (parsed.protocol !== "http:" || !fixtureHosts.has(parsed.hostname)) {
        throw new RalphieError({
            message: `Refusing to redirect GitHub REST traffic: the test-only fixture must be an http:// loopback URL (localhost or 127.0.0.1), not ${baseUrl}.`,
        });
    }
    if (parsed.username !== "" || parsed.password !== "") {
        throw new RalphieError({
            message: `Refusing to redirect GitHub REST traffic: the test-only fixture URL must not embed credentials: ${baseUrl}.`,
        });
    }
    if (parsed.pathname !== "" && parsed.pathname !== "/") {
        throw new RalphieError({
            message: `Refusing to redirect GitHub REST traffic: the test-only fixture URL must not carry a base path: ${baseUrl}.`,
        });
    }
    return baseUrl.replace(/\/$/, "");
};

/**
 * Resolve the test-only fixture selection from explicit options or the
 * test-only environment variables. Returns `undefined` (production `gh`
 * authentication) when no test configuration is present at all; a fixture
 * token without a fixture URL is a misconfiguration and fails loudly.
 */
export const resolveGitHubFixtureSelection = (
    options: GitHubClientOptions = {},
    environment: Readonly<Record<string, string | undefined>> = process.env,
): GitHubFixtureSelection | undefined => {
    if (options.baseUrl !== undefined) {
        return {
            baseUrl: validateGitHubFixtureBaseUrl(options.baseUrl),
            authToken: options.authToken ?? GITHUB_REST_FIXTURE_DEFAULT_TOKEN,
        };
    }
    if (options.authToken !== undefined) {
        throw new RalphieError({
            message: `A GitHub REST fixture auth token requires either a baseUrl or ${GITHUB_REST_FIXTURE_URL_ENV}.`,
        });
    }
    const fixtureUrl = nonEmpty(environment[GITHUB_REST_FIXTURE_URL_ENV]);
    if (fixtureUrl !== undefined) {
        return {
            baseUrl: validateGitHubFixtureBaseUrl(fixtureUrl),
            authToken:
                nonEmpty(environment[GITHUB_REST_FIXTURE_TOKEN_ENV]) ??
                GITHUB_REST_FIXTURE_DEFAULT_TOKEN,
        };
    }
    if (nonEmpty(environment[GITHUB_REST_FIXTURE_TOKEN_ENV]) !== undefined) {
        throw new RalphieError({
            message: `${GITHUB_REST_FIXTURE_TOKEN_ENV} requires ${GITHUB_REST_FIXTURE_URL_ENV}.`,
        });
    }
    return undefined;
};

/**
 * Normalize the GitHub.com token aliases at the process boundary. The token
 * remains an environment value; it is never added to the gh argument list.
 */
export const githubAuthenticationEnvironment = (
    environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> => {
    const token =
        nonEmpty(environment.GH_TOKEN) ?? nonEmpty(environment.GITHUB_TOKEN);
    return token === undefined ? {} : { GH_TOKEN: token };
};

export const makeGitHubClientService = (
    runner: CommandRunnerService = CommandRunnerLive,
    options: GitHubClientOptions = {},
): GitHubClientService => {
    // Explicit test configuration is resolved eagerly so a public or
    // malformed fixture URL fails immediately, before any request could leak.
    const fixtureSelection = resolveGitHubFixtureSelection(options);
    return {
        initialize: async () => {
            if (fixtureSelection !== undefined) {
                try {
                    return new Octokit({
                        auth: fixtureSelection.authToken,
                        baseUrl: fixtureSelection.baseUrl,
                        // The fixture owns deterministic response sequences;
                        // internal retries would consume them unpredictably and
                        // write throttling would insert artificial delays.
                        retry: { enabled: false },
                        throttle: { enabled: false },
                        request: {
                            headers: {
                                "x-github-api-version": GITHUB_REST_API_VERSION,
                            },
                        },
                    });
                } catch (cause) {
                    throw new RalphieError({
                        message:
                            "Failed to initialize the local GitHub REST fixture client.",
                        cause,
                    });
                }
            }
            const authOptions = {
                env: githubAuthenticationEnvironment(),
            };
            await requireSuccess(
                runner,
                "gh",
                ["auth", "status"],
                `GitHub authentication check failed. ${githubAuthenticationContract}`,
                authOptions,
            );

            const tokenResult = await requireSuccess(
                runner,
                "gh",
                ["auth", "token"],
                `Could not retrieve the GitHub authentication token. ${githubAuthenticationContract}`,
                authOptions,
            );
            const authToken = tokenResult.stdout.trim();
            if (!authToken) {
                throw new RalphieError({
                    message: `GitHub CLI returned an empty authentication token. ${githubAuthenticationContract}`,
                });
            }

            try {
                return new Octokit({
                    auth: authToken,
                    request: {
                        headers: {
                            "x-github-api-version": GITHUB_REST_API_VERSION,
                        },
                    },
                });
            } catch (cause) {
                throw new RalphieError({
                    message: "Failed to initialize Octokit.",
                    cause,
                });
            }
        },
    };
};

export const GitHubClientLive = makeGitHubClientService;