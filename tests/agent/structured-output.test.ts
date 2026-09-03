import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import type { AgentClient } from "../../src/opencode/client.ts";
import { CommandAbortedError } from "../../src/process/command-runner.ts";
import { makeGitRepositoryInvariantService } from "../../src/git/repository-invariant.ts";
import { makeGitFixture } from "../shared/git-fixture.ts";

const schema = z.object({ ok: z.boolean() });

const structuredClient = (structured: unknown): AgentClient => ({
    session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async () => ({
            data: {
                info: {
                    id: "message-1",
                    role: "assistant",
                    structured,
                },
                parts: [],
            },
        }),
    },
});

const invariant = { branch: "develop", head: "a".repeat(40) };

describe("structured-output post-run verification cancellation", () => {
    test("passes the caller signal to repository invariant verification", async () => {
        const controller = new AbortController();
        const received: Array<{
            repositoryPath: string;
            expected: typeof invariant;
            signal: AbortSignal | undefined;
        }> = [];
        const result = await requestStructuredOutput(
            structuredClient({ ok: true }),
            {
                directory: "/work/repository",
                title: "task",
                prompt: "Do the work.",
                schema,
                signal: controller.signal,
                repositoryInvariant: invariant,
                verifyRepositoryInvariant: async (
                    repositoryPath,
                    expected,
                    signal,
                ) => {
                    received.push({ repositoryPath, expected, signal });
                },
            },
        );

        expect(result.output).toEqual({ ok: true });
        expect(received).toHaveLength(1);
        expect(received[0]?.repositoryPath).toBe("/work/repository");
        expect(received[0]?.expected).toEqual(invariant);
        expect(received[0]?.signal).toBe(controller.signal);
    });

    test("passes the caller signal to verifyAfter", async () => {
        const controller = new AbortController();
        const signals: Array<AbortSignal | undefined> = [];
        await requestStructuredOutput(structuredClient({ ok: true }), {
            directory: "/work/repository",
            title: "task",
            prompt: "Do the work.",
            schema,
            signal: controller.signal,
            verifyAfter: async (signal) => {
                signals.push(signal);
            },
        });

        expect(signals).toEqual([controller.signal]);
    });

    test("propagates an abort raised during invariant verification", async () => {
        const controller = new AbortController();
        const pending = requestStructuredOutput(
            structuredClient({ ok: true }),
            {
                directory: "/work/repository",
                title: "task",
                prompt: "Do the work.",
                schema,
                signal: controller.signal,
                repositoryInvariant: invariant,
                verifyRepositoryInvariant: async (_path, _expected, signal) => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    if (signal?.aborted === true) {
                        throw new CommandAbortedError({
                            command: "git rev-parse",
                        });
                    }
                },
            },
        ).catch((error: unknown) => error);
        setTimeout(() => controller.abort(), 5);
        const result = await pending;

        expect(result).toBeInstanceOf(CommandAbortedError);
    });

    test("surfaces a live-boundary abort from repository invariant verification", async () => {
        const fixture = await makeGitFixture();
        try {
            const live = makeGitRepositoryInvariantService();
            const controller = new AbortController();
            await expect(
                requestStructuredOutput(structuredClient({ ok: true }), {
                    directory: fixture.repositoryPath,
                    title: "task",
                    prompt: "Do the work.",
                    schema,
                    signal: controller.signal,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant: async (
                        path,
                        _expected,
                        signal,
                    ) => {
                        controller.abort();
                        await live.verify(path, invariant, signal);
                    },
                }),
            ).rejects.toBeInstanceOf(CommandAbortedError);
        } finally {
            await fixture.cleanup();
        }
    });

    test("runs verification without a signal exactly as before", async () => {
        let verifications = 0;
        await requestStructuredOutput(structuredClient({ ok: true }), {
            directory: "/work/repository",
            title: "task",
            prompt: "Do the work.",
            schema,
            repositoryInvariant: invariant,
            verifyRepositoryInvariant: async () => {
                verifications += 1;
            },
        });

        expect(verifications).toBe(1);
    });
});