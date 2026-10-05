import { join } from "node:path";
import { readFileSync } from "node:fs";

import { makeClaudeCodeAdapter } from "../../src/harness/adapters/claude-code.ts";
import {
    harnessAdapterContract,
    type RecordedStream,
} from "../contracts/harness-adapter.contract.ts";

const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "fixtures", "claude", name), "utf8");

const recorded = (name: string): RecordedStream => ({
    stdout: fixture(name),
});

const readOnlyTools = ["--tools", "Read,Glob,Grep"];

harnessAdapterContract({
    name: "claude-code",
    make: (runner) => makeClaudeCodeAdapter({ runner }),
    executable: "claude",
    expectedCapabilities: { nativeSchema: true, budgetCap: true },
    commandLine: {
        always: {
            present: [
                ["-p"],
                ["--output-format", "stream-json"],
                ["--verbose"],
            ],
            absent: ["--bare"],
        },
        byAccess: {
            "read-only": {
                present: [["--permission-mode", "plan"], readOnlyTools],
                absent: ["bypassPermissions", "auto"],
            },
            safe: {
                present: [["--permission-mode", "auto"]],
                absent: ["bypassPermissions", "plan", "--tools"],
            },
            yolo: {
                present: [["--permission-mode", "bypassPermissions"]],
                absent: ["auto", "plan", "--tools"],
            },
        },
        model: (model) => ({ present: [["--model", model]] }),
        effort: (effort) => ({ present: [["--effort", effort]] }),
        budget: (usd) => ({ present: [["--max-budget-usd", String(usd)]] }),
        resume: (id) => ({ present: [["--resume", id]] }),
        schema: (json) => ({ present: [["--json-schema", json]] }),
    },
    streams: {
        reply: {
            ...recorded("readonly-text.jsonl"),
            expect: {
                text: "ok",
                harnessSessionID: "b22f1c31-d9a8-4cf3-983a-321a871891e7",
                events: [
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "ok",
                        done: true,
                    },
                    {
                        type: "usage",
                        inputTokens: 2,
                        outputTokens: 90,
                        cacheReadTokens: 3001,
                        cacheWriteTokens: 3800,
                        costUsd: 0.0167042,
                    },
                ],
            },
        },
        toolUse: {
            ...recorded("safe-edit.jsonl"),
            expect: {
                text: "done",
                events: [
                    {
                        type: "tool_call",
                        callId: "toolu_01RWF1B8UNyfSr9EYXkcaim3",
                        name: "Write",
                        input: {
                            file_path: "/work/repo/ok.txt",
                            content: "ok\n",
                        },
                    },
                    {
                        type: "tool_result",
                        callId: "toolu_01RWF1B8UNyfSr9EYXkcaim3",
                        name: "Write",
                        output: "File created successfully at: /work/repo/ok.txt (file state is current in your context - no need to Read it back)",
                        isError: false,
                    },
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "done",
                        done: true,
                    },
                    {
                        type: "usage",
                        inputTokens: 4,
                        outputTokens: 130,
                        cacheReadTokens: 24176,
                        cacheWriteTokens: 4034,
                        costUsd: 0.022279200000000002,
                    },
                ],
            },
        },
        structured: {
            ...recorded("readonly-schema.jsonl"),
            expect: { structured: { answer: "ok" } },
        },
        failures: [
            {
                name: "an unknown model",
                ...recorded("bad-model.jsonl"),
                access: "read-only",
                expect: {
                    kind: "model",
                    messageIncludes: "no-such-model-xyz",
                },
            },
            {
                name: "an exhausted budget",
                ...recorded("budget-exceeded.jsonl"),
                access: "read-only",
                expect: {
                    kind: "budget",
                    messageIncludes: "Reached maximum budget",
                },
            },
            {
                name: "a silent fall back to manual approval",
                ...recorded("auto-fallback-haiku.jsonl"),
                access: "safe",
                expect: { kind: "access", messageIncludes: "auto" },
            },
        ],
    },
});