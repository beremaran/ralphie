/**
 * Shared low-level GitHub reconciliation mechanics for maintenance adapters.
 *
 * Both the issue-maintenance and relationship-reconciliation adapters perform
 * the same raw GitHub plumbing: unwrap `{ data }` responses, extract status
 * codes and diagnostics, detect aborts, resolve repository slugs, look up the
 * authenticated actor, and decide whether a locked issue may receive a
 * comment. Those mechanics live here exactly once. Action policies and state
 * machines stay in their owning adapters.
 */
import type { Octokit } from "octokit";

import { parseRepositorySlug } from "./repository.ts";

export type RecordLike = Record<string, unknown>;
export type Endpoint = (parameters: RecordLike) => Promise<unknown>;

export const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

export const recordValue = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;

/** Unwrap an Octokit-style `{ data }` response envelope. */
export const responseData = (value: unknown): unknown =>
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "data")
        ? value.data
        : undefined;

/** Extract an HTTP-style status from an Octokit error or response. */
export const statusOf = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const nested = isRecord(value.response) ? value.response.status : undefined;
    const status = nested ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

/** Extract a human-readable diagnostic from any thrown value. */
export const detailOf = (value: unknown): string => {
    if (value instanceof Error && value.message.length > 0) {
        return value.message;
    }
    if (isRecord(value) && typeof value.message === "string") {
        return value.message;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

export const requestOptions = (signal: AbortSignal | undefined): RecordLike =>
    signal === undefined ? {} : { request: { signal } };

export const isAbortCause = (
    cause: unknown,
    signal: AbortSignal | undefined,
): boolean =>
    signal?.aborted === true ||
    (isRecord(cause) && cause.name === "AbortError");

/**
 * Re-throw the abort reason when the caller signal fired. The default message
 * preserves each adapter's historical semantics via the `message` argument.
 */
export const throwIfAborted = (
    signal: AbortSignal | undefined,
    message: string,
): void => {
    if (!signal?.aborted) return;
    throw (
        signal.reason ??
        Object.assign(new Error(message), { name: "AbortError" })
    );
};

export const endpointFor = (
    client: Octokit,
    namespace: string,
    name: string,
): Endpoint | undefined => {
    const rest = recordValue(client, "rest");
    const group = isRecord(rest) ? rest[namespace] : undefined;
    const endpoint = isRecord(group) ? group[name] : undefined;
    return typeof endpoint === "function"
        ? (
              endpoint as (...args: ReadonlyArray<unknown>) => Promise<unknown>
          ).bind(group)
        : undefined;
};

export const repositoryParameters = (
    repository: string,
): { readonly owner: string; readonly repo: string } => {
    const parsed = parseRepositorySlug(repository);
    return { owner: parsed.owner, repo: parsed.name };
};

/** Shared repository validation; returns the skip detail or undefined. */
export const invalidRepositoryDetail = (
    repository: string,
): string | undefined => {
    try {
        repositoryParameters(repository);
        return undefined;
    } catch (cause) {
        return `invalid GitHub repository: ${detailOf(cause)}`;
    }
};

export type ActorMessages = {
    readonly unavailable: string;
    readonly missingLogin: string;
    readonly failurePrefix: string;
};

export type ActorResult =
    | { readonly status: "ok"; readonly login: string }
    | { readonly status: "skipped"; readonly detail: string };

/** Single implementation of the authenticated-actor lookup. */
export const fetchAuthenticatedActor = async (
    client: Octokit,
    signal: AbortSignal | undefined,
    messages: ActorMessages,
): Promise<ActorResult> => {
    const endpoint = endpointFor(client, "users", "getAuthenticated");
    if (endpoint === undefined) {
        return { status: "skipped", detail: messages.unavailable };
    }
    try {
        const response = await endpoint({ ...requestOptions(signal) });
        const login = text(recordValue(responseData(response), "login")).trim();
        return login.length === 0
            ? { status: "skipped", detail: messages.missingLogin }
            : { status: "ok", login };
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "skipped",
            detail: `${messages.failurePrefix}: ${detailOf(cause)}`,
        };
    }
};

/**
 * Resolve an explicit test/replay actor override before hitting GitHub.
 * Preserves both adapters' historical trim-and-fallback semantics.
 */
export const resolveActorWithOverride = async (
    client: Octokit,
    signal: AbortSignal | undefined,
    messages: ActorMessages,
    authenticatedActorLogin: string | undefined,
): Promise<ActorResult> =>
    authenticatedActorLogin?.trim()
        ? { status: "ok", login: authenticatedActorLogin.trim() }
        : fetchAuthenticatedActor(client, signal, messages);

export type LockedCommentPermissionInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly issueNumber: number;
    readonly actorLogin: string;
    readonly issue: RecordLike;
};

export type LockedCommentPermissionChecker = (
    input: LockedCommentPermissionInput,
) => Promise<boolean>;

export const permissionGranted = (value: RecordLike | undefined): boolean =>
    value?.admin === true ||
    value?.maintain === true ||
    value?.push === true ||
    value?.triage === true;

const runLockedPermissionChecker = async (
    checker: LockedCommentPermissionChecker,
    input: LockedCommentPermissionInput,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    try {
        return await checker(input);
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return undefined;
    }
};

/** Single implementation of the repository-permission fallback read. */
export const readRepositoryPermissions = async (
    client: Octokit,
    repository: string,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    const endpoint = endpointFor(client, "repos", "get");
    if (endpoint === undefined) return undefined;
    try {
        const response = await endpoint({
            ...repositoryParameters(repository),
            ...requestOptions(signal),
        });
        const permissions = recordValue(responseData(response), "permissions");
        return isRecord(permissions)
            ? permissionGranted(permissions)
            : undefined;
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return undefined;
    }
};

export type LockedIssueLike = {
    readonly number: number;
    readonly locked: boolean;
    readonly permissions: RecordLike | undefined;
    readonly raw: RecordLike;
};

/**
 * Single implementation of locked-issue comment permission. Unlocked issues
 * always succeed; locked issues consult the injected checker first, then the
 * live issue permissions, then the repository permission fallback. Unknown
 * stays unknown (`undefined`) so each policy can keep its own skip semantics.
 */
export const canCommentOnLockedIssue = async (
    client: Octokit,
    repository: string,
    issue: LockedIssueLike,
    actorLogin: string,
    checker: LockedCommentPermissionChecker | undefined,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    if (!issue.locked) return true;
    if (checker !== undefined) {
        return runLockedPermissionChecker(
            checker,
            {
                client,
                repository,
                issueNumber: issue.number,
                actorLogin,
                issue: issue.raw,
            },
            signal,
        );
    }
    if (permissionGranted(issue.permissions)) return true;
    return readRepositoryPermissions(client, repository, signal);
};