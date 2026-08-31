import { describe, expect, test } from "bun:test";

import type { PiSessionEvent } from "../../src/pi/client.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type { TerminalOutputStrategy } from "../../src/progress/terminal-controller.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): PiSessionEvent => value as PiSessionEvent;

const makeBreadcrumbCoordinator = (threshold = 4) => {
    let output = "";
    const coordinator = makeProgressCoordinator({
        mode: "plain",
        verbose: false,
        colors: false,
        breadcrumbThreshold: threshold,
        write: (text) => {
            output += text;
        },
    });
    return {
        coordinator,
        get output() {
            return output;
        },
    };
};

const primeRows = (
    coordinator: ReturnType<typeof makeProgressCoordinator>,
    text = "one\ntwo",
): void => {
    coordinator.listener(
        event({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: text },
        }),
        context,
    );
};

const makeFooterTimer = (): {
    readonly timer: FooterTimer;
    readonly flush: () => void;
    readonly cancelled: number;
} => {
    const callbacks: Array<() => void> = [];
    let cancelled = 0;
    return {
        timer: {
            schedule: (callback) => {
                callbacks.push(callback);
                return callbacks.length;
            },
            cancel: () => {
                cancelled += 1;
            },
        },
        flush: () => callbacks.shift()?.(),
        get cancelled() {
            return cancelled;
        },
    };
};

const makeFooterSurface = (): {
    readonly strategy: TerminalOutputStrategy;
    readonly content: string[];
    readonly footers: string[];
    readonly restores: number;
} => {
    const content: string[] = [];
    const footers: string[] = [];
    let restores = 0;
    return {
        strategy: {
            write: (text) => content.push(text),
            paintFooter: (text) => footers.push(text),
            clearFooter: () => {},
            restore: () => {
                restores += 1;
            },
        },
        content,
        footers,
        get restores() {
            return restores;
        },
    };
};

describe("progress output coordinator", () => {
    test("updates display state before rendering either stream", async () => {
        let coordinator: ReturnType<typeof makeProgressCoordinator>;
        const observed: string[] = [];
        coordinator = makeProgressCoordinator({
            mode: "plain",
            verbose: false,
            write: (text) => {
                observed.push(
                    `${coordinator.getDisplayState().stage ?? "none"}:${text}`,
                );
            },
        });

        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
        });
        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "partial",
                },
            }),
            context,
        );

        expect(observed[0]).toContain("implementation:◐ Implementing...");
        expect(observed.at(-1)).toContain("implementation:partial");
        expect(coordinator.getDisplayState().activity).toBe("responding");
    });

    test("passes complete reduced workflow context to session headers", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "plain",
            verbose: false,
            colors: false,
            write: (text) => {
                output += text;
            },
        });

        await coordinator.progress.emit({
            stage: "review-fix",
            status: "started",
            message: "Fixing review.",
            repository: "owner/repo",
            issue: { number: 56, title: "Context" },
            current: 2,
            total: 4,
            attempt: 1,
            maxAttempts: 3,
        });
        coordinator.listener(event({ type: "agent_start" }), context);

        expect(output).toContain(
            "╭─ Pi · Task · session-1 · owner/repo · issue 2/4 · #56 · Addressing review findings · attempt 1/3\n",
        );
    });

    test("routes partial transcript output through the shared sink", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => {
                output += text;
            },
            width: () => 80,
        });

        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
        });
        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "partial token",
                },
            }),
            context,
        );
        await coordinator.progress.emit({
            stage: "implementation",
            status: "info",
            message: "Still working.",
        });
        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "continued",
                },
            }),
            context,
        );

        expect(output).toContain(
            "◐ › Implementing changes › Waiting · 0s\r\x1b[2K╭─ Pi · Task · session-1 · Implementing changes\n",
        );
        expect(output).toContain("│  ✦ assistant partial token");
        expect(output).toContain("• Still working.");
        expect(output).toContain("│    continued");
        expect(output).not.toContain("◐ Implementing...");
    });

    test("interrupts a partial Pi chunk before a subsequent event", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => {
                output += text;
            },
            width: () => 80,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
        });

        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
        });
        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "partial",
                },
            }),
            context,
        );
        coordinator.listener(event({ type: "turn_end" }), context);

        expect(output).toContain("│  ✦ assistant partial\n");
        expect(output).toEndWith("◐ › Implementing changes › Waiting · 0s");
        await coordinator.dispose();
    });

    test("keeps the sticky footer aligned with nested stages and Pi activity", async () => {
        const timer = makeFooterTimer();
        const surface = makeFooterSurface();
        const issue = { number: 63, title: "Footer coordinator" };
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => surface.content.push(text),
            strategy: surface.strategy,
            width: () => 200,
            footer: { timer: timer.timer },
            now: () => new Date("2026-01-01T00:00:00.000Z"),
        });

        await coordinator.progress.emit({
            stage: "issue-execution",
            status: "started",
            message: "Executing issue...",
            repository: "owner/repo",
            issue,
            current: 2,
            total: 5,
            attempt: 2,
            maxAttempts: 4,
        });
        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
            issue,
        });
        timer.flush();

        const activityLabels: string[] = [];
        const send = (value: unknown): void => {
            coordinator.listener(event(value), context);
            timer.flush();
            activityLabels.push(coordinator.getDisplayState().activityLabel);
        };
        send(event({ type: "agent_start" }));
        send(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "thinking",
                },
            }),
        );
        send(
            event({
                type: "message_update",
                assistantMessageEvent: { type: "thinking_end" },
            }),
        );
        send(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "partial ",
                },
            }),
        );
        send(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "token",
                },
            }),
        );
        send(
            event({
                type: "message_update",
                assistantMessageEvent: { type: "text_end" },
            }),
        );
        send(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "bash",
                args: { command: "printf output" },
            }),
        );
        send(event({ type: "compaction_start", reason: "threshold" }));
        send(
            event({
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 10,
                errorMessage: "temporary",
            }),
        );
        send(event({ type: "auto_retry_end", success: true, attempt: 1 }));
        send(event({ type: "agent_settled" }));

        expect(activityLabels).toEqual([
            "Thinking",
            "Thinking",
            "Thinking",
            "Responding",
            "Responding",
            "Responding",
            "Using bash",
            "Compacting context",
            "Retrying",
            "Waiting",
            "Waiting",
        ]);
        expect(coordinator.getDisplayState()).toMatchObject({
            repository: "owner/repo",
            issue: { current: 2, total: 5, number: 63 },
            stage: "implementation",
            reviewAttempt: { current: 2, total: 4 },
            activity: "waiting",
            activityLabel: "Waiting",
        });
        expect(surface.content.join("")).toContain("partial ");
        expect(surface.content.join("")).toContain("│    token");
        expect(
            surface.footers.some((line) =>
                line.startsWith(
                    "◐ [owner/repo] [2/5] #63 Footer coordinator Review 2/4 › Implementing changes",
                ),
            ),
        ).toBeTrue();
        for (const label of [
            "Thinking",
            "Responding",
            "Using bash",
            "Compacting context",
            "Retrying",
            "Waiting",
        ]) {
            expect(
                surface.footers.some((line) => line.includes(`› ${label}`)),
            ).toBeTrue();
        }
        expect(
            surface.footers.some((line) => line.endsWith("· 0s")),
        ).toBeTrue();
        await coordinator.dispose();
    });

    test("keeps non-interactive coordinator modes footer-free", async () => {
        const modes = [
            { label: "plain", mode: "plain" },
            { label: "CI-resolved plain", mode: "plain" },
            { label: "JSON", mode: "json" },
            { label: "quiet", mode: "quiet" },
        ] as const;

        for (const { label, mode } of modes) {
            let output = "";
            const surface = makeFooterSurface();
            let resizeSubscriptions = 0;
            const coordinator = makeProgressCoordinator({
                mode,
                verbose: false,
                colors: false,
                write: (text) => {
                    output += text;
                },
                strategy: surface.strategy,
                resize: () => {
                    resizeSubscriptions += 1;
                    return () => {};
                },
            });

            await coordinator.progress.emit({
                stage: "implementation",
                status: "started",
                message: `${label} started.`,
            });
            coordinator.listener(
                event({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        delta: "partial",
                    },
                }),
                context,
            );
            await coordinator.progress.emit({
                stage: "implementation",
                status: "failed",
                message: `${label} failed.`,
            });
            await coordinator.dispose();

            expect(surface.footers).toHaveLength(0);
            expect(resizeSubscriptions).toBe(0);
            expect(output).not.toContain("\r");
            expect(output).not.toContain("\x1b");
        }
    });

    test("cleans up the footer controller when the coordinator is disposed", async () => {
        const timer = makeFooterTimer();
        const surface = makeFooterSurface();
        let resizeRemovals = 0;
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => surface.content.push(text),
            strategy: surface.strategy,
            footer: { timer: timer.timer },
            resize: () => () => {
                resizeRemovals += 1;
            },
        });

        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
        });
        const contentBeforeDispose = surface.content.length;
        await coordinator.dispose();
        await coordinator.dispose();
        coordinator.listener(event({ type: "turn_start" }), context);
        await coordinator.progress.emit({
            stage: "implementation",
            status: "info",
            message: "ignored",
        });

        expect(timer.cancelled).toBe(1);
        expect(resizeRemovals).toBe(1);
        expect(surface.restores).toBe(1);
        expect(surface.content).toHaveLength(contentBeforeDispose + 1);
        expect(surface.footers).toHaveLength(1);
    });

    test("keeps plain append-only and quiet failures-only", async () => {
        let plainOutput = "";
        const plain = makeProgressCoordinator({
            mode: "plain",
            verbose: false,
            colors: false,
            write: (text) => {
                plainOutput += text;
            },
        });
        plain.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "partial",
                },
            }),
            context,
        );
        await plain.progress.emit({
            stage: "implementation",
            status: "info",
            message: "Progress.",
        });

        expect(plainOutput).not.toContain("\r");
        expect(plainOutput).not.toContain("\x1b");
        expect(plainOutput).toEndWith("Progress.\n");

        let quietOutput = "";
        const quiet = makeProgressCoordinator({
            mode: "quiet",
            verbose: false,
            write: (text) => {
                quietOutput += text;
            },
        });
        quiet.listener(event({ type: "turn_start" }), context);
        await quiet.progress.emit({
            stage: "implementation",
            status: "succeeded",
            message: "Done.",
        });
        await quiet.progress.emit({
            stage: "implementation",
            status: "failed",
            message: "Failed.",
        });

        expect(quietOutput).toBe("✗ Failed.\n");
    });

    test("tracks line state across colored transcript chunks", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: true,
            write: (text) => {
                output += text;
            },
        });

        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "complete\n",
                },
            }),
            context,
        );
        await coordinator.progress.emit({
            stage: "implementation",
            status: "info",
            message: "Progress.",
        });

        expect(output).toContain("Progress.\n");
        expect(output).toEndWith(
            "\x1b[90m◐ › Implementing changes › Waiting · 0s\x1b[0m",
        );
        expect(output).not.toContain("\n\n");
    });

    test("keeps JSON output as lossless progress and Pi JSON Lines", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "json",
            verbose: false,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });

        await coordinator.progress.emit({
            stage: "run",
            status: "info",
            message: "started",
        });
        coordinator.listener(event({ type: "turn_start" }), context);

        const lines = output
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(lines).toHaveLength(2);
        expect(lines[0]).not.toHaveProperty("type");
        expect(lines[0]).toMatchObject({ stage: "run" });
        expect(lines[1]).toMatchObject({
            type: "pi_event",
            event: { type: "turn_start" },
        });
        expect(output).not.toContain("╭─");
    });

    test("disposes only once and finishes a partial line", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "plain",
            verbose: false,
            write: (text) => {
                output += text;
            },
        });

        coordinator.listener(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "unfinished",
                },
            }),
            context,
        );
        await coordinator.dispose();
        await coordinator.dispose();

        expect(output).toEndWith("unfinished\n");
        expect(output.match(/unfinished/g)).toHaveLength(1);
    });

    test("prefers a tool-completion breadcrumb over the periodic candidate", () => {
        const harness = makeBreadcrumbCoordinator(3);
        harness.coordinator.listener(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "bash",
                args: { command: "printf output" },
            }),
            context,
        );
        harness.coordinator.listener(
            event({
                type: "tool_execution_update",
                toolCallId: "tool-1",
                toolName: "bash",
                partialResult: {
                    content: [{ type: "text", text: "output\n" }],
                },
            }),
            context,
        );
        harness.coordinator.listener(
            event({
                type: "tool_execution_end",
                toolCallId: "tool-1",
                toolName: "bash",
                isError: false,
                result: { content: [{ type: "text", text: "output\n" }] },
            }),
            context,
        );

        expect(harness.output.match(/› Waiting/g)).toHaveLength(1);

        const insufficient = makeBreadcrumbCoordinator(3);
        insufficient.coordinator.listener(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-empty",
                toolName: "bash",
                args: {},
            }),
            context,
        );
        insufficient.coordinator.listener(
            event({
                type: "tool_execution_end",
                toolCallId: "tool-empty",
                toolName: "bash",
                isError: false,
                result: { content: [] },
            }),
            context,
        );
        expect(insufficient.output).not.toContain("› Waiting");
    });

    test("emits one breadcrumb for a long tool result and does not reuse its backlog", () => {
        const harness = makeBreadcrumbCoordinator(4);
        harness.coordinator.listener(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-long",
                toolName: "read",
                args: { path: "src/index.ts" },
            }),
            context,
        );
        harness.coordinator.listener(
            event({
                type: "tool_execution_end",
                toolCallId: "tool-long",
                toolName: "read",
                isError: false,
                result: {
                    content: [
                        {
                            type: "text",
                            text: Array.from(
                                { length: 20 },
                                (_, index) => `line ${index + 1}`,
                            ).join("\n"),
                        },
                    ],
                },
            }),
            context,
        );
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );

        expect(harness.output.match(/› Waiting/g)).toHaveLength(1);
        expect(harness.output).not.toContain("› Compacting context");
    });

    test("emits a compaction-start candidate only when new rows are sufficient", () => {
        const eligible = makeBreadcrumbCoordinator();
        primeRows(eligible.coordinator);
        eligible.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        expect(eligible.output).toContain("› Compacting context");

        const ineligible = makeBreadcrumbCoordinator();
        primeRows(ineligible.coordinator, "one");
        ineligible.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        expect(ineligible.output).not.toContain("› Compacting context");
    });

    test("emits a compaction-end candidate only when new rows are sufficient", () => {
        const eligible = makeBreadcrumbCoordinator();
        primeRows(eligible.coordinator);
        eligible.coordinator.listener(
            event({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
            context,
        );
        expect(eligible.output).toContain("› Waiting");

        const ineligible = makeBreadcrumbCoordinator();
        primeRows(ineligible.coordinator, "one");
        ineligible.coordinator.listener(
            event({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
            context,
        );
        expect(ineligible.output).not.toContain("› Waiting");
    });

    test("emits auto-retry start and end candidates independently", () => {
        const start = makeBreadcrumbCoordinator();
        primeRows(start.coordinator);
        start.coordinator.listener(
            event({
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 10,
                errorMessage: "temporary",
            }),
            context,
        );
        expect(start.output).toContain("› Retrying");

        const end = makeBreadcrumbCoordinator();
        primeRows(end.coordinator);
        end.coordinator.listener(
            event({
                type: "auto_retry_end",
                success: true,
                attempt: 1,
            }),
            context,
        );
        expect(end.output).toContain("› Waiting");

        const insufficient = makeBreadcrumbCoordinator();
        primeRows(insufficient.coordinator, "one");
        insufficient.coordinator.listener(
            event({
                type: "auto_retry_end",
                success: true,
                attempt: 1,
            }),
            context,
        );
        expect(insufficient.output).not.toContain("› Waiting");
    });

    test("covers every summarization retry boundary and source variant", () => {
        const events: ReadonlyArray<{
            readonly event: PiSessionEvent;
            readonly label: string;
        }> = [
            {
                event: event({
                    type: "summarization_retry_scheduled",
                    attempt: 1,
                    maxAttempts: 2,
                    delayMs: 10,
                    errorMessage: "temporary",
                }),
                label: "› Retrying",
            },
            {
                event: event({
                    type: "summarization_retry_attempt_start",
                    source: "branchSummary",
                }),
                label: "› Retrying",
            },
            {
                event: event({
                    type: "summarization_retry_attempt_start",
                    source: "compaction",
                    reason: "overflow",
                }),
                label: "› Retrying",
            },
            {
                event: event({ type: "summarization_retry_finished" }),
                label: "› Waiting",
            },
        ];

        for (const retryEvent of events) {
            const eligible = makeBreadcrumbCoordinator();
            primeRows(eligible.coordinator);
            eligible.coordinator.listener(retryEvent.event, context);
            expect(eligible.output.match(retryEvent.label)).toHaveLength(1);

            const ineligible = makeBreadcrumbCoordinator();
            primeRows(ineligible.coordinator, "one");
            ineligible.coordinator.listener(retryEvent.event, context);
            expect(ineligible.output).not.toContain(retryEvent.label);
        }
    });
});