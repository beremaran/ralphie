/**
 * Reusable deterministic local HTTP fixture for the GitHub REST API.
 *
 * The fixture serves the GitHub-shaped issue, comment, and native
 * relationship endpoints currently exercised by `makeGitHubIssuesService`,
 * `makeGitHubIssueMutationsService`, and
 * `makeGitHubIssueRelationshipService`: issue listing with pagination, issue
 * reads, comments, create/update, close/reconciliation, and the
 * `client.request` sub-issue/dependency routes. State is deterministic and
 * kept in memory, and every request records its method, path, request body,
 * and Authorization header in memory (outside the Ralphie state volume).
 *
 * Unrecognized paths are rejected loudly so an accidental request can never
 * be proxied to the public GitHub API. Per-operation response sequences can
 * force controlled HTTP, malformed, and lost-response failures; malformed and
 * lost responses still apply the underlying mutation first, mirroring GitHub
 * reality where the request may have landed even though its response did not.
 */

import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

/** GitHub-shaped issue record served by the fixture. */
export type GitHubFixtureIssue = {
    readonly id: number;
    readonly number: number;
    readonly title: string;
    readonly html_url: string;
    readonly body: string | null;
    readonly state: "open" | "closed";
    readonly state_reason: string | null;
    readonly labels: ReadonlyArray<{ readonly name: string }>;
    readonly created_at: string;
    readonly updated_at: string;
    readonly comments: number;
    /** Absent for issues; present on pull-request-shaped records only. */
    readonly pull_request?: unknown;
};

/** Input accepted by `seedIssue`, with deterministic defaults applied. */
export type GitHubFixtureIssueInput = {
    readonly number: number;
    readonly title: string;
    readonly body?: string | null;
    readonly state?: "open" | "closed";
    readonly state_reason?: string | null;
    readonly labels?: ReadonlyArray<string>;
    readonly created_at?: string;
    readonly updated_at?: string;
};

/** GitHub-shaped issue comment record served by the fixture. */
export type GitHubFixtureComment = {
    readonly id: number;
    readonly body: string;
    readonly created_at: string;
    readonly updated_at: string;
};

/** Input accepted by `seedComment`, with deterministic defaults applied. */
export type GitHubFixtureCommentInput = {
    readonly id: number;
    readonly body: string;
    readonly created_at?: string;
    readonly updated_at?: string;
};

/** One recorded request observation, kept in memory on the fixture. */
export type GitHubFixtureObservation = {
    readonly method: string;
    /** Request target exactly as received (path plus query string). */
    readonly path: string;
    readonly authorization: string | undefined;
    /** Parsed JSON request body, or `null` when no body was sent. */
    readonly body: unknown;
};

/**
 * One response directive in an operation sequence. `malformed` and `lost`
 * still apply the underlying mutation first; `http` failures do not.
 */
export type GitHubFixtureResponseDirective =
    | { readonly kind: "success" }
    | {
          readonly kind: "http";
          readonly status: number;
          readonly body?: unknown;
      }
    | { readonly kind: "malformed" }
    | { readonly kind: "lost" };

/** A per-operation response sequence for one exact method and path. */
export type GitHubFixtureSequence = {
    readonly method: string;
    /** Exact request path without query, for example /repos/o/r/issues/12. */
    readonly path: string;
    readonly responses: ReadonlyArray<GitHubFixtureResponseDirective>;
};

/** Deterministic timestamps used when seeds do not supply their own. */
export const GITHUB_FIXTURE_BASE_TIME = "2026-01-01T00:00:00.000Z";
export const GITHUB_FIXTURE_MUTATION_TIME = "2026-08-29T00:00:00.000Z";

type MutableIssue = {
    id: number;
    number: number;
    title: string;
    html_url: string;
    body: string | null;
    state: "open" | "closed";
    state_reason: string | null;
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
    comments: number;
};

type MutableComment = {
    id: number;
    body: string;
    created_at: string;
    updated_at: string;
};

type FixtureState = {
    readonly issues: Map<string, Map<number, MutableIssue>>;
    readonly comments: Map<string, Map<number, MutableComment[]>>;
    readonly subIssues: Map<string, Set<number>>;
    readonly blockedBy: Map<string, Set<number>>;
};

type RouteResult = {
    readonly status: number;
    readonly body: unknown;
    readonly headers?: Record<string, string>;
};

type Route = {
    readonly apply: (
        query: URLSearchParams,
        body: unknown,
    ) => Promise<RouteResult>;
};

type Target = {
    readonly owner: string;
    readonly repo: string;
    readonly repository: string;
    readonly segments: ReadonlyArray<string>;
};

type SeedAction = {
    readonly kind: "issue" | "comment" | "subIssue" | "blockedBy";
    readonly repository: string;
    readonly issueNumber?: number;
    readonly input?: GitHubFixtureIssueInput | GitHubFixtureCommentInput;
    readonly childNumber?: number;
    readonly blockerNumber?: number;
};

/** A deterministic fixture failure that maps to a specific HTTP status. */
class EndpointError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body: unknown, detail: string) {
        super(`Fixture endpoint error for ${detail}: HTTP ${status}.`);
        this.status = status;
        this.body = body;
    }
}

const createFixtureState = (): FixtureState => ({
    issues: new Map(),
    comments: new Map(),
    subIssues: new Map(),
    blockedBy: new Map(),
});

const splitRepository = (
    repository: string,
): { readonly owner: string; readonly repo: string } => {
    const slug = repository.split("/");
    if (slug.length !== 2 || slug[0] === "" || slug[1] === "") {
        throw new Error(`Invalid fixture repository: ${repository}`);
    }
    return { owner: slug[0]!, repo: slug[1]! };
};

const issueHtmlUrl = (owner: string, repo: string, number: number): string =>
    `https://github.com/${owner}/${repo}/issues/${number}`;

const githubFixtureIssueFor = (
    owner: string,
    repo: string,
    input: GitHubFixtureIssueInput,
): GitHubFixtureIssue => ({
    id: input.number,
    number: input.number,
    title: input.title,
    html_url: issueHtmlUrl(owner, repo, input.number),
    body: input.body ?? "",
    state: input.state ?? "open",
    state_reason: input.state_reason ?? null,
    labels: (input.labels ?? []).map((name) => ({ name })),
    created_at: input.created_at ?? GITHUB_FIXTURE_BASE_TIME,
    updated_at: input.updated_at ?? GITHUB_FIXTURE_BASE_TIME,
    comments: 0,
});

const mutableIssueFor = (
    repository: string,
    input: GitHubFixtureIssueInput,
): MutableIssue => {
    const { owner, repo } = splitRepository(repository);
    const issue = githubFixtureIssueFor(owner, repo, input);
    return {
        ...issue,
        labels: issue.labels.map((label) => ({ name: label.name })),
    };
};

/** Build a complete GitHub-shaped issue record from sparse input. */
export const githubFixtureIssue = (
    repository: string,
    input: GitHubFixtureIssueInput,
): GitHubFixtureIssue => {
    const { owner, repo } = splitRepository(repository);
    return githubFixtureIssueFor(owner, repo, input);
};

/** Build a complete GitHub-shaped comment record from sparse input. */
export const githubFixtureComment = (
    input: GitHubFixtureCommentInput,
): GitHubFixtureComment => ({
    id: input.id,
    body: input.body,
    created_at: input.created_at ?? GITHUB_FIXTURE_BASE_TIME,
    updated_at: input.updated_at ?? GITHUB_FIXTURE_MUTATION_TIME,
});

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        request.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 1_048_576) {
                reject(new Error("Fixture request body exceeds 1 MiB."));
                // Pause instead of destroying so the server can reply with a
                // loud 500 over the still-open socket; the response carries
                // `connection: close`.
                request.pause();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8")),
        );
        request.on("error", reject);
    });

const parseBody = (text: string): unknown => {
    if (text.length === 0) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const respondJson = (
    response: ServerResponse,
    status: number,
    body: unknown,
): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        // One connection per request keeps Bun fetch from pooling stale
        // keep-alive sockets to the fixture and stalling determinism.
        connection: "close",
    });
    response.end(text);
};

const respondRaw = (
    response: ServerResponse,
    status: number,
    text: string,
): void => {
    response.writeHead(status, {
        "content-type": "application/json",
        connection: "close",
    });
    response.end(text);
};

/** Simulate a response lost before completion by closing the socket. */
const loseResponse = (response: ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"partial":');
    response.destroy();
};

const respondResult = (response: ServerResponse, result: RouteResult): void => {
    if (result.status === 204) {
        response.writeHead(204, { connection: "close" });
        response.end();
        return;
    }
    const text = JSON.stringify(result.body);
    response.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        // One connection per request keeps Bun fetch from pooling stale
        // keep-alive sockets to the fixture and stalling determinism.
        connection: "close",
        ...(result.headers ?? {}),
    });
    response.end(text);
};

const rejectedBody = (method: string, pathname: string): unknown => ({
    message:
        `Local GitHub REST fixture rejected ${method} ${pathname}: no fixture route serves this endpoint. ` +
        "Refusing to forward this request to the public GitHub API.",
});

const issueNumbers = (
    state: FixtureState,
    repository: string,
): Array<number> => {
    const repoIssues = state.issues.get(repository);
    if (repoIssues === undefined) return [];
    return [...repoIssues.keys()].sort((left, right) => left - right);
};

const nextIssueNumber = (state: FixtureState, repository: string): number => {
    const numbers = issueNumbers(state, repository);
    return numbers.length === 0 ? 1 : (numbers.at(-1) ?? 0) + 1;
};

const maxCommentId = (state: FixtureState, repository: string): number => {
    let maximum = 0;
    for (const comments of state.comments.get(repository)?.values() ?? []) {
        for (const comment of comments) maximum = Math.max(maximum, comment.id);
    }
    return maximum;
};

const nextCommentId = (state: FixtureState, repository: string): number =>
    maxCommentId(state, repository) + 1;

const syncIssueCommentCounts = (
    state: FixtureState,
    repository: string,
): void => {
    const repoIssues = state.issues.get(repository);
    if (repoIssues === undefined) return;
    for (const issue of repoIssues.values()) {
        const comments = state.comments.get(repository)?.get(issue.number);
        issue.comments = comments?.length ?? 0;
    }
};

const enforceIssueExistence = (
    state: FixtureState,
    repository: string,
    issueNumber: number,
): MutableIssue => {
    const issue = state.issues.get(repository)?.get(issueNumber);
    if (issue === undefined) {
        throw new EndpointError(
            404,
            { message: "Not Found" },
            `issue #${issueNumber}`,
        );
    }
    return issue;
};

const matchesLabelFilter = (
    issue: MutableIssue,
    labels: string | null,
): boolean => {
    if (labels === null || labels.length === 0) return true;
    const required = labels
        .split(",")
        .map((label) => label.trim().toLowerCase())
        .filter((label) => label.length > 0);
    if (required.length === 0) return true;
    const present = new Set(
        issue.labels.map((label) => label.name.toLowerCase()),
    );
    return required.every((label) => present.has(label));
};

const issueMatchesState = (
    issue: MutableIssue,
    state: string | null,
): boolean => {
    if (state === null || state === "all") return true;
    return issue.state === state;
};

const sortIssues = (
    issues: ReadonlyArray<MutableIssue>,
    sort: string | null,
    direction: string | null,
): ReadonlyArray<MutableIssue> => {
    const valueOf = (issue: MutableIssue): number => {
        if (sort === "updated") return Date.parse(issue.updated_at);
        if (sort === "comments") return issue.comments;
        return Date.parse(issue.created_at);
    };
    const ordered = [...issues].sort(
        (left, right) => valueOf(left) - valueOf(right),
    );
    return direction === "desc" ? ordered.reverse() : ordered;
};

const positiveIntegerParameter = (
    value: string | null,
    fallback: number,
    parameter: string,
): number => {
    if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value)) {
        throw new EndpointError(
            422,
            { message: "Validation Failed" },
            `pagination ${parameter}`,
        );
    }
    return Number.parseInt(value, 10);
};

const pageParameters = (
    query: URLSearchParams,
): { page: number; perPage: number } => {
    const page = positiveIntegerParameter(query.get("page"), 1, "page");
    const perPage = Math.min(
        100,
        positiveIntegerParameter(query.get("per_page"), 100, "per_page"),
    );
    return { page, perPage };
};

const paginationLink = (
    requestUrl: string,
    baseUrl: string,
    page: number,
    perPage: number,
    total: number,
): Record<string, string> | undefined => {
    if (page * perPage >= total) return undefined;
    const url = new URL(requestUrl, baseUrl);
    url.searchParams.set("page", String(page + 1));
    return { link: `<${url.toString()}>; rel="next"` };
};

const issueRecord = (issue: MutableIssue): GitHubFixtureIssue => ({
    ...issue,
    labels: issue.labels.map((label) => ({ name: label.name })),
});

const listIssuesRoute = (
    state: FixtureState,
    target: Target,
    baseUrl: string,
    requestUrl: string,
): Route => ({
    apply: async (query) => {
        const repoIssues = state.issues.get(target.repository);
        const filtered = [...(repoIssues?.values() ?? [])].filter(
            (issue) =>
                issueMatchesState(issue, query.get("state")) &&
                matchesLabelFilter(issue, query.get("labels")),
        );
        const sorted = sortIssues(
            filtered,
            query.get("sort"),
            query.get("direction"),
        );
        const { page, perPage } = pageParameters(query);
        const start = (page - 1) * perPage;
        return {
            status: 200,
            body: sorted.slice(start, start + perPage).map(issueRecord),
            headers: paginationLink(
                requestUrl,
                baseUrl,
                page,
                perPage,
                sorted.length,
            ),
        };
    },
});

const createIssueRoute = (state: FixtureState, target: Target): Route => ({
    apply: async (_query, body) => {
        const record = isRecord(body) ? body : {};
        const title = typeof record.title === "string" ? record.title : "";
        if (title.length === 0) {
            throw new EndpointError(
                422,
                { message: "Validation Failed" },
                "issue creation",
            );
        }
        const issue = mutableIssueFor(target.repository, {
            number: nextIssueNumber(state, target.repository),
            title,
            body: typeof record.body === "string" ? record.body : undefined,
            created_at: GITHUB_FIXTURE_MUTATION_TIME,
            updated_at: GITHUB_FIXTURE_MUTATION_TIME,
        });
        if (record.state === "open" || record.state === "closed") {
            applyStateAndReason(issue, record);
        }
        applyLabelsFromBody(issue, record);
        const repoIssues =
            state.issues.get(target.repository) ??
            new Map<number, MutableIssue>();
        repoIssues.set(issue.number, issue);
        state.issues.set(target.repository, repoIssues);
        return { status: 201, body: issueRecord(issue) };
    },
});

const readIssueRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async () => {
        const issue = enforceIssueExistence(
            state,
            target.repository,
            issueNumber,
        );
        return { status: 200, body: issueRecord(issue) };
    },
});

const applyTitleAndBody = (
    issue: MutableIssue,
    record: Record<string, unknown>,
): void => {
    if (typeof record.title === "string") issue.title = record.title;
    if (typeof record.body === "string") issue.body = record.body;
};

const applyStateAndReason = (
    issue: MutableIssue,
    record: Record<string, unknown>,
): void => {
    if (record.state === "open") {
        issue.state = "open";
        issue.state_reason = null;
        return;
    }
    if (record.state === "closed") {
        issue.state = "closed";
        issue.state_reason =
            typeof record.state_reason === "string"
                ? record.state_reason
                : issue.state_reason;
    }
};

const labelsFromBody = (
    record: Record<string, unknown>,
): ReadonlyArray<string> | undefined => {
    const labels = record.labels;
    if (!Array.isArray(labels)) return undefined;
    const names: string[] = [];
    for (const label of labels) {
        if (typeof label === "string" && label.length > 0) {
            names.push(label);
        } else if (isRecord(label) && typeof label.name === "string") {
            names.push(label.name);
        }
    }
    return names;
};

/** Apply GitHub-style replace semantics for labels in create/update bodies. */
const applyLabelsFromBody = (
    issue: MutableIssue,
    record: Record<string, unknown>,
): void => {
    if (!("labels" in record)) return;
    issue.labels = (labelsFromBody(record) ?? []).map((name) => ({ name }));
};

const updateIssueRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async (_query, body) => {
        const issue = enforceIssueExistence(
            state,
            target.repository,
            issueNumber,
        );
        const record = isRecord(body) ? body : {};
        applyTitleAndBody(issue, record);
        applyStateAndReason(issue, record);
        applyLabelsFromBody(issue, record);
        issue.updated_at = GITHUB_FIXTURE_MUTATION_TIME;
        return { status: 200, body: issueRecord(issue) };
    },
});

const listCommentsRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async () => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const comments =
            state.comments.get(target.repository)?.get(issueNumber) ?? [];
        return {
            status: 200,
            body: comments.map((comment) => ({ ...comment })),
        };
    },
});

const createCommentRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async (_query, body) => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const record = isRecord(body) ? body : {};
        const text = typeof record.body === "string" ? record.body : "";
        const comment = githubFixtureComment({
            id: nextCommentId(state, target.repository),
            body: text,
            updated_at: GITHUB_FIXTURE_MUTATION_TIME,
        });
        const repoComments =
            state.comments.get(target.repository) ??
            new Map<number, MutableComment[]>();
        const comments = repoComments.get(issueNumber) ?? [];
        comments.push(comment);
        repoComments.set(issueNumber, comments);
        state.comments.set(target.repository, repoComments);
        syncIssueCommentCounts(state, target.repository);
        return { status: 201, body: { ...comment } };
    },
});

const updateCommentRoute = (
    state: FixtureState,
    target: Target,
    commentId: number,
): Route => ({
    apply: async (_query, body) => {
        const record = isRecord(body) ? body : {};
        for (const comments of state.comments
            .get(target.repository)
            ?.values() ?? []) {
            const comment = comments.find(
                (candidate) => candidate.id === commentId,
            );
            if (comment !== undefined) {
                if (typeof record.body === "string") comment.body = record.body;
                comment.updated_at = GITHUB_FIXTURE_MUTATION_TIME;
                return { status: 200, body: { ...comment } };
            }
        }
        throw new EndpointError(
            404,
            { message: "Not Found" },
            `comment #${commentId}`,
        );
    },
});

const addLabelsRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async (_query, body) => {
        const issue = enforceIssueExistence(
            state,
            target.repository,
            issueNumber,
        );
        const record = isRecord(body) ? body : {};
        const labels = Array.isArray(record.labels)
            ? record.labels.filter(
                  (label): label is string => typeof label === "string",
              )
            : [];
        const existing = new Set(issue.labels.map((label) => label.name));
        for (const name of labels) {
            if (!existing.has(name)) {
                issue.labels.push({ name });
                existing.add(name);
            }
        }
        return {
            status: 200,
            body: issue.labels.map((label) => ({ ...label })),
        };
    },
});

const parentOfRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async () => {
        enforceIssueExistence(state, target.repository, issueNumber);
        for (const [parentKey, children] of state.subIssues) {
            const repository = parentKey.split("#")[0];
            const rawParent = parentKey.split("#")[1];
            if (
                repository !== target.repository ||
                !children.has(issueNumber)
            ) {
                continue;
            }
            const parent = state.issues
                .get(target.repository)
                ?.get(Number(rawParent));
            if (parent !== undefined) {
                return { status: 200, body: issueRecord(parent) };
            }
        }
        throw new EndpointError(
            404,
            { message: "Not Found" },
            `parent of #${issueNumber}`,
        );
    },
});

const listSubIssuesRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async () => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const children =
            state.subIssues.get(`${target.repository}#${issueNumber}`) ??
            new Set<number>();
        return {
            status: 200,
            body: [...children]
                .sort((left, right) => left - right)
                .flatMap((childNumber) => {
                    const child = state.issues
                        .get(target.repository)
                        ?.get(childNumber);
                    return child === undefined ? [] : [issueRecord(child)];
                }),
        };
    },
});

const attachSubIssueRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async (_query, body) => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const record = isRecord(body) ? body : {};
        const childId = Number(record.sub_issue_id ?? record.issue_id);
        if (!Number.isSafeInteger(childId) || childId <= 0) {
            throw new EndpointError(
                422,
                { message: "Validation Failed" },
                "sub-issue attachment",
            );
        }
        const key = `${target.repository}#${issueNumber}`;
        const children = state.subIssues.get(key) ?? new Set<number>();
        children.add(childId);
        state.subIssues.set(key, children);
        return { status: 201, body: {} };
    },
});

const listBlockedByRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async () => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const blockers =
            state.blockedBy.get(`${target.repository}#${issueNumber}`) ??
            new Set<number>();
        return {
            status: 200,
            body: [...blockers]
                .sort((left, right) => left - right)
                .flatMap((blockerNumber) => {
                    const blocker = state.issues
                        .get(target.repository)
                        ?.get(blockerNumber);
                    return blocker === undefined ? [] : [issueRecord(blocker)];
                }),
        };
    },
});

const addBlockedByRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
): Route => ({
    apply: async (_query, body) => {
        enforceIssueExistence(state, target.repository, issueNumber);
        const record = isRecord(body) ? body : {};
        const blockerId = Number(record.issue_id);
        if (!Number.isSafeInteger(blockerId) || blockerId <= 0) {
            throw new EndpointError(
                422,
                { message: "Validation Failed" },
                "blocked_by edge",
            );
        }
        const key = `${target.repository}#${issueNumber}`;
        const blockers = state.blockedBy.get(key) ?? new Set<number>();
        blockers.add(blockerId);
        state.blockedBy.set(key, blockers);
        return { status: 201, body: {} };
    },
});

const deleteBlockedByRoute = (
    state: FixtureState,
    target: Target,
    issueNumber: number,
    blockerId: number,
): Route => ({
    apply: async () => {
        state.blockedBy
            .get(`${target.repository}#${issueNumber}`)
            ?.delete(blockerId);
        return { status: 204, body: undefined };
    },
});

const digitsPattern = /^(?:0|[1-9]\d*)$/;

const parseTarget = (pathname: string): Target | undefined => {
    if (!pathname.startsWith("/repos/")) return undefined;
    const segments = pathname.slice("/repos/".length).split("/");
    const owner = segments[0];
    const repo = segments[1];
    if (
        owner === undefined ||
        repo === undefined ||
        owner.length === 0 ||
        repo.length === 0
    ) {
        return undefined;
    }
    return {
        owner,
        repo,
        repository: `${owner}/${repo}`,
        segments: segments.slice(2),
    };
};

type RoutePattern = {
    readonly method: string;
    /** Literal segment or "N" when the segment must be a positive integer. */
    readonly segments: ReadonlyArray<string>;
    readonly kind: string;
};

const routePatterns: ReadonlyArray<RoutePattern> = [
    { method: "GET", segments: ["issues"], kind: "list-issues" },
    { method: "POST", segments: ["issues"], kind: "create-issue" },
    { method: "GET", segments: ["issues", "N"], kind: "read-issue" },
    { method: "PATCH", segments: ["issues", "N"], kind: "update-issue" },
    {
        method: "PATCH",
        segments: ["issues", "comments", "N"],
        kind: "update-comment",
    },
    {
        method: "GET",
        segments: ["issues", "N", "comments"],
        kind: "list-comments",
    },
    {
        method: "POST",
        segments: ["issues", "N", "comments"],
        kind: "create-comment",
    },
    {
        method: "POST",
        segments: ["issues", "N", "labels"],
        kind: "add-labels",
    },
    {
        method: "GET",
        segments: ["issues", "N", "parent"],
        kind: "parent-of",
    },
    {
        method: "GET",
        segments: ["issues", "N", "sub_issues"],
        kind: "list-sub-issues",
    },
    {
        method: "POST",
        segments: ["issues", "N", "sub_issues"],
        kind: "attach-sub-issue",
    },
    {
        method: "GET",
        segments: ["issues", "N", "dependencies", "blocked_by"],
        kind: "list-blocked-by",
    },
    {
        method: "POST",
        segments: ["issues", "N", "dependencies", "blocked_by"],
        kind: "add-blocked-by",
    },
    {
        method: "DELETE",
        segments: ["issues", "N", "dependencies", "blocked_by", "N"],
        kind: "delete-blocked-by",
    },
];

const matchesPattern = (
    segments: ReadonlyArray<string>,
    pattern: RoutePattern,
): boolean =>
    segments.length === pattern.segments.length &&
    segments.every((segment, index) => {
        const expected = pattern.segments[index];
        if (expected === "N") return digitsPattern.test(segment);
        return segment === expected;
    });

type RouteCreationInput = {
    readonly state: FixtureState;
    readonly target: Target;
    readonly baseUrl: string;
    readonly requestUrl: string;
    readonly segments: ReadonlyArray<string>;
};

type RouteCreation = (input: RouteCreationInput) => Route;

const routeCreations: Readonly<Record<string, RouteCreation>> = {
    "list-issues": (input) =>
        listIssuesRoute(
            input.state,
            input.target,
            input.baseUrl,
            input.requestUrl,
        ),
    "create-issue": (input) => createIssueRoute(input.state, input.target),
    "read-issue": (input) =>
        readIssueRoute(input.state, input.target, Number(input.segments[1])),
    "update-issue": (input) =>
        updateIssueRoute(input.state, input.target, Number(input.segments[1])),
    "update-comment": (input) =>
        updateCommentRoute(
            input.state,
            input.target,
            Number(input.segments[2]),
        ),
    "list-comments": (input) =>
        listCommentsRoute(input.state, input.target, Number(input.segments[1])),
    "create-comment": (input) =>
        createCommentRoute(
            input.state,
            input.target,
            Number(input.segments[1]),
        ),
    "add-labels": (input) =>
        addLabelsRoute(input.state, input.target, Number(input.segments[1])),
    "parent-of": (input) =>
        parentOfRoute(input.state, input.target, Number(input.segments[1])),
    "list-sub-issues": (input) =>
        listSubIssuesRoute(
            input.state,
            input.target,
            Number(input.segments[1]),
        ),
    "attach-sub-issue": (input) =>
        attachSubIssueRoute(
            input.state,
            input.target,
            Number(input.segments[1]),
        ),
    "list-blocked-by": (input) =>
        listBlockedByRoute(
            input.state,
            input.target,
            Number(input.segments[1]),
        ),
    "add-blocked-by": (input) =>
        addBlockedByRoute(input.state, input.target, Number(input.segments[1])),
    "delete-blocked-by": (input) =>
        deleteBlockedByRoute(
            input.state,
            input.target,
            Number(input.segments[1]),
            Number(input.segments[4]),
        ),
};

const routeFor = (
    state: FixtureState,
    baseUrl: string,
    requestUrl: string,
    method: string,
    pathname: string,
): Route | undefined => {
    const target = parseTarget(pathname);
    if (target === undefined) return undefined;
    for (const pattern of routePatterns) {
        if (pattern.method !== method) continue;
        if (!matchesPattern(target.segments, pattern)) continue;
        const creation = routeCreations[pattern.kind];
        if (creation !== undefined) {
            return creation({
                state,
                target,
                baseUrl,
                requestUrl,
                segments: target.segments,
            });
        }
    }
    return undefined;
};

type ActiveSequence = {
    readonly method: string;
    readonly path: string;
    readonly responses: Array<GitHubFixtureResponseDirective>;
};

const takeDirective = (
    sequences: ActiveSequence[],
    method: string,
    pathname: string,
): GitHubFixtureResponseDirective | undefined => {
    // Later-pushed sequences win first, matching the documented `enqueue`
    // contract: a sequence pushed after an earlier one for the same endpoint
    // takes precedence until it is exhausted.
    const sequence = sequences.findLast(
        (candidate) =>
            candidate.method === method && candidate.path === pathname,
    );
    if (sequence === undefined) return undefined;
    const directive = sequence.responses.shift();
    if (sequence.responses.length === 0) {
        const index = sequences.indexOf(sequence);
        if (index >= 0) sequences.splice(index, 1);
    }
    return directive;
};

const respondForcedHttp = (
    response: ServerResponse,
    directive: GitHubFixtureResponseDirective,
    method: string,
    pathname: string,
): void => {
    if (directive.kind !== "http") return;
    respondJson(
        response,
        directive.status,
        directive.body ?? {
            message: `Local GitHub REST fixture forced HTTP ${directive.status} for ${method} ${pathname}.`,
        },
    );
};

type RouteApplyOutcome =
    | { readonly kind: "responded" }
    | { readonly kind: "result"; readonly result: RouteResult };

type HandleRequestInput = {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly state: FixtureState;
    readonly baseUrl: string;
    readonly observations: GitHubFixtureObservation[];
    readonly sequences: ActiveSequence[];
};

const applyRoute = async (
    input: HandleRequestInput,
    route: Route,
    method: string,
    pathname: string,
    requestUrl: string,
    body: unknown,
): Promise<RouteApplyOutcome> => {
    try {
        const query = new URL(requestUrl, input.baseUrl).searchParams;
        return {
            kind: "result",
            result: await route.apply(query, body ?? null),
        };
    } catch (error) {
        if (error instanceof EndpointError) {
            respondJson(input.response, error.status, error.body);
            return { kind: "responded" };
        }
        respondJson(input.response, 500, {
            message: `Local GitHub REST fixture failed to serve ${method} ${pathname}: ${String(error)}`,
        });
        return { kind: "responded" };
    }
};

const handleRequest = async (input: HandleRequestInput): Promise<void> => {
    const method = (input.request.method ?? "GET").toUpperCase();
    const requestUrl = input.request.url ?? "/";
    const observation: GitHubFixtureObservation = {
        method,
        path: requestUrl,
        authorization: input.request.headers.authorization,
        body: parseBody(await readBody(input.request)),
    };
    input.observations.push(observation);
    const pathname = new URL(requestUrl, input.baseUrl).pathname;
    const route = routeFor(
        input.state,
        input.baseUrl,
        requestUrl,
        method,
        pathname,
    );
    if (route === undefined) {
        respondJson(input.response, 500, rejectedBody(method, pathname));
        return;
    }
    const directive = takeDirective(input.sequences, method, pathname);
    if (directive !== undefined && directive.kind === "http") {
        respondForcedHttp(input.response, directive, method, pathname);
        return;
    }
    const outcome = await applyRoute(
        input,
        route,
        method,
        pathname,
        requestUrl,
        observation.body ?? null,
    );
    if (outcome.kind === "responded") return;
    if (directive !== undefined && directive.kind === "malformed") {
        respondRaw(input.response, 200, "not valid json {{" + "{");
        return;
    }
    if (directive !== undefined && directive.kind === "lost") {
        loseResponse(input.response);
        return;
    }
    respondResult(input.response, outcome.result);
};

export type GitHubRestFixture = {
    readonly baseUrl: string;
    readonly close: () => Promise<void>;
    /** Clear observations and sequences and rewind to the original seeds. */
    readonly reset: () => void;
    /** Append a per-operation response sequence; later matches win first. */
    readonly enqueue: (sequence: GitHubFixtureSequence) => GitHubRestFixture;
    /** A snapshot of every request observed so far. */
    readonly observations: () => ReadonlyArray<GitHubFixtureObservation>;
    /** Drain and return every request observed so far. */
    readonly takeObservations: () => ReadonlyArray<GitHubFixtureObservation>;
    readonly seedIssue: (
        repository: string,
        input: GitHubFixtureIssueInput,
    ) => GitHubRestFixture;
    readonly seedComment: (
        repository: string,
        issueNumber: number,
        input: GitHubFixtureCommentInput,
    ) => GitHubRestFixture;
    readonly seedSubIssue: (
        repository: string,
        parentNumber: number,
        childNumber: number,
    ) => GitHubRestFixture;
    readonly seedBlockedBy: (
        repository: string,
        issueNumber: number,
        blockerNumber: number,
    ) => GitHubRestFixture;
    readonly issue: (
        repository: string,
        issueNumber: number,
    ) => GitHubFixtureIssue | undefined;
    readonly comments: (
        repository: string,
        issueNumber: number,
    ) => ReadonlyArray<GitHubFixtureComment>;
    readonly subIssueNumbers: (
        repository: string,
        parentNumber: number,
    ) => ReadonlyArray<number>;
    readonly blockedByNumbers: (
        repository: string,
        issueNumber: number,
    ) => ReadonlyArray<number>;
};

/** Start a deterministic local fixture on an ephemeral loopback port. */
export const startGitHubRestFixture = async (): Promise<GitHubRestFixture> => {
    const state = createFixtureState();
    const observations: GitHubFixtureObservation[] = [];
    const sequences: ActiveSequence[] = [];
    const seeds: SeedAction[] = [];
    let baseUrl = "";
    let fixture: GitHubRestFixture;

    const applyIssueSeed = (action: SeedAction): void => {
        const repoIssues =
            state.issues.get(action.repository) ??
            new Map<number, MutableIssue>();
        const issue = mutableIssueFor(
            action.repository,
            action.input as GitHubFixtureIssueInput,
        );
        repoIssues.set(issue.number, issue);
        state.issues.set(action.repository, repoIssues);
        // Re-sync so comment counts stay correct even when a comment was
        // seeded before its issue.
        syncIssueCommentCounts(state, action.repository);
    };

    const applyCommentSeed = (action: SeedAction): void => {
        const repoComments =
            state.comments.get(action.repository) ??
            new Map<number, MutableComment[]>();
        const comments = repoComments.get(action.issueNumber ?? 0) ?? [];
        comments.push(
            githubFixtureComment(action.input as GitHubFixtureCommentInput),
        );
        repoComments.set(action.issueNumber ?? 0, comments);
        state.comments.set(action.repository, repoComments);
        syncIssueCommentCounts(state, action.repository);
    };

    const applySubIssueSeed = (action: SeedAction): void => {
        const key = `${action.repository}#${action.issueNumber}`;
        const children = state.subIssues.get(key) ?? new Set<number>();
        children.add(action.childNumber ?? 0);
        state.subIssues.set(key, children);
    };

    const applyBlockedBySeed = (action: SeedAction): void => {
        const key = `${action.repository}#${action.issueNumber}`;
        const blockers = state.blockedBy.get(key) ?? new Set<number>();
        blockers.add(action.blockerNumber ?? 0);
        state.blockedBy.set(key, blockers);
    };

    const applySeed = (action: SeedAction): void => {
        if (action.kind === "issue") {
            applyIssueSeed(action);
            return;
        }
        if (action.kind === "comment") {
            applyCommentSeed(action);
            return;
        }
        if (action.kind === "subIssue") {
            applySubIssueSeed(action);
            return;
        }
        applyBlockedBySeed(action);
    };

    const applyAllSeeds = (): void => {
        for (const action of seeds) applySeed(action);
        for (const repository of new Set(
            seeds.map((action) => action.repository),
        )) {
            syncIssueCommentCounts(state, repository);
        }
    };

    const reset = (): void => {
        observations.length = 0;
        sequences.length = 0;
        state.issues.clear();
        state.comments.clear();
        state.subIssues.clear();
        state.blockedBy.clear();
        applyAllSeeds();
    };

    const server: Server = createServer((request, response) => {
        handleRequest({
            request,
            response,
            state,
            baseUrl,
            observations,
            sequences,
        }).catch((error) => {
            if (response.writableEnded || response.destroyed) return;
            respondJson(response, 500, {
                message: `Local GitHub REST fixture failed: ${String(error)}`,
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error(
            "Local GitHub REST fixture could not bind a loopback port.",
        );
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const recordSeed = (
        action: Omit<SeedAction, "repository" | "input">,
        repository: string,
        input?: GitHubFixtureIssueInput | GitHubFixtureCommentInput,
    ): GitHubRestFixture => {
        seeds.push({ ...action, repository, input });
        applySeed({ ...action, repository, input });
        return fixture;
    };

    fixture = {
        baseUrl,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        },
        reset,
        enqueue: (sequence) => {
            sequences.push({
                method: sequence.method,
                path: sequence.path,
                responses: [...sequence.responses],
            });
            return fixture;
        },
        observations: () => [...observations],
        takeObservations: () => observations.splice(0, observations.length),
        seedIssue: (repository, input) =>
            recordSeed(
                { kind: "issue" },
                repository,
                input as GitHubFixtureIssueInput,
            ),
        seedComment: (repository, issueNumber, input) =>
            recordSeed(
                { kind: "comment", issueNumber },
                repository,
                input as GitHubFixtureCommentInput,
            ),
        seedSubIssue: (repository, parentNumber, childNumber) =>
            recordSeed(
                { kind: "subIssue", issueNumber: parentNumber, childNumber },
                repository,
            ),
        seedBlockedBy: (repository, issueNumber, blockerNumber) =>
            recordSeed(
                { kind: "blockedBy", issueNumber, blockerNumber },
                repository,
            ),
        issue: (repository, issueNumber) => {
            const issue = state.issues.get(repository)?.get(issueNumber);
            return issue === undefined ? undefined : issueRecord(issue);
        },
        comments: (repository, issueNumber) =>
            (state.comments.get(repository)?.get(issueNumber) ?? []).map(
                (comment) => ({ ...comment }),
            ),
        subIssueNumbers: (repository, parentNumber) =>
            [
                ...(state.subIssues.get(`${repository}#${parentNumber}`) ??
                    new Set<number>()),
            ].sort((left, right) => left - right),
        blockedByNumbers: (repository, issueNumber) =>
            [
                ...(state.blockedBy.get(`${repository}#${issueNumber}`) ??
                    new Set<number>()),
            ].sort((left, right) => left - right),
    };
    return fixture;
};