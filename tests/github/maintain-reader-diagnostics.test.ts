import { describe, expect, test } from "bun:test";

import {
    MAINTAIN_READER_MAX_PAGES,
    MaintainGitHubReaderDiagnosticError,
    isMaintainReaderRateLimited,
    paginateMaintainReaderGet,
    throwIfAborted,
} from "../../src/maintain/github-reader/diagnostics.ts";

const response = (data: unknown, link?: string, status = 200): unknown => ({
    data,
    status,
    headers: link === undefined ? {} : { link },
});

const next = `<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=2>; rel="last"`;

const transportError = (
    status: number,
    headers: Record<string, string> = {},
): Error =>
    Object.assign(new Error("transport exploded"), {
        status,
        response: { status, headers, data: { message: "transport exploded" } },
    });

describe("maintenance GitHub reader diagnostics", () => {
    test("detects 429 and exhausted 403 rate-limit shapes only", () => {
        expect(isMaintainReaderRateLimited(transportError(429))).toBe(true);
        expect(
            isMaintainReaderRateLimited(
                transportError(403, { "x-ratelimit-remaining": "0" }),
            ),
        ).toBe(true);
        expect(
            isMaintainReaderRateLimited(
                transportError(403, { "x-ratelimit-remaining": "1" }),
            ),
        ).toBe(false);
        expect(isMaintainReaderRateLimited(transportError(404))).toBe(false);
    });

    test("collects Link-header paginated object envelopes with exact parameters", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const controller = new AbortController();
        const endpoint = async (
            parameters: Record<string, unknown>,
        ): Promise<unknown> => {
            calls.push(parameters);
            return parameters.page === 1
                ? response(
                      {
                          total_count: 3,
                          issues: [{ number: 2 }, { number: 1 }],
                      },
                      next,
                  )
                : response({ total_count: 3, issues: [{ number: 3 }] });
        };

        const records = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "repos/{owner}/{repo}/issues",
            requestEndpoint: endpoint,
            parameters: { owner: "o", repo: "r", state: "open" },
            responseKey: "issues",
            signal: controller.signal,
        });

        expect(records).toEqual([{ number: 2 }, { number: 1 }, { number: 3 }]);
        expect(calls).toEqual([
            {
                owner: "o",
                repo: "r",
                state: "open",
                page: 1,
                per_page: 100,
                request: { signal: controller.signal },
            },
            {
                owner: "o",
                repo: "r",
                state: "open",
                page: 2,
                per_page: 100,
                request: { signal: controller.signal },
            },
        ]);
    });

    test("collects bare-array pages and maps records", async () => {
        const records = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "comments",
            requestEndpoint: async () => response([{ id: 1 }, { id: 2 }]),
            map: (value) => (value as { id: number }).id,
        });
        expect(records).toEqual([1, 2]);
    });

    test("wraps HTTP failures as diagnostics and preserves the original cause", async () => {
        const cause = transportError(403, { "x-ratelimit-remaining": "0" });
        const error = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "repos/{owner}/{repo}/labels",
            requestEndpoint: async () => {
                throw cause;
            },
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(MaintainGitHubReaderDiagnosticError);
        const diagnostic = error as MaintainGitHubReaderDiagnosticError;
        expect(diagnostic.repository).toBe("o/r");
        expect(diagnostic.endpoint).toBe("repos/{owner}/{repo}/labels");
        expect(diagnostic.page).toBe(1);
        expect(diagnostic.message).toContain("o/r");
        expect(diagnostic.message).toContain("page 1");
        expect(diagnostic.cause).toBe(cause);
        expect(isMaintainReaderRateLimited(cause)).toBe(true);
    });

    test("rejects malformed envelopes and contradictory pagination", async () => {
        const malformed = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "labels",
            requestEndpoint: async () => response({ labels: "not-an-array" }),
            responseKey: "labels",
        }).catch((caught) => caught);
        expect(malformed).toBeInstanceOf(MaintainGitHubReaderDiagnosticError);

        const contradictory = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "issues",
            requestEndpoint: async () =>
                response({ total_count: 101, issues: [{ number: 1 }] }),
            responseKey: "issues",
        }).catch((caught) => caught);
        expect(contradictory).toBeInstanceOf(
            MaintainGitHubReaderDiagnosticError,
        );
    });

    test("rejects an invalid Link header rather than guessing pagination", async () => {
        const error = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "issues",
            requestEndpoint: async () =>
                response({ issues: [{ number: 1 }] }, "not a Link header"),
            responseKey: "issues",
        }).catch((caught) => caught);
        expect(error).toBeInstanceOf(MaintainGitHubReaderDiagnosticError);
    });

    test("enforces the page safety cap", async () => {
        const error = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "issues",
            maxPages: 1,
            requestEndpoint: async () =>
                response([{ number: 1 }], `<next>; rel="next"`),
        }).catch((caught) => caught);
        expect(error).toBeInstanceOf(MaintainGitHubReaderDiagnosticError);
        expect(
            (error as MaintainGitHubReaderDiagnosticError).message,
        ).toContain("safety limit of 1 pages");
        expect(MAINTAIN_READER_MAX_PAGES).toBe(10_000);
    });

    test("abort is rethrown between pages and is never converted to a diagnostic", async () => {
        const controller = new AbortController();
        const reason = new Error("stop now");
        let calls = 0;
        const error = await paginateMaintainReaderGet({
            repository: "o/r",
            endpoint: "issues",
            requestEndpoint: async () => {
                calls += 1;
                if (calls === 1) {
                    controller.abort(reason);
                    return response([{ number: 1 }], next);
                }
                return response([{ number: 2 }]);
            },
            signal: controller.signal,
        }).catch((caught) => caught);
        expect(calls).toBe(1);
        expect(error).toBe(reason);
        expect(error).not.toBeInstanceOf(MaintainGitHubReaderDiagnosticError);
    });

    test("throwIfAborted preserves an explicit reason", () => {
        const controller = new AbortController();
        const reason = { code: "cancelled" };
        controller.abort(reason);
        expect(() => throwIfAborted(controller.signal)).toThrow();
        try {
            throwIfAborted(controller.signal);
        } catch (caught) {
            expect(caught).toBe(reason);
        }
    });
});