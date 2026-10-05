import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { makeOpenCodeAdapter } from "../../src/harness/adapters/opencode.ts";
import type { TurnEvent } from "../../src/harness/ports.ts";
import {
    harnessAdapterContract,
    type RecordedStream,
} from "../contracts/harness-adapter.contract.ts";
import { makeScriptedRunner } from "./scripted-runner.ts";

const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "fixtures", "opencode", name), "utf8");

const recorded = (name: string, exitCode = 0): RecordedStream => ({
    stdout: fixture(name),
    exitCode,
});

harnessAdapterContract({
    name: "opencode",
    make: (runner) => makeOpenCodeAdapter({ runner }),
    executable: "opencode",
    expectedCapabilities: { nativeSchema: false, budgetCap: false },
    commandLine: {
        always: {
            present: [["run"], ["--standalone"], ["--format", "json"]],
        },
        byAccess: {
            "read-only": {
                present: [["--agent", "plan"]],
                absent: ["--auto"],
            },
            safe: {
                refuses: { messageIncludes: "yolo" },
            },
            yolo: {
                present: [["--auto"]],
                absent: ["--agent"],
            },
        },
        // The contract passes model and effort together, and effort is the
        // model variant suffix (`model#effort`), so both checks see one flag.
        model: (model) => ({ present: [["--model", `${model}#high`]] }),
        effort: (effort) => ({
            present: [["--model", `some-model#${effort}`]],
        }),
        budget: () => ({ present: [], absent: ["--max-budget-usd"] }),
        resume: (id) => ({ present: [["--session", id]] }),
    },
    streams: {
        reply: {
            ...recorded("text.jsonl"),
            expect: {
                text: "ok",
                harnessSessionID: "ses_ef2fa645bfferRStt6btCWQLtC",
                events: [
                    {
                        type: "assistant_text",
                        kind: "text",
                        text: "ok",
                        done: true,
                    },
                ],
            },
        },
        toolUse: {
            ...recorded("auto-edit.jsonl"),
            access: "yolo",
            expect: {
                text: "done",
                events: [
                    {
                        type: "tool_call",
                        callId: "call_26cb9bf2987c4baabfd32962",
                        name: "execute",
                        input: {
                            code: 'const r = await tools.shell["run"]({ command: "echo ok > ok.txt" });\nreturn r;',
                        },
                    },
                    {
                        type: "tool_result",
                        callId: "call_26cb9bf2987c4baabfd32962",
                        name: "execute",
                        output: "Unknown tool 'shell.run'. Did you mean tools.opencode.models?\nUse search to find available tools.",
                        isError: true,
                    },
                    {
                        type: "tool_call",
                        callId: "call_c419c74e4148454caf7a11bf",
                        name: "shell",
                        input: { command: "echo ok > ok.txt" },
                    },
                    {
                        type: "tool_result",
                        callId: "call_c419c74e4148454caf7a11bf",
                        name: "shell",
                        output: "(no output)",
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
                        inputTokens: 7536,
                        outputTokens: 115,
                        cacheReadTokens: 16320,
                        cacheWriteTokens: 0,
                    },
                ],
            },
        },
        failures: [
            {
                name: "an unknown model",
                ...recorded("bad-model.jsonl", 1),
                access: "read-only",
                expect: {
                    kind: "model",
                    messageIncludes: "Model unavailable: nope/none",
                },
            },
            {
                name: "a provider that is out of credits",
                ...recorded("quota.jsonl", 1),
                access: "read-only",
                expect: {
                    kind: "harness",
                    messageIncludes: "Insufficient credits",
                },
            },
        ],
    },
});

describe("opencode adapter specifics", () => {
    const run = async (stdout: string, resume?: string) => {
        const { runner, invocations } = makeScriptedRunner([{ stdout }]);
        const events: TurnEvent[] = [];
        const outcome = await makeOpenCodeAdapter({ runner }).runTurn({
            prompt: "p",
            directory: "/work/repo",
            access: "yolo",
            timeoutMs: 1000,
            ...(resume === undefined ? {} : { resumeSessionID: resume }),
            onEvent: (event) => events.push(event),
        });
        return { outcome, events, invocations };
    };

    test("a skill loaded headlessly runs as an ordinary tool call", async () => {
        const { outcome, events } = await run(fixture("skill.jsonl"));
        expect(outcome).toMatchObject({ ok: true, text: "SKILL-OK" });
        expect(events[0]).toMatchObject({
            type: "tool_call",
            name: "skill",
            input: { id: "say-ok" },
        });
    });

    test("the final message is only the last step's text", async () => {
        const { outcome } = await run(fixture("auto-edit.jsonl"));
        expect(outcome).toMatchObject({ ok: true, text: "done" });
    });

    test("an error event fails the run even when the exit code is zero", async () => {
        const { outcome } = await run(fixture("quota.jsonl"));
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "harness" },
        });
    });

    test("no model flag is passed unless a model is given", async () => {
        const { invocations } = await run(fixture("text.jsonl"));
        expect(invocations[0]?.args).not.toContain("--model");
    });
});