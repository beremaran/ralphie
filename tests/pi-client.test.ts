import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import {
    makePiAgentClient,
    type PiAgentClientOptions,
} from "../src/pi/adapters/client.ts";
import type { PiAgentSelection } from "../src/pi/ports.ts";
import type { AgentClient } from "../src/agent/ports.ts";
import type {
    SessionEvent,
    SessionEventContext,
} from "../src/harness/ports.ts";

const structuredFormat = {
    type: "tool" as const,
    tool: {
        name: "submit_result",
        description: "Submit the final result.",
        schema: z.toJSONSchema(z.object({ ok: z.boolean() })),
    },
    validate: (value: unknown) => {
        const parsed = z.object({ ok: z.boolean() }).safeParse(value);
        return parsed.success
            ? { success: true as const }
            : { success: false as const, error: parsed.error.message };
    },
    retryCount: 0,
};

const makeClient = (options: {
    readonly responses: Parameters<
        ReturnType<typeof fauxProvider>["setResponses"]
    >[0];
    readonly eventListener?: PiAgentClientOptions["eventListener"];
    readonly liveSelection?: PiAgentClientOptions["liveSelection"];
    readonly modelIds?: ReadonlyArray<string>;
}) => {
    const modelIds = options.modelIds ?? ["faux-test"];
    const faux = fauxProvider({
        models: modelIds.map((id) => ({ id, reasoning: true })),
        tokensPerSecond: 100_000,
    });
    faux.setResponses(options.responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel(modelIds[0] ?? "faux-test");
    if (model === undefined) throw new Error("faux model missing");
    const client = makePiAgentClient({
        models,
        agentDir: join(tmpdir(), "ralphie-missing-pi-dir"),
        defaultModel: { providerID: model.provider, modelID: model.id },
        ...(options.liveSelection === undefined
            ? {}
            : { liveSelection: options.liveSelection }),
        ...(options.eventListener === undefined
            ? {}
            : { eventListener: options.eventListener }),
    });
    return { client, faux, model };
};

/** The assistant blocks of one kind, reassembled from their fragments. */
const assistantText = (
    events: ReadonlyArray<SessionEvent>,
    kind: "text" | "thinking",
): ReadonlyArray<string> => {
    const blocks: string[] = [];
    let open = "";
    for (const event of events) {
        if (event.type !== "assistant_text" || event.kind !== kind) continue;
        open += event.text;
        if (!event.done) continue;
        blocks.push(open);
        open = "";
    }
    return blocks;
};

const createSession = async (
    client: AgentClient,
    directory: string,
): Promise<string> => {
    const created = await client.session.create({
        directory,
        title: "test",
    });
    if (created.data === undefined) throw new Error("session create failed");
    return created.data.id;
};

describe("pi agent client", () => {
    test("captures structured output from a submission tool call", async () => {
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage(
                    [fauxToolCall("submit_result", { ok: true })],
                    { stopReason: "toolUse" },
                ),
            ],
        });
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            format: structuredFormat,
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
    });

    test("feeds validation errors back so the model can correct itself", async () => {
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage(
                    [fauxToolCall("submit_result", { ok: "not-a-boolean" })],
                    { stopReason: "toolUse" },
                ),
                fauxAssistantMessage(
                    [fauxToolCall("submit_result", { ok: true })],
                    { stopReason: "toolUse" },
                ),
            ],
        });
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            format: {
                ...structuredFormat,
                validate: (value) =>
                    typeof (value as { ok?: unknown }).ok === "boolean"
                        ? { success: true }
                        : { success: false, error: "ok must be a boolean" },
            },
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
    });

    test("retries until the model calls the submission tool", async () => {
        const { client, faux } = makeClient({
            responses: [
                fauxAssistantMessage("analysis without any tool call"),
                fauxAssistantMessage(
                    [fauxToolCall("submit_result", { ok: true })],
                    { stopReason: "toolUse" },
                ),
            ],
        });
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            format: { ...structuredFormat, retryCount: 1 },
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
        expect(faux.state.callCount).toBe(2);
    });

    test("fails with the tool name after the retry budget is exhausted", async () => {
        const { client } = makeClient({
            responses: [fauxAssistantMessage("analysis without any tool call")],
        });
        const sessionID = await createSession(client, "/repo");

        const failure = await client.session
            .prompt({
                sessionID,
                directory: "/repo",
                parts: [{ type: "text", text: "Do the work." }],
                format: structuredFormat,
            })
            .catch((error: unknown) => error);

        expect(String((failure as Error)?.message ?? failure)).toMatch(
            /without calling the `submit_result` tool/,
        );
    });

    test("returns unstructured text and the needs-attention tool channel", async () => {
        const text = "Blocked.";
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage(
                    [
                        fauxToolCall("request_needs_attention", {
                            reason: "missing_information",
                            message: "Need the target version.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                ),
                fauxAssistantMessage(text),
            ],
        });
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            needsAttentionTool: {
                name: "request_needs_attention",
                description: "Request needs attention.",
                schema: { type: "object" },
            },
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.text).toBe(text);
        expect(result.data?.needsAttention).toEqual({
            reason: "missing_information",
            message: "Need the target version.",
        });
    });

    test("keeps a live model pick across the running turn and its retry", async () => {
        const requestedModels: string[] = [];
        let live: PiAgentSelection | undefined;
        const { client, faux } = makeClient({
            modelIds: ["faux-a", "faux-b"],
            liveSelection: () => live,
            responses: [
                (_context, _options, _state, model) => {
                    requestedModels.push(model.id);
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("request_needs_attention", {
                                reason: "missing_information",
                                message: "Need the target version.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                },
                (_context, _options, _state, model) => {
                    requestedModels.push(model.id);
                    return fauxAssistantMessage("Still working.");
                },
                (_context, _options, _state, model) => {
                    requestedModels.push(model.id);
                    return fauxAssistantMessage(
                        [fauxToolCall("submit_result", { ok: true })],
                        { stopReason: "toolUse" },
                    );
                },
            ],
        });
        const target = faux.getModel("faux-b");
        if (target === undefined) throw new Error("faux model missing");
        live = {
            model: { providerID: target.provider, modelID: target.id },
            variant: "low",
        };
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            format: { ...structuredFormat, retryCount: 1 },
            needsAttentionTool: {
                name: "request_needs_attention",
                description: "Request needs attention.",
                schema: { type: "object" },
            },
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
        expect(requestedModels).toEqual(["faux-a", "faux-b", "faux-b"]);
    });

    test("maps an output-length stop reason to an assistant error", async () => {
        const { client } = makeClient({
            responses: [fauxAssistantMessage("", { stopReason: "length" })],
        });
        const sessionID = await createSession(client, "/repo");

        const result = await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
        });

        expect(result.data?.info.error).toEqual({
            name: "MessageOutputLengthError",
        });
    });

    test("streams a tool-using turn to the listener as session events", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-tools-"));
        const received: Array<{
            readonly event: SessionEvent;
            readonly context: SessionEventContext;
        }> = [];
        try {
            await writeFile(join(directory, "hello.txt"), "hi there", "utf8");
            const { client } = makeClient({
                responses: [
                    fauxAssistantMessage(
                        [fauxToolCall("read", { path: "hello.txt" })],
                        { stopReason: "toolUse" },
                    ),
                    fauxAssistantMessage("done"),
                ],
                eventListener: (event, context) => {
                    received.push({ event, context });
                },
            });
            const sessionID = await createSession(client, directory);

            const result = await client.session.prompt({
                sessionID,
                directory,
                parts: [{ type: "text", text: "Read the file." }],
            });

            expect(result.data?.info.text).toBe("done");
            expect(received[0]?.context).toEqual({
                sessionID,
                directory,
                harness: "pi",
                title: "test",
            });
            const events = received.map(({ event }) => event);
            expect(events[0]).toEqual({ type: "session_started" });
            expect(events.at(-1)).toEqual({ type: "session_finished" });

            const call = events.find(
                (
                    event,
                ): event is Extract<SessionEvent, { type: "tool_call" }> =>
                    event.type === "tool_call",
            );
            expect(call).toMatchObject({
                name: "read",
                input: { path: "hello.txt" },
            });
            expect(
                events.find((event) => event.type === "tool_result"),
            ).toEqual({
                type: "tool_result",
                callId: call?.callId ?? "",
                name: "read",
                output: "hi there",
                isError: false,
            });
            expect(assistantText(events, "text")).toEqual(["done"]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("reports a failed tool call with its error output", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-tools-"));
        const events: SessionEvent[] = [];
        try {
            const { client } = makeClient({
                responses: [
                    fauxAssistantMessage(
                        [fauxToolCall("read", { path: "missing.txt" })],
                        { stopReason: "toolUse" },
                    ),
                    fauxAssistantMessage("done"),
                ],
                eventListener: (event) => {
                    events.push(event);
                },
            });
            const sessionID = await createSession(client, directory);

            await client.session.prompt({
                sessionID,
                directory,
                parts: [{ type: "text", text: "Read the file." }],
            });

            const toolResult = events.find(
                (
                    event,
                ): event is Extract<SessionEvent, { type: "tool_result" }> =>
                    event.type === "tool_result",
            );
            expect(toolResult).toMatchObject({ name: "read", isError: true });
            expect(toolResult?.output).toContain("missing.txt");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("streams thinking as its own assistant blocks", async () => {
        const events: SessionEvent[] = [];
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage([
                    fauxThinking("weighing options"),
                    fauxText("answer"),
                ]),
            ],
            eventListener: (event) => {
                events.push(event);
            },
        });
        const sessionID = await createSession(client, "/repo");

        await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Think." }],
        });

        expect(assistantText(events, "thinking")).toEqual(["weighing options"]);
        expect(assistantText(events, "text")).toEqual(["answer"]);
    });

    test("reports an assistant failure as an error event", async () => {
        const events: SessionEvent[] = [];
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage("", {
                    stopReason: "error",
                    errorMessage: "provider exploded",
                }),
            ],
            eventListener: (event) => {
                events.push(event);
            },
        });
        const sessionID = await createSession(client, "/repo");

        await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
        });

        expect(events).toContainEqual({
            type: "error",
            message: "provider exploded",
        });
        expect(events.at(-1)).toEqual({ type: "session_finished" });
    });

    test("reports the usage of every assistant response", async () => {
        const events: SessionEvent[] = [];
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage(
                    [fauxToolCall("bash", { command: "true" })],
                    {
                        stopReason: "toolUse",
                    },
                ),
                fauxAssistantMessage("done"),
            ],
            eventListener: (event) => {
                events.push(event);
            },
        });
        const sessionID = await createSession(client, "/repo");

        await client.session.prompt({
            sessionID,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
        });

        const usage = events.filter((event) => event.type === "usage");
        expect(usage).toHaveLength(2);
        for (const event of usage) {
            expect(event).toEqual({
                type: "usage",
                inputTokens: expect.any(Number),
                outputTokens: expect.any(Number),
                cacheReadTokens: expect.any(Number),
                cacheWriteTokens: expect.any(Number),
                costUsd: 0,
            });
        }
    });

    test("rejects an already-aborted signal before running the agent", async () => {
        const { client, faux } = makeClient({
            responses: [fauxAssistantMessage("never")],
        });
        const sessionID = await createSession(client, "/repo");
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));

        await expect(
            client.session.prompt(
                {
                    sessionID,
                    directory: "/repo",
                    parts: [{ type: "text", text: "Do the work." }],
                },
                { signal: controller.signal },
            ),
        ).rejects.toThrow("cancelled");
        expect(faux.state.callCount).toBe(0);
    });

    test("returns an error for an unknown session id", async () => {
        const { client } = makeClient({ responses: [] });

        const result = await client.session.prompt({
            sessionID: "missing",
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
        });

        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error)).toContain("Unknown pi session");
    });
});

describe("structured output through the pi client", () => {
    test("returns a validated result from the submission tool end to end", async () => {
        const { client } = makeClient({
            responses: [
                fauxAssistantMessage(
                    [fauxToolCall("submit_result", { ok: true })],
                    { stopReason: "toolUse" },
                ),
            ],
        });

        const result = await requestStructuredOutput(client, {
            directory: "/repo",
            title: "task",
            prompt: "Do the work.",
            schema: z.object({ ok: z.boolean() }),
        });

        expect(result.output).toEqual({ ok: true });
    });

    test("surfaces the model text in a wrapper error when the result is invalid", async () => {
        const { client } = makeClient({
            responses: [fauxAssistantMessage("no json here")],
        });
        const schema = z.object({ ok: z.boolean() });

        await expect(
            requestStructuredOutput(client, {
                directory: "/repo",
                title: "task",
                prompt: "Do the work.",
                schema,
                retryCount: 0,
            }),
        ).rejects.toThrow(/without calling the `submit_result` tool/);
    });
});