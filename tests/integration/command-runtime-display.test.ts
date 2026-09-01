import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import { NeedsAttentionStop } from "../../src/process/exit-code.ts";
import {
    makeCommandRuntimeHarness,
    type CommandRuntimeHarnessStep,
} from "./command-runtime-harness.ts";
import type { CodexSessionEvent } from "../../src/codex/client.ts";

describe("command/runtime display harness", () => {
    test("routes maintenance mode to its guarded entry point", async () => {
        const previousExitCode = process.exitCode;
        try {
            const harness = makeCommandRuntimeHarness();
            try {
                await expect(
                    harness.run([
                        "owner/repository",
                        "--mode",
                        "maintain-issues",
                    ]),
                ).rejects.toThrow(
                    "The maintain-issues execution mode is not implemented yet.",
                );
                expect(harness.lifecycle).not.toContain("workflow");
            } finally {
                await harness.cleanup();
            }
        } finally {
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("routes fake progress and Codex events through the command coordinator", async () => {
        const harness = makeCommandRuntimeHarness();
        try {
            await harness.run();
            await harness.dispose();
            await harness.dispose();

            expect(harness.stderr.join("")).toContain("Fake progress");
            expect(harness.stderr.join("")).toContain("fake Codex event");
            expect(harness.stdout).toEqual([]);
            expect(harness.codexEvents).toHaveLength(1);
            expect(harness.eventLogPath).toEndWith("events.jsonl");
            expect(harness.runtime?.githubClient).toBeDefined();
            expect(harness.runtime?.gitRepository).toBeDefined();
            expect(harness.runtime?.workspace).toBeDefined();
            expect(harness.lifecycle.slice(0, 3)).toEqual([
                "codex",
                "runtime",
                "workflow",
            ]);
            expect(
                harness.lifecycle.filter((call) => call === "runtime.dispose"),
            ).toHaveLength(1);
            expect(
                harness.lifecycle.filter(
                    (call) => call === "coordinator.dispose",
                ),
            ).toHaveLength(1);
            expect(harness.lifecycle).toContain("codex.start");
            expect(harness.lifecycle).toContain("codex.runtime.close");
            expect(harness.lifecycle).toContain("codex.client.close");
            expect(harness.lifecycle).toContain("output.dispose");
            expect(harness.disposalCalls).toEqual({
                runtime: 1,
                coordinator: 1,
                codexRuntime: 1,
                output: 1,
            });
            expect(harness.runCaptures[0]?.eventLogContents).toContain(
                '"stage":"implementation"',
            );
            expect(harness.writesAfterCleanup).toEqual([]);
        } finally {
            await harness.cleanup();
        }
    });

    test("still disposes the coordinator when runtime disposal fails", async () => {
        const harness = makeCommandRuntimeHarness();
        try {
            harness.failRuntimeDisposalWith(
                new Error("runtime disposal failed"),
            );

            await expect(harness.run()).rejects.toThrow(
                "runtime disposal failed",
            );
            expect(harness.lifecycle).toContain("runtime.dispose");
            expect(harness.lifecycle).toContain("coordinator.dispose");
        } finally {
            await harness.cleanup();
        }
    });

    test("releases an open transcript stream when the command signal aborts", async () => {
        const context = {
            sessionID: "cancel-session",
            directory: "/fake/workspace",
        };
        const codex = (event: object): CodexSessionEvent =>
            event as unknown as CodexSessionEvent;
        const steps = [
            { kind: "codex", event: codex({ type: "agent_start" }), context },
            {
                kind: "codex",
                event: codex({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_start" },
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        delta: "still streaming",
                    },
                }),
                context,
            },
            { kind: "wait-for-signal" },
        ] satisfies ReadonlyArray<CommandRuntimeHarnessStep>;
        const previousExitCode = process.exitCode;
        const harness = makeCommandRuntimeHarness({ steps });
        try {
            const pending = harness.run();
            await Bun.sleep(10);
            expect(harness.workflowSignals).toHaveLength(1);
            expect(harness.workflowSignals[0]).toBe(
                harness.abortController.signal,
            );
            harness.abortController.abort();
            await expect(pending).rejects.toThrow("operation was aborted");
            expect(process.exitCode).toBe(130);
            expect(harness.stderr.join("")).toContain("still streaming");
            expect(harness.disposalCalls).toEqual({
                runtime: 1,
                coordinator: 1,
                codexRuntime: 1,
                output: 1,
            });
            expect(harness.lifecycle).toContain("codex.client.close");
            expect(harness.writesAfterCleanup).toEqual([]);
        } finally {
            await harness.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("uses the rendered-line threshold in the real coordinator policy", async () => {
        const context = {
            sessionID: "threshold-session",
            directory: "/fake/workspace",
        };
        const codex = (event: object): CodexSessionEvent =>
            event as unknown as CodexSessionEvent;
        const steps = [
            { kind: "codex", event: codex({ type: "agent_start" }), context },
            {
                kind: "codex",
                event: codex({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_start" },
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        delta: "first\nsecond",
                    },
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_end" },
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({
                    type: "compaction_start",
                    reason: "threshold",
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({
                    type: "agent_end",
                    messages: [],
                    willRetry: false,
                }),
                context,
            },
            {
                kind: "codex",
                event: codex({ type: "agent_settled" }),
                context,
            },
        ] satisfies ReadonlyArray<CommandRuntimeHarnessStep>;
        const outputFor = async (renderedLineThreshold: number) => {
            const harness = makeCommandRuntimeHarness({
                steps,
                renderedLineThreshold,
                terminalWidth: 24,
            });
            try {
                await harness.run();
                return harness.stderr.join("");
            } finally {
                await harness.cleanup();
            }
        };

        expect(await outputFor(1)).toContain("› Compacting context");
        expect(await outputFor(100)).not.toContain("› Compacting context");
    });

    test("uses the package version for plain and JSON version output", async () => {
        const plainHarness = makeCommandRuntimeHarness();
        try {
            await plainHarness.run(["--version"]);

            expect(plainHarness.stdout).toEqual([`${packageJson.version}\n`]);
            expect(plainHarness.stderr).toEqual([]);
            expect(plainHarness.lifecycle).toEqual([]);
        } finally {
            await plainHarness.cleanup();
        }

        const jsonHarness = makeCommandRuntimeHarness();
        try {
            await jsonHarness.run(["--version", "--output", "json"]);

            expect(jsonHarness.stdout).toHaveLength(1);
            expect(JSON.parse(jsonHarness.stdout[0] ?? "")).toMatchObject({
                version: packageJson.version,
                commitSha: expect.any(String),
            });
            expect(jsonHarness.stderr).toEqual([]);
            expect(jsonHarness.lifecycle).toEqual([]);
        } finally {
            await jsonHarness.cleanup();
        }
    });

    test("writes complete needs-attention JSON Lines to stdout", async () => {
        const previousExitCode = process.exitCode;
        const harness = makeCommandRuntimeHarness({
            steps: [
                {
                    kind: "progress",
                    event: {
                        stage: "grounding",
                        status: "needs-attention",
                        message:
                            "Issue #42 needs attention (external_dependency): missing prerequisite.",
                        issue: {
                            number: 42,
                            title: "Missing prerequisite",
                        },
                        current: 1,
                        total: 3,
                        details: {
                            reason: "external_dependency",
                            summary: "missing prerequisite.",
                            evidence: ["The upstream issue remains open."],
                            questions: ["When will the upstream issue close?"],
                            diagnosticsPath: "/tmp/issue-42/metadata.json",
                            policy: "continue",
                            queuePosition: 1,
                            budget: 3,
                        },
                    },
                },
            ],
        });
        try {
            await harness.run([
                "owner/repository",
                "--dry-run",
                "--on-needs-attention",
                "continue",
                "--max-issues",
                "3",
                "--output",
                "json",
            ]);

            expect(harness.stderr).toEqual([]);
            const lines = harness.stdout
                .join("")
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatchObject({
                stage: "grounding",
                status: "needs-attention",
                issue: { number: 42, title: "Missing prerequisite" },
                current: 1,
                total: 3,
                details: {
                    reason: "external_dependency",
                    summary: "missing prerequisite.",
                    evidence: ["The upstream issue remains open."],
                    questions: ["When will the upstream issue close?"],
                    diagnosticsPath: "/tmp/issue-42/metadata.json",
                    policy: "continue",
                    queuePosition: 1,
                    budget: 3,
                },
            });
            expect(process.exitCode).toBe(0);
        } finally {
            await harness.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("maps a handled needs-attention stop to exit 2 after complete disposal", async () => {
        const previousExitCode = process.exitCode;
        const issue = { number: 42, title: "Missing prerequisite" };
        const steps = [
            {
                kind: "progress",
                event: {
                    stage: "grounding",
                    status: "needs-attention",
                    message:
                        "Issue #42 needs attention (external_dependency): missing prerequisite.",
                    issue,
                    current: 1,
                    total: 3,
                    details: {
                        reason: "external_dependency",
                        summary: "missing prerequisite.",
                        evidence: ["The upstream issue remains open."],
                        questions: ["When will the upstream issue close?"],
                        artifactPath: "/tmp/issue-42/artifacts.json",
                        policy: "halt",
                        queuePosition: 1,
                        budget: 3,
                    },
                },
            },
            {
                kind: "progress",
                event: {
                    stage: "run",
                    status: "needs-attention",
                    message:
                        "Run halted after issue #42 needs attention: 0 completed, 0 decomposed, 0 escalated, 1 needs-attention, 0 skipped, 0 failed.",
                    issue,
                    current: 1,
                    total: 3,
                    details: {
                        handled: true,
                        policy: "halt",
                        budget: 3,
                        counts: {
                            completed: 0,
                            decomposed: 0,
                            escalated: 0,
                            "needs-attention": 1,
                            skipped: 0,
                            failed: 0,
                        },
                    },
                },
            },
            {
                kind: "failure",
                error: new NeedsAttentionStop({
                    issueNumber: 42,
                    summary: "missing prerequisite",
                }),
            },
        ] satisfies ReadonlyArray<CommandRuntimeHarnessStep>;
        const harness = makeCommandRuntimeHarness({ steps });
        try {
            await harness.run([
                "owner/repository",
                "--dry-run",
                "--max-issues",
                "3",
                "--output",
                "quiet",
            ]);

            const output = harness.stderr.join("");
            expect(process.exitCode).toBe(2);
            expect(output).toContain("#42 Missing prerequisite");
            expect(output).toContain("Run halted after issue #42");
            expect(output).not.toContain("✗");
            expect(harness.disposalCalls).toEqual({
                runtime: 1,
                coordinator: 1,
                codexRuntime: 1,
                output: 1,
            });
            expect(harness.lifecycle).toContain("codex.client.close");
            expect(harness.writesAfterCleanup).toEqual([]);
        } finally {
            await harness.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("maps a drained continued run to 0 and ordinary failure to 1 after disposal", async () => {
        const previousExitCode = process.exitCode;
        const success = makeCommandRuntimeHarness({
            steps: [
                {
                    kind: "progress",
                    event: {
                        stage: "grounding",
                        status: "needs-attention",
                        message:
                            "Issue #42 needs attention (external_dependency): missing prerequisite.",
                        issue: {
                            number: 42,
                            title: "Missing prerequisite",
                        },
                        current: 1,
                        total: 1,
                        details: { policy: "continue", budget: 1 },
                    },
                },
                {
                    kind: "progress",
                    event: {
                        stage: "run",
                        status: "succeeded",
                        message:
                            "Run completed: 0 completed, 0 decomposed, 0 escalated, 1 needs-attention, 0 skipped, 0 failed.",
                        details: {
                            policy: "continue",
                            budget: 1,
                            counts: {
                                completed: 0,
                                decomposed: 0,
                                escalated: 0,
                                "needs-attention": 1,
                                skipped: 0,
                                failed: 0,
                            },
                        },
                    },
                },
            ],
        });
        try {
            await success.run([
                "owner/repository",
                "--dry-run",
                "--on-needs-attention",
                "continue",
                "--max-issues",
                "1",
            ]);
            expect(process.exitCode).toBe(0);
            expect(success.stderr.join("")).toContain("Run completed:");
            expect(success.stderr.join("")).toContain("1 needs-attention");
            expect(success.disposalCalls).toEqual({
                runtime: 1,
                coordinator: 1,
                codexRuntime: 1,
                output: 1,
            });
        } finally {
            await success.cleanup();
        }

        const failure = makeCommandRuntimeHarness({
            steps: [{ kind: "failure", error: new Error("ordinary failure") }],
        });
        try {
            await expect(failure.run()).rejects.toThrow("ordinary failure");
            expect(process.exitCode).toBe(1);
            expect(failure.disposalCalls).toEqual({
                runtime: 1,
                coordinator: 1,
                codexRuntime: 1,
                output: 1,
            });
            expect(failure.lifecycle).toContain("codex.client.close");
            expect(failure.writesAfterCleanup).toEqual([]);
        } finally {
            await failure.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("captures deterministic abort and failure triggers", async () => {
        const previousExitCode = process.exitCode;
        try {
            const harness = makeCommandRuntimeHarness();
            try {
                harness.abortController.abort();
                harness.failWith(new Error("fake failure"));
                harness.failRuntimeDisposalWith(
                    new Error("runtime disposal failed"),
                );

                await expect(harness.run()).rejects.toThrow("fake failure");
                expect(process.exitCode).toBe(130);
                expect(harness.lifecycle).toContain("runtime.dispose");
                expect(harness.lifecycle).toContain("coordinator.dispose");
            } finally {
                await harness.cleanup();
            }
        } finally {
            process.exitCode = previousExitCode ?? 0;
        }
    });
});