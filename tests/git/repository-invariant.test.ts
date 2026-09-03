import { describe, expect, test } from "bun:test";

import { makeGitRepositoryInvariantService } from "../../src/git/repository-invariant.ts";
import {
    CommandAbortedError,
    type CommandResult,
    type CommandRunOptions,
    type CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { makeGitFixture } from "../shared/git-fixture.ts";

const REPOSITORY_PATH = "/work/repository";
const BRANCH = "develop";
const HEAD = "a".repeat(40);

const result = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
});

const invariantRunner = (
    calls: Array<{
        readonly args: ReadonlyArray<string>;
        readonly options: CommandRunOptions | undefined;
    }>,
): CommandRunnerService => ({
    run: async (_command, args, options) => {
        calls.push({ args: [...args], options });
        if (args.includes("--abbrev-ref")) return result(BRANCH);
        return result(HEAD);
    },
});

describe("repository-invariant cancellation boundary", () => {
    test("capture forwards the abort signal to both git reads", async () => {
        const controller = new AbortController();
        const calls: Array<{
            readonly args: ReadonlyArray<string>;
            readonly options: CommandRunOptions | undefined;
        }> = [];
        const service = makeGitRepositoryInvariantService(
            invariantRunner(calls),
        );

        const captured = await service.capture(
            REPOSITORY_PATH,
            controller.signal,
        );

        expect(captured).toEqual({ branch: BRANCH, head: HEAD });
        expect(calls).toHaveLength(2);
        expect(
            calls.every(({ options }) => options?.signal === controller.signal),
        ).toBe(true);
    });

    test("propagates an in-flight abort during invariant capture", async () => {
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
                                    command: "git rev-parse",
                                }),
                            ),
                        { once: true },
                    );
                }),
        };
        const service = makeGitRepositoryInvariantService(runner);

        const pending = service
            .capture(REPOSITORY_PATH, controller.signal)
            .catch((error: unknown) => error);
        controller.abort();
        const result = await pending;

        expect(result).toBeInstanceOf(CommandAbortedError);
    });

    test("verify forwards the abort signal and distinguishes a changed repository", async () => {
        const controller = new AbortController();
        const calls: Array<{
            readonly args: ReadonlyArray<string>;
            readonly options: CommandRunOptions | undefined;
        }> = [];
        const service = makeGitRepositoryInvariantService(
            invariantRunner(calls),
        );

        await service.verify(
            REPOSITORY_PATH,
            { branch: BRANCH, head: HEAD },
            controller.signal,
        );
        expect(
            calls.every(({ options }) => options?.signal === controller.signal),
        ).toBe(true);

        await expect(
            service.verify(
                REPOSITORY_PATH,
                { branch: "main", head: HEAD },
                controller.signal,
            ),
        ).rejects.toBeInstanceOf(RalphieError);
    });

    test("captures and verifies a real checkout at the live boundary", async () => {
        const fixture = await makeGitFixture();
        try {
            const service = makeGitRepositoryInvariantService();
            const captured = await service.capture(fixture.repositoryPath);

            expect(captured.head.toLowerCase()).toBe(
                fixture.headSha.toLowerCase(),
            );
            await service.verify(fixture.repositoryPath, captured);
            await expect(
                service.verify(fixture.repositoryPath, {
                    ...captured,
                    head: "f".repeat(40),
                }),
            ).rejects.toBeInstanceOf(RalphieError);
        } finally {
            await fixture.cleanup();
        }
    });

    test("rejects a cancelled invariant capture at the live boundary", async () => {
        const controller = new AbortController();
        controller.abort();
        const service = makeGitRepositoryInvariantService();

        await expect(
            service.capture(REPOSITORY_PATH, controller.signal),
        ).rejects.toBeInstanceOf(CommandAbortedError);
    });
});