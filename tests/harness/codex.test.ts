import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeCodexAdapter } from "../../src/harness/adapters/codex.ts";
import {
    harnessAdapterContract,
    type RecordedStream,
} from "../contracts/harness-adapter.contract.ts";
import { makeScriptedRunner } from "./scripted-runner.ts";

const recorded = (name: string): RecordedStream => ({
    stdout: readFileSync(
        join(import.meta.dir, "fixtures", "codex", name),
        "utf8",
    ),
});

const written: string[] = [];
let disposed = 0;
const schemaFiles = {
    write: async (json: string) => {
        written.push(json);
        return {
            path: "/tmp/schema-test.json",
            dispose: async () => {
                disposed += 1;
            },
        };
    },
};

const turn = (overrides: Record<string, unknown> = {}) => ({
    prompt: "go",
    directory: "/work/repo",
    access: "safe" as const,
    timeoutMs: 1000,
    onEvent: () => undefined,
    ...overrides,
});

harnessAdapterContract({
    name: "codex",
    make: (runner) => makeCodexAdapter({ runner, schemaFiles }),
    executable: "codex",
    expectedCapabilities: { nativeSchema: true, budgetCap: false },
    commandLine: {
        always: {
            present: [["exec"], ["--json"], ["-"]],
            absent: ["--ephemeral"],
        },
        byAccess: {
            "read-only": {
                present: [["--sandbox", "read-only"]],
                absent: [
                    "--dangerously-bypass-approvals-and-sandbox",
                    "workspace-write",
                ],
            },
            safe: {
                present: [
                    ["--sandbox", "workspace-write"],
                    ["-c", "sandbox_workspace_write.network_access=true"],
                ],
                absent: ["--dangerously-bypass-approvals-and-sandbox"],
            },
            yolo: {
                present: [["--dangerously-bypass-approvals-and-sandbox"]],
                absent: ["--sandbox"],
            },
        },
        model: (model) => ({ present: [["--model", model]] }),
        effort: (effort) => ({
            present: [["-c", `model_reasoning_effort="${effort}"`]],
        }),
        budget: () => ({ present: [], absent: ["--max-budget-usd"] }),
        resume: (id) => ({
            present: [
                ["exec", "resume"],
                [id, "-"],
            ],
        }),
        schema: () => ({
            present: [["--output-schema", "/tmp/schema-test.json"]],
        }),
    },
    streams: {
        reply: {
            ...recorded("readonly-text.jsonl"),
            expect: {
                text: "ok",
                harnessSessionID: "01a10d01-f3fe-7eb2-a53b-c61f087c964d",
                events: [
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "ok",
                        done: true,
                    },
                    {
                        type: "usage",
                        inputTokens: 19526,
                        outputTokens: 5,
                        cacheReadTokens: 13184,
                        cacheWriteTokens: 0,
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
                        type: "assistant_text",
                        kind: "text",
                        text: "I’ll run the command now.\n",
                        done: true,
                    },
                    {
                        type: "tool_call",
                        callId: "item_2",
                        name: "shell",
                        input: { command: "/bin/zsh -lc 'echo ok > ok.txt'" },
                    },
                    {
                        type: "tool_result",
                        callId: "item_2",
                        name: "shell",
                        output: "",
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
                        inputTokens: 39934,
                        outputTokens: 50,
                        cacheReadTokens: 32896,
                        cacheWriteTokens: 0,
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
        ],
    },
});

test("codex ignores warning-level error items", async () => {
    const { runner } = makeScriptedRunner([recorded("readonly-text.jsonl")]);
    const outcome = await makeCodexAdapter({ runner, schemaFiles }).runTurn(
        turn(),
    );
    expect(outcome.ok).toBe(true);
});

test("codex writes the schema to a file and removes it afterwards", async () => {
    written.length = 0;
    disposed = 0;
    const { runner } = makeScriptedRunner([recorded("readonly-schema.jsonl")]);
    await makeCodexAdapter({ runner, schemaFiles }).runTurn(
        turn({ jsonSchema: { type: "object" } }),
    );
    expect(written).toEqual(['{"type":"object"}']);
    expect(disposed).toBe(1);
});

test("codex resume sets the sandbox through config", async () => {
    const { runner, invocations } = makeScriptedRunner([
        recorded("resume.jsonl"),
    ]);
    await makeCodexAdapter({ runner, schemaFiles }).runTurn(
        turn({ resumeSessionID: "abc" }),
    );
    const args = invocations[0]?.args ?? [];
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).not.toContain("--sandbox");
});