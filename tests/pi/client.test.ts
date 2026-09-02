import { describe, expect, test } from "bun:test";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { flattenDiscriminatedUnionForTool } from "../../src/agent/json-schema.ts";
import { groundingDecisionSchema } from "../../src/issues/decisions.ts";
import {
    buildPiAttemptPrompt,
    isPiTaskCommandAllowed,
    makePiClient,
    PiSessionProfile,
} from "../../src/pi/client.ts";

describe("Pi task shell policy", () => {
    test("allows ordinary inspection and verification commands", () => {
        expect(isPiTaskCommandAllowed("bun test tests/issues")).toBe(true);
        expect(isPiTaskCommandAllowed("git diff --stat")).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src")).toBe(true);
        expect(
            isPiTaskCommandAllowed("git status --short && git diff --check"),
        ).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src | head -20")).toBe(true);
        expect(isPiTaskCommandAllowed("cd /workspace && bun test")).toBe(true);
        expect(
            isPiTaskCommandAllowed("bun test || bun test --rerun-each 2"),
        ).toBe(true);
        expect(
            isPiTaskCommandAllowed("node -e 'console.log(1)' > result.txt"),
        ).toBe(true);
        expect(isPiTaskCommandAllowed("echo $(git status --short)")).toBe(true);
    });

    test("reserves Git and GitHub mutations for Ralphie", () => {
        for (const command of [
            "git commit -m fix",
            "git push origin main",
            "git checkout other",
            "git reset --hard HEAD~1",
            "gh issue close 12",
        ]) {
            expect(isPiTaskCommandAllowed(command)).toBe(false);
        }
    });

    test("rejects explicit orchestration-owned mutations in composed commands", () => {
        for (const command of [
            "bun test && git commit -am fix",
            "git status; git push",
            "git status || git push",
            "cd /workspace && gh issue close 12",
        ]) {
            expect(isPiTaskCommandAllowed(command)).toBe(false);
        }
    });
});

describe("Pi client review sessions", () => {
    test("exposes only side-channel tools and rejects repository tool attempts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-review-"));
        const marker = "mutable project instructions must not be loaded";
        const outputPath = join(directory, "diff-output.txt");
        const secretPath = join(directory, "secret.txt");
        await mkdir(join(directory, ".pi"), { recursive: true });
        await writeFile(join(directory, "AGENTS.md"), marker);
        await writeFile(join(directory, "SYSTEM.md"), marker);
        await writeFile(join(directory, "APPEND_SYSTEM.md"), marker);
        await writeFile(join(directory, ".pi", "SYSTEM.md"), marker);
        await writeFile(join(directory, ".pi", "APPEND_SYSTEM.md"), marker);
        await writeFile(secretPath, "mutable checkout content");

        const model = {
            id: "review-model",
            name: "Review model",
            api: "test-api",
            provider: "test-provider",
            baseUrl: "https://example.test",
            reasoning: false,
            input: ["text"],
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            contextWindow: 8_000,
            maxTokens: 1_000,
        };
        let streamCalls = 0;
        const modelRuntime = {
            getModel: () => model,
            hasConfiguredAuth: () => true,
            streamSimple: () => {
                const stream = createAssistantMessageEventStream();
                const content: AssistantMessage["content"] =
                    streamCalls++ === 0
                        ? [
                              {
                                  type: "toolCall",
                                  id: "bash-attempt",
                                  name: "bash",
                                  arguments: {
                                      command: `git diff --output ${outputPath}`,
                                  },
                              },
                              {
                                  type: "toolCall",
                                  id: "read-attempt",
                                  name: "read",
                                  arguments: { path: secretPath },
                              },
                          ]
                        : [
                              {
                                  type: "toolCall",
                                  id: "submit-attempt",
                                  name: "submit_result",
                                  arguments: {},
                              },
                          ];
                const message: AssistantMessage = {
                    role: "assistant",
                    content,
                    api: "test-api",
                    provider: "test-provider",
                    model: "review-model",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                };
                queueMicrotask(() =>
                    stream.push({
                        type: "done",
                        reason: "toolUse",
                        message,
                    }),
                );
                return stream;
            },
        };
        let realSession:
            | Awaited<ReturnType<typeof createAgentSession>>["session"]
            | undefined;
        const events: unknown[] = [];
        const client = makePiClient(
            modelRuntime as never,
            (event) => events.push(event),
            directory,
            (async (options: CreateAgentSessionOptions) => {
                const result = await createAgentSession(options);
                realSession = result.session;
                return result;
            }) as never,
        );

        try {
            const created = await client.session.create({
                directory,
                title: "Review",
                model: { providerID: "test-provider", id: "review-model" },
                profile: PiSessionProfile.Review,
                permission: [
                    { permission: "bash", pattern: "*", action: "allow" },
                ],
            });
            await client.session.prompt({
                sessionID: created.data!.id,
                directory,
                profile: PiSessionProfile.Review,
                format: {
                    type: "json_schema",
                    schema: { type: "object" },
                    validate: () => ({ success: true }),
                },
                parts: [{ type: "text", text: "Review the patch." }],
            });

            expect(realSession?.getActiveToolNames()).toEqual([
                "request_needs_attention",
                "submit_result",
            ]);
            expect(
                realSession?.resourceLoader.getAgentsFiles().agentsFiles,
            ).toEqual([]);
            expect(
                realSession?.resourceLoader.getSystemPrompt(),
            ).toBeUndefined();
            expect(realSession?.resourceLoader.getAppendSystemPrompt()).toEqual(
                [],
            );
            expect(realSession?.systemPrompt).not.toContain(marker);
            for (const repositoryTool of [
                "read",
                "grep",
                "find",
                "ls",
                "bash",
                "edit",
                "write",
            ]) {
                expect(
                    realSession?.getToolDefinition(repositoryTool),
                ).toBeUndefined();
            }
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "tool_execution_end",
                        toolName: "bash",
                        isError: true,
                    }),
                    expect.objectContaining({
                        type: "tool_execution_end",
                        toolName: "read",
                        isError: true,
                    }),
                ]),
            );
            expect(await Bun.file(outputPath).exists()).toBe(false);
        } finally {
            client.close?.();
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("gives every created session a distinct id", async () => {
        const client = makePiClient({} as never);
        const first = await client.session.create({
            directory: "/workspace",
            title: "First",
        });
        const second = await client.session.create({
            directory: "/workspace",
            title: "Second",
        });

        expect(first.data?.id).toBeString();
        expect(second.data?.id).toBeString();
        expect(first.data?.id).not.toBe(second.data?.id);
        client.close?.();
    });

    test("aborts and disposes a session that finishes constructing after cancellation", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-abort-"));
        let constructionStarted!: () => void;
        let releaseConstruction!: () => void;
        const started = new Promise<void>((resolve) => {
            constructionStarted = resolve;
        });
        const construction = new Promise<void>((resolve) => {
            releaseConstruction = resolve;
        });
        let abortCalls = 0;
        let disposeCalls = 0;
        let markCleaned!: () => void;
        const cleaned = new Promise<void>((resolve) => {
            markCleaned = resolve;
        });
        const session = {
            messages: [],
            prompt: async () => {},
            subscribe: () => () => {},
            abort: async () => {
                abortCalls += 1;
            },
            dispose: () => {
                disposeCalls += 1;
                markCleaned();
            },
        };
        const client = makePiClient(
            {} as never,
            undefined,
            directory,
            (async () => {
                constructionStarted();
                await construction;
                return { session };
            }) as never,
        );
        const controller = new AbortController();
        const created = await client.session.create({
            directory,
            title: "Abort construction",
        });
        const prompting = client.session.prompt(
            {
                sessionID: created.data!.id,
                directory,
                parts: [{ type: "text", text: "Run." }],
            },
            { signal: controller.signal },
        );

        try {
            await started;
            const reason = new Error("cancelled");
            controller.abort(reason);
            await expect(prompting).rejects.toBe(reason);
            expect(
                (
                    await client.session.prompt({
                        sessionID: created.data!.id,
                        directory,
                        parts: [{ type: "text", text: "Again." }],
                    })
                ).error,
            ).toBeInstanceOf(Error);
            releaseConstruction();
            await cleaned;
            expect(abortCalls).toBe(1);
            expect(disposeCalls).toBe(1);
        } finally {
            client.close?.();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("Pi client structured results", () => {
    test("accepts null-materialized union arguments through the real submit_result pipeline", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-union-"));
        await mkdir(join(directory, ".pi"), { recursive: true });
        const model = {
            id: "union-model",
            name: "Union model",
            api: "test-api",
            provider: "test-provider",
            baseUrl: "https://example.test",
            reasoning: false,
            input: ["text"],
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            contextWindow: 8_000,
            maxTokens: 1_000,
        };
        const argumentsFor = (): unknown => ({
            disposition: "actionable",
            reason: "null",
            summary: null,
            evidence: null,
            questions: null,
        });
        const modelRuntime = {
            getModel: () => model,
            hasConfiguredAuth: () => true,
            streamSimple: () => {
                const stream = createAssistantMessageEventStream();
                const content: AssistantMessage["content"] = [
                    {
                        type: "toolCall",
                        id: "submit-attempt",
                        name: "submit_result",
                        arguments: argumentsFor() as Record<string, unknown>,
                    },
                ];
                const message: AssistantMessage = {
                    role: "assistant",
                    content,
                    api: "test-api",
                    provider: "test-provider",
                    model: "union-model",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                };
                queueMicrotask(() =>
                    stream.push({
                        type: "done",
                        reason: "toolUse",
                        message,
                    }),
                );
                return stream;
            },
        };
        const client = makePiClient(
            modelRuntime as never,
            undefined,
            directory,
            (async (options: CreateAgentSessionOptions) => {
                return await createAgentSession(options);
            }) as never,
        );

        try {
            const created = await client.session.create({
                directory,
                title: "Grounding decision",
                model: { providerID: "test-provider", id: "union-model" },
            });
            const response = await client.session.prompt({
                sessionID: created.data!.id,
                directory,
                format: {
                    type: "json_schema",
                    schema: flattenDiscriminatedUnionForTool(
                        z.toJSONSchema(groundingDecisionSchema),
                    ),
                    validate: (value: unknown) => {
                        const parsed = groundingDecisionSchema.safeParse(value);
                        return parsed.success
                            ? { success: true }
                            : {
                                  success: false,
                                  error: z.prettifyError(parsed.error),
                              };
                    },
                },
                parts: [{ type: "text", text: "Assess the issue." }],
            });

            expect(response.error).toBeUndefined();
            expect(response.data?.info.error).toBeUndefined();
            expect(response.data?.info.structured).toEqual({
                disposition: "actionable",
            });
        } finally {
            client.close?.();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("Pi prompt contract", () => {
    test("marks ordinary tasks as unattended and non-interactive", () => {
        const prompt = buildPiAttemptPrompt(
            "Implement the issue.",
            false,
            false,
        );

        expect(prompt).toContain("Implement the issue.");
        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("No user or operator can answer");
        expect(prompt).toContain("Do not ask questions in prose");
        expect(prompt).toContain("call request_needs_attention");
        expect(prompt).toContain("completion or result tool");
        expect(prompt).not.toContain("MANDATORY RESPONSE CONTRACT");
    });

    test("requires structured tasks to finish through submit_result", () => {
        const prompt = buildPiAttemptPrompt("Review the change.", true, false);

        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("MANDATORY RESPONSE CONTRACT");
        expect(prompt).toContain(
            "final action must be exactly one call to the submit_result tool",
        );
        expect(prompt).toContain("printed JSON, or a question");
    });

    test("repeats unattended and tool requirements after a contract violation", () => {
        const prompt = buildPiAttemptPrompt("ignored", true, true);

        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("RESPONSE CONTRACT VIOLATION");
        expect(prompt).toContain("Call submit_result now");
        expect(prompt).toContain("prose, Markdown, printed JSON, or questions");
    });
});