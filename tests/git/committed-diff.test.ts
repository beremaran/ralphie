import { describe, expect, test } from "bun:test";

import { makeGitIssueOperationsService } from "../../src/git/issue-operations.ts";
import {
    CommandAbortedError,
    type CommandResult,
    type CommandRunOptions,
    type CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { makeGitFixture } from "../shared/git-fixture.ts";

const REPOSITORY_PATH = "/work/repository";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const result = (stdout = ""): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
});

const recordingRunner = (
    calls: Array<{
        readonly args: ReadonlyArray<string>;
        readonly options: CommandRunOptions | undefined;
    }>,
): CommandRunnerService => ({
    run: async (_command, args, options) => {
        calls.push({ args: [...args], options });
        return result("patch");
    },
});

describe("committed-diff cancellation boundary", () => {
    test("forwards the abort signal to the committed-diff subprocess", async () => {
        const controller = new AbortController();
        const calls: Array<{
            readonly args: ReadonlyArray<string>;
            readonly options: CommandRunOptions | undefined;
        }> = [];
        const service = makeGitIssueOperationsService(recordingRunner(calls));

        const patch = await service.readCommittedBinaryDiff(
            REPOSITORY_PATH,
            BASE,
            HEAD,
            controller.signal,
        );

        expect(patch).toBe("patch");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.options?.signal).toBe(controller.signal);
    });

    test("reads only the committed base..head range and never the index or working tree", async () => {
        const calls: Array<{
            readonly args: ReadonlyArray<string>;
            readonly options: CommandRunOptions | undefined;
        }> = [];
        const service = makeGitIssueOperationsService(recordingRunner(calls));

        await service.readCommittedBinaryDiff(REPOSITORY_PATH, BASE, HEAD);

        expect(calls[0]?.args).toEqual([
            "-C",
            REPOSITORY_PATH,
            "diff",
            "--binary",
            "--no-ext-diff",
            `${BASE}..${HEAD}`,
        ]);
    });

    test("propagates an in-flight abort of the subprocess as CommandAbortedError", async () => {
        const controller = new AbortController();
        let rejectRun: ((error: unknown) => void) | undefined;
        const runner: CommandRunnerService = {
            run: (_command, _args, options) =>
                new Promise((_resolve, reject) => {
                    rejectRun = reject;
                    options?.signal?.addEventListener(
                        "abort",
                        () =>
                            reject(
                                new CommandAbortedError({
                                    command: "git diff",
                                }),
                            ),
                        { once: true },
                    );
                }),
        };
        const service = makeGitIssueOperationsService(runner);

        const pending = service
            .readCommittedBinaryDiff(
                REPOSITORY_PATH,
                BASE,
                HEAD,
                controller.signal,
            )
            .catch((error: unknown) => error);
        controller.abort();
        const result = await pending;

        expect(result).toBeInstanceOf(CommandAbortedError);
    });

    test("requires explicit full base and head SHAs before any subprocess", async () => {
        const calls: Array<{
            readonly args: ReadonlyArray<string>;
            readonly options: CommandRunOptions | undefined;
        }> = [];
        const service = makeGitIssueOperationsService(recordingRunner(calls));

        for (const shas of [
            ["short", HEAD],
            [BASE, ""],
            ["not-a-sha", HEAD],
            [BASE, "a".repeat(39)],
        ] as const) {
            await expect(
                service.readCommittedBinaryDiff(
                    REPOSITORY_PATH,
                    shas[0],
                    shas[1],
                ),
            ).rejects.toBeInstanceOf(RalphieError);
        }
        expect(calls).toHaveLength(0);
    });

    test("rejects a cancelled committed-diff read at the live boundary", async () => {
        const controller = new AbortController();
        controller.abort();
        const service = makeGitIssueOperationsService();

        await expect(
            service.readCommittedBinaryDiff(
                REPOSITORY_PATH,
                BASE,
                HEAD,
                controller.signal,
            ),
        ).rejects.toBeInstanceOf(CommandAbortedError);
    });

    test("ignores staged and working-tree noise at the live boundary", async () => {
        const fixture = await makeGitFixture();
        try {
            const service = makeGitIssueOperationsService();
            const patch = await service.readCommittedBinaryDiff(
                fixture.repositoryPath,
                fixture.baseSha,
                fixture.headSha,
            );

            expect(patch).toContain("+changed");
            expect(patch).not.toContain("uncommitted.txt");
            expect(patch).not.toContain("+dirty");
        } finally {
            await fixture.cleanup();
        }
    });
});