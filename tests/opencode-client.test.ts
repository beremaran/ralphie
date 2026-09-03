import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import {
    makeOpenCodeClient,
    type OpenCodeClientOptions,
    type OpenCodeMessage,
    type OpenCodeTransport,
} from "../src/opencode/client.ts";

const terminalMessage = (text: string): OpenCodeMessage => ({
    id: "m-1",
    type: "assistant",
    finish: "stop",
    content: [{ type: "text", text }],
});

const fencedJson = (value: unknown): string =>
    `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const structuredFormat = {
    type: "json_schema" as const,
    schema: {},
    retryCount: 0,
    validate: () => ({ success: true }) as const,
};

const makeFakeTransport = (
    wait: () => Promise<void> = async () => undefined,
    messages: () => ReadonlyArray<OpenCodeMessage> = () => [],
): OpenCodeTransport & {
    readonly waitCalls: () => number;
    readonly interruptCalls: () => number;
} => {
    let waitCalls = 0;
    let interruptCalls = 0;
    return {
        sessionCreate: async (input) => ({
            id: `session-${input.directory}`,
        }),
        sessionPrompt: async () => undefined,
        sessionWait: async () => {
            waitCalls += 1;
            await wait();
        },
        sessionInterrupt: async () => {
            interruptCalls += 1;
        },
        messageList: async () => [...messages()],
        waitCalls: () => waitCalls,
        interruptCalls: () => interruptCalls,
    };
};

const prompt = async (
    transport: OpenCodeTransport,
    clientOptions?: OpenCodeClientOptions,
    signal?: AbortSignal,
) => {
    const client = makeOpenCodeClient(transport, undefined, clientOptions);
    const created = await client.session.create({
        directory: "/repo",
        title: "test",
    });
    if (created.data === undefined) throw new Error("session create failed");
    return client.session.prompt(
        {
            sessionID: created.data.id,
            directory: "/repo",
            parts: [{ type: "text", text: "Do the work." }],
            format: structuredFormat,
        },
        signal === undefined ? undefined : { signal },
    );
};

describe("OpenCode client wait resilience", () => {
    test("retries a dropped wait and returns the structured output", async () => {
        let failuresRemaining = 1;
        const transport = makeFakeTransport(
            async () => {
                if (failuresRemaining > 0) {
                    failuresRemaining -= 1;
                    throw new Error("socket closed");
                }
            },
            () => [terminalMessage(fencedJson({ ok: true }))],
        );

        const result = await prompt(transport, {
            sessionWaitMaxRetries: 3,
            sessionWaitBackoffMs: 1,
        });

        expect(transport.waitCalls()).toBe(2);
        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
    });

    test("accepts a completed transcript when the wait keeps dropping", async () => {
        const transport = makeFakeTransport(
            async () => {
                throw new Error("socket closed");
            },
            () => [terminalMessage(fencedJson({ done: true }))],
        );

        const result = await prompt(transport, {
            sessionWaitMaxRetries: 2,
            sessionWaitBackoffMs: 1,
        });

        expect(transport.waitCalls()).toBe(3);
        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ done: true });
    });

    test("fails when the wait keeps dropping and the turn is incomplete", async () => {
        const transport = makeFakeTransport(
            async () => {
                throw new Error("socket closed");
            },
            () => [],
        );

        await expect(
            prompt(transport, {
                sessionWaitMaxRetries: 2,
                sessionWaitBackoffMs: 1,
            }),
        ).rejects.toThrow(/session wait disconnected 3 times/);
    });

    test("stops retrying and interrupts when the caller aborts mid-wait", async () => {
        const controller = new AbortController();
        const transport = makeFakeTransport(
            async () => {
                controller.abort();
                throw new Error("socket closed");
            },
            () => [],
        );

        await expect(
            prompt(
                transport,
                { sessionWaitMaxRetries: 3, sessionWaitBackoffMs: 1 },
                controller.signal,
            ),
        ).rejects.toThrow();

        expect(transport.interruptCalls()).toBeGreaterThanOrEqual(1);
    });
});

describe("structured output failure reporting", () => {
    test("surfaces the underlying transport cause in the wrapper error", async () => {
        const transport = makeFakeTransport(
            async () => undefined,
            () => {
                throw { name: "ClientError", message: "Transport" };
            },
        );
        const client = makeOpenCodeClient(transport, undefined, {
            sessionWaitMaxRetries: 1,
            sessionWaitBackoffMs: 1,
        });
        const schema = z.object({ ok: z.boolean() });

        await expect(
            requestStructuredOutput(client, {
                directory: "/repo",
                title: "task",
                prompt: "Do the work.",
                schema,
            }),
        ).rejects.toThrow(/Cause: ClientError: Transport/);
    });
});

describe("silent turn detection", () => {
    test("fails fast without retrying when the turn produces no assistant message", async () => {
        const transport = makeFakeTransport(
            async () => undefined,
            () => [],
        );

        await expect(
            prompt(transport, {
                sessionWaitMaxRetries: 1,
                sessionWaitBackoffMs: 1,
                silentTurnSettleMs: 1,
            }),
        ).rejects.toThrow(
            /completed the turn without producing any assistant response/,
        );

        expect(transport.waitCalls()).toBe(1);
    });

    test("recovers when the assistant message lands during the settle window", async () => {
        let calls = 0;
        const transport = makeFakeTransport(
            async () => undefined,
            () => {
                calls += 1;
                return calls === 1
                    ? []
                    : [terminalMessage(fencedJson({ ok: true }))];
            },
        );

        const result = await prompt(transport, {
            sessionWaitMaxRetries: 1,
            sessionWaitBackoffMs: 1,
            silentTurnSettleMs: 5,
        });

        expect(result.error).toBeUndefined();
        expect(result.data?.info.structured).toEqual({ ok: true });
    });

    test("unstructured prompts fail fast on a silent turn", async () => {
        const transport = makeFakeTransport(
            async () => undefined,
            () => [],
        );
        const client = makeOpenCodeClient(transport, undefined, {
            sessionWaitMaxRetries: 1,
            sessionWaitBackoffMs: 1,
            silentTurnSettleMs: 1,
        });
        const created = await client.session.create({
            directory: "/repo",
            title: "test",
        });
        if (created.data === undefined)
            throw new Error("session create failed");

        await expect(
            client.session.prompt({
                sessionID: created.data.id,
                directory: "/repo",
                parts: [{ type: "text", text: "Do the work." }],
            }),
        ).rejects.toThrow(
            /completed the turn without producing any assistant response/,
        );
    });
});

describe("structured contract failure diagnostics", () => {
    test("emits the transcript and includes a response preview", async () => {
        const events: Array<{ readonly type: string }> = [];
        const transport = makeFakeTransport(
            async () => undefined,
            () => [terminalMessage("analysis without any json payload")],
        );
        const client = makeOpenCodeClient(
            transport,
            (event) => {
                events.push(event as { readonly type: string });
            },
            {
                sessionWaitMaxRetries: 1,
                sessionWaitBackoffMs: 1,
            },
        );
        const created = await client.session.create({
            directory: "/repo",
            title: "test",
        });
        if (created.data === undefined)
            throw new Error("session create failed");

        const failure = await client.session
            .prompt({
                sessionID: created.data.id,
                directory: "/repo",
                parts: [{ type: "text", text: "Do the work." }],
                format: structuredFormat,
            })
            .catch((error: unknown) => error);
        expect(String((failure as Error)?.message ?? failure)).toMatch(
            /Last response preview/,
        );
        expect(events.some((event) => event.type === "message_update")).toBe(
            true,
        );
    });
});