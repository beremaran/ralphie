import { describe, expect, test } from "bun:test";

import type { PiSessionEvent } from "../../src/pi/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): PiSessionEvent => value as PiSessionEvent;

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

        expect(output).toBe(
            "◐ Implementing...\r\x1b[2K╭─ Pi · Task · session-1\n│\n" +
                "│  ✦ assistant partial token\n" +
                "• Still working.\n◐ Implementing..." +
                "\r\x1b[2K│    continued",
        );
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

        expect(output).toMatch(/Progress\.\n$/);
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
});