import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { makeHarnessService } from "../../src/harness/app/harness-service.ts";
import { makePiCliAdapter } from "../../src/harness/adapters/pi-cli.ts";
import type { TurnRequest } from "../../src/harness/ports.ts";
import {
    harnessAdapterContract,
    type RecordedStream,
} from "../contracts/harness-adapter.contract.ts";
import { makeScriptedRunner } from "./scripted-runner.ts";

const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "fixtures", "pi", name), "utf8");

const recorded = (name: string): RecordedStream => ({
    stdout: fixture(name),
});

const jsonLines = (records: readonly unknown[]): string =>
    records.map((record) => JSON.stringify(record)).join("\n");

const assistantEnd = (
    stopReason: string,
    content: readonly unknown[],
    extra: Record<string, unknown> = {},
) => ({
    type: "message_end",
    message: { role: "assistant", stopReason, content, ...extra },
});

harnessAdapterContract({
    name: "pi-cli",
    make: (runner) => makePiCliAdapter({ runner }),
    executable: "pi",
    expectedCapabilities: { nativeSchema: false, budgetCap: false },
    commandLine: {
        always: {
            present: [["--mode", "json"], ["-p"]],
            absent: ["--no-session"],
        },
        byAccess: {
            "read-only": {
                present: [["--tools", "read,grep,find,ls"]],
                absent: ["bash", "write", "edit"],
            },
            safe: { present: [], absent: ["--tools"] },
            yolo: { present: [], absent: ["--tools"] },
        },
        model: (model) => ({ present: [["--model", model]] }),
        effort: (effort) => ({ present: [["--thinking", effort]] }),
        budget: () => ({ present: [], absent: ["--max-budget-usd"] }),
        resume: (id) => ({ present: [["--session", id]] }),
    },
    streams: {
        reply: {
            ...recorded("readonly-text.jsonl"),
            expect: {
                text: "ok",
                harnessSessionID: "01a10d04-b5ca-7529-8975-3273f5838e7b",
                events: [
                    {
                        type: "assistant_text",
                        kind: "thinking",
                        text: "The user asked me to reply with the word ok.\n",
                        done: true,
                    },
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "ok",
                        done: true,
                    },
                    {
                        type: "usage",
                        inputTokens: 4,
                        outputTokens: 16,
                        cacheReadTokens: 4848,
                        cacheWriteTokens: 0,
                    },
                ],
            },
        },
        toolUse: {
            ...recorded("yolo-edit.jsonl"),
            expect: {
                text: "done",
                events: [
                    {
                        type: "assistant_text",
                        kind: "thinking",
                        text: 'The user wants me to create a file ok.txt with the word "ok", then reply "done".\n',
                        done: true,
                    },
                    {
                        type: "tool_call",
                        callId: "qAlNCsnFZj9QjCYs68eh8VwNkxz5Ku02",
                        name: "write",
                        input: { path: "/work/repo/ok.txt", content: "ok" },
                    },
                    {
                        type: "tool_result",
                        callId: "qAlNCsnFZj9QjCYs68eh8VwNkxz5Ku02",
                        name: "write",
                        output: "Successfully wrote to /work/repo/ok.txt",
                        isError: false,
                    },
                    {
                        type: "assistant_text",
                        kind: "thinking",
                        text: 'The user wants me to create a file ok.txt with the word "ok", then reply with the word "done".\n',
                        done: true,
                    },
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "done",
                        done: true,
                    },
                    {
                        type: "usage",
                        inputTokens: 5036,
                        outputTokens: 132,
                        cacheReadTokens: 5075,
                        cacheWriteTokens: 0,
                    },
                ],
            },
        },
        failures: [
            {
                name: "a failed response that exits 0 (auth)",
                ...recorded("failed-response-exit0.jsonl"),
                access: "read-only",
                expect: {
                    kind: "harness",
                    messageIncludes: "OAuth refresh failed",
                },
            },
            {
                name: "a response that failed after every retry",
                ...recorded("failed-retry-exit0.jsonl"),
                access: "read-only",
                expect: {
                    kind: "harness",
                    messageIncludes: "OpenCode Go subscription",
                },
            },
        ],
    },
});

const request = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
    prompt: "p",
    directory: "/work/repo",
    access: "read-only",
    timeoutMs: 1000,
    onEvent: () => undefined,
    ...overrides,
});

describe("pi cli adapter specifics", () => {
    test("parses recorded output containing U+2028 and U+2029", async () => {
        const { runner } = makeScriptedRunner([
            recorded("fallback-json-u2028.jsonl"),
        ]);
        const outcome = await makePiCliAdapter({ runner }).runTurn(request());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.text.endsWith('{"answer": "ok"}')).toBe(true);
    });

    test("keeps U+2028 and U+2029 inside a line", async () => {
        const stdout = jsonLines([
            { type: "session", id: "s1" },
            assistantEnd("stop", [{ type: "text", text: "a b c" }]),
        ]);
        const { runner } = makeScriptedRunner([{ stdout }]);
        const outcome = await makePiCliAdapter({ runner }).runTurn(request());
        expect(outcome).toMatchObject({ ok: true, text: "a b c" });
    });

    test("succeeds when a retry recovers after an error response", async () => {
        const stdout = jsonLines([
            { type: "session", id: "s1" },
            assistantEnd("error", [], { errorMessage: "boom" }),
            { type: "auto_retry_start", attempt: 1 },
            assistantEnd("stop", [{ type: "text", text: "ok" }]),
        ]);
        const { runner } = makeScriptedRunner([{ stdout }]);
        const outcome = await makePiCliAdapter({ runner }).runTurn(request());
        expect(outcome).toMatchObject({ ok: true, text: "ok" });
    });

    test("fails on an aborted response and keeps the session id", async () => {
        const stdout = jsonLines([
            { type: "session", id: "s1" },
            assistantEnd("aborted", []),
        ]);
        const { runner } = makeScriptedRunner([{ stdout }]);
        const outcome = await makePiCliAdapter({ runner }).runTurn(request());
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "harness", harnessSessionID: "s1" },
        });
    });

    test("fails on a non-zero exit even after a successful response", async () => {
        const stdout = jsonLines([
            { type: "session", id: "s1" },
            assistantEnd("stop", [{ type: "text", text: "ok" }]),
        ]);
        const { runner } = makeScriptedRunner([{ stdout, exitCode: 2 }]);
        const outcome = await makePiCliAdapter({ runner }).runTurn(request());
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "exit" },
        });
    });
});

describe("pi cli adapter through the harness service", () => {
    const ids = { next: () => "ralphie-session" };
    const schema = z.object({ answer: z.string() });

    test("resolves a structured result from the JSON block fallback", async () => {
        const reply = (text: string, id: string) =>
            jsonLines([
                { type: "session", id },
                assistantEnd("stop", [{ type: "text", text }]),
            ]);
        const { runner, invocations } = makeScriptedRunner([
            { stdout: reply("no block here", "pi-1") },
            {
                stdout: reply('Fixed.\n```json\n{"answer": "ok"}\n```', "pi-1"),
            },
        ]);
        const service = makeHarnessService({
            adapters: { pi: makePiCliAdapter({ runner }) },
            listener: () => undefined,
            ids,
        });
        const outcome = await service.run({
            role: "implementer",
            harness: "pi",
            prompt: "do it",
            directory: "/work/repo",
            access: "yolo",
            timeoutMs: 1000,
            resultSchema: schema,
        });
        expect(outcome).toMatchObject({ ok: true, value: { answer: "ok" } });
        expect(invocations).toHaveLength(2);
        expect(invocations[1]?.args).toEqual(
            expect.arrayContaining(["--session", "pi-1"]),
        );
        expect(invocations[0]?.args.join(" ")).not.toContain("schema");
    });
});