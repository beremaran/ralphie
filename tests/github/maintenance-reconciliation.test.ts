import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    canCommentOnLockedIssue,
    detailOf,
    fetchAuthenticatedActor,
    invalidRepositoryDetail,
    isAbortCause,
    repositoryParameters,
    requestOptions,
    resolveActorWithOverride,
    responseData,
    statusOf,
    throwIfAborted,
    permissionGranted,
    readRepositoryPermissions,
} from "../../src/github/maintenance-reconciliation.ts";

const actorMessages = {
    unavailable: "unavailable",
    missingLogin: "missing-login",
    failurePrefix: "lookup failed",
} as const;

const clientWith = (rest: unknown): Octokit => ({ rest }) as unknown as Octokit;

const abortError = (): Error =>
    Object.assign(new Error("aborted"), { name: "AbortError" });

describe("shared response parsing", () => {
    test("unwraps data envelopes and rejects malformed shapes", () => {
        expect(responseData({ data: { login: "bot" } })).toEqual({
            login: "bot",
        });
        expect(responseData({})).toBeUndefined();
        expect(responseData(null)).toBeUndefined();
        expect(responseData({ data: undefined })).toBeUndefined();
    });

    test("extracts nested and top-level statuses", () => {
        expect(statusOf({ response: { status: 404 } })).toBe(404);
        expect(statusOf({ status: 403 })).toBe(403);
        expect(statusOf({ status: "404" })).toBeUndefined();
        expect(statusOf(null)).toBeUndefined();
    });

    test("extracts diagnostics from errors, records, and values", () => {
        expect(detailOf(new Error("boom"))).toBe("boom");
        expect(detailOf({ message: "nope" })).toBe("nope");
        expect(detailOf({ login: "bot" })).toBe('{"login":"bot"}');
    });

    test("attaches abort signals to request options", () => {
        expect(requestOptions(undefined)).toEqual({});
        const controller = new AbortController();
        expect(requestOptions(controller.signal)).toEqual({
            request: { signal: controller.signal },
        });
    });
});

describe("shared abort handling", () => {
    test("detects aborted signals and AbortError causes", () => {
        const controller = new AbortController();
        expect(isAbortCause(new Error("x"), controller.signal)).toBe(false);
        controller.abort();
        expect(isAbortCause(new Error("x"), controller.signal)).toBe(true);
        expect(isAbortCause(abortError(), undefined)).toBe(true);
    });

    test("rethrows the signal reason and preserves error identity", () => {
        const controller = new AbortController();
        const reason = Object.assign(new Error("stop"), {
            name: "AbortError",
        });
        controller.abort(reason);
        let caught: unknown;
        try {
            throwIfAborted(controller.signal, "default message");
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(reason);

        const plain = new AbortController();
        plain.abort();
        try {
            throwIfAborted(plain.signal, "default message");
            expect.unreachable();
        } catch (error) {
            expect(error).toBe(plain.signal.reason);
        }

        expect(
            throwIfAborted(new AbortController().signal, "unused"),
        ).toBeUndefined();

        try {
            throwIfAborted(
                { aborted: true, reason: undefined } as unknown as AbortSignal,
                "default message",
            );
            expect.unreachable();
        } catch (error) {
            expect((error as Error).name).toBe("AbortError");
            expect((error as Error).message).toBe("default message");
        }
    });
});

describe("shared repository parsing", () => {
    test("resolves owner/name and reports invalid slugs", () => {
        expect(repositoryParameters("owner/repo")).toEqual({
            owner: "owner",
            repo: "repo",
        });
        expect(invalidRepositoryDetail("owner/repo")).toBeUndefined();
        const detail = invalidRepositoryDetail("not a repo!!!");
        expect(detail?.startsWith("invalid GitHub repository: ")).toBe(true);
    });
});

describe("shared actor lookup", () => {
    test("reports a missing endpoint without calling GitHub", async () => {
        const result = await fetchAuthenticatedActor(
            clientWith({}),
            undefined,
            actorMessages,
        );
        expect(result).toEqual({
            status: "skipped",
            detail: "unavailable",
        });
    });

    test("reports a missing actor login", async () => {
        const client = clientWith({
            users: { getAuthenticated: async () => ({ data: {} }) },
        });
        const result = await fetchAuthenticatedActor(
            client,
            undefined,
            actorMessages,
        );
        expect(result).toEqual({
            status: "skipped",
            detail: "missing-login",
        });
    });

    test("returns the trimmed login and preserves failure semantics", async () => {
        const ok = clientWith({
            users: {
                getAuthenticated: async () => ({
                    data: { login: "  bot  " },
                }),
            },
        });
        expect(
            await fetchAuthenticatedActor(ok, undefined, actorMessages),
        ).toEqual({ status: "ok", login: "bot" });

        const failing = clientWith({
            users: {
                getAuthenticated: async () => {
                    throw new Error("denied");
                },
            },
        });
        expect(
            await fetchAuthenticatedActor(failing, undefined, actorMessages),
        ).toEqual({
            status: "skipped",
            detail: "lookup failed: denied",
        });
    });

    test("prefers the override login and rethrows aborts", async () => {
        const client = clientWith({});
        expect(
            await resolveActorWithOverride(
                client,
                undefined,
                actorMessages,
                "  bot  ",
            ),
        ).toEqual({ status: "ok", login: "bot" });

        const controller = new AbortController();
        controller.abort(abortError());
        const aborting = clientWith({
            users: {
                getAuthenticated: async () => {
                    throw abortError();
                },
            },
        });
        await expect(
            fetchAuthenticatedActor(aborting, controller.signal, actorMessages),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("shared permission and locked-comment handling", () => {
    test("grants triage-level permissions and denies empty grants", () => {
        expect(permissionGranted({ admin: true })).toBe(true);
        expect(permissionGranted({ maintain: true })).toBe(true);
        expect(permissionGranted({ push: true })).toBe(true);
        expect(permissionGranted({ triage: true })).toBe(true);
        expect(permissionGranted({ pull: true })).toBe(false);
        expect(permissionGranted(undefined)).toBe(false);
    });

    test("reads repository permissions with malformed and failed responses", async () => {
        expect(
            await readRepositoryPermissions(
                clientWith({}),
                "owner/repo",
                undefined,
            ),
        ).toBeUndefined();

        const granted = clientWith({
            repos: {
                get: async () => ({
                    data: { permissions: { push: true } },
                }),
            },
        });
        expect(
            await readRepositoryPermissions(granted, "owner/repo", undefined),
        ).toBe(true);

        const malformed = clientWith({
            repos: { get: async () => ({ data: {} }) },
        });
        expect(
            await readRepositoryPermissions(malformed, "owner/repo", undefined),
        ).toBeUndefined();

        const failing = clientWith({
            repos: {
                get: async () => {
                    throw new Error("down");
                },
            },
        });
        expect(
            await readRepositoryPermissions(failing, "owner/repo", undefined),
        ).toBeUndefined();
    });

    test("allows unlocked issues without any permission check", async () => {
        const result = await canCommentOnLockedIssue(
            clientWith({}),
            "owner/repo",
            { number: 1, locked: false, permissions: undefined, raw: {} },
            "bot",
            undefined,
            undefined,
        );
        expect(result).toBe(true);
    });

    test("defers to the injected checker and preserves unknown on failure", async () => {
        const issue = {
            number: 2,
            locked: true,
            permissions: undefined,
            raw: { number: 2 },
        };
        expect(
            await canCommentOnLockedIssue(
                clientWith({}),
                "owner/repo",
                issue,
                "bot",
                async () => true,
                undefined,
            ),
        ).toBe(true);
        expect(
            await canCommentOnLockedIssue(
                clientWith({}),
                "owner/repo",
                issue,
                "bot",
                async () => false,
                undefined,
            ),
        ).toBe(false);
        expect(
            await canCommentOnLockedIssue(
                clientWith({}),
                "owner/repo",
                issue,
                "bot",
                async () => {
                    throw new Error("checker down");
                },
                undefined,
            ),
        ).toBeUndefined();
    });

    test("falls back from issue permissions to repository permissions", async () => {
        const privileged = {
            number: 3,
            locked: true,
            permissions: { triage: true },
            raw: {},
        };
        expect(
            await canCommentOnLockedIssue(
                clientWith({}),
                "owner/repo",
                privileged,
                "bot",
                undefined,
                undefined,
            ),
        ).toBe(true);

        const repoGranted = clientWith({
            repos: {
                get: async () => ({
                    data: { permissions: { push: true } },
                }),
            },
        });
        expect(
            await canCommentOnLockedIssue(
                repoGranted,
                "owner/repo",
                { number: 4, locked: true, permissions: {}, raw: {} },
                "bot",
                undefined,
                undefined,
            ),
        ).toBe(true);

        expect(
            await canCommentOnLockedIssue(
                clientWith({}),
                "owner/repo",
                { number: 5, locked: true, permissions: {}, raw: {} },
                "bot",
                undefined,
                undefined,
            ),
        ).toBeUndefined();
    });
});