import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import {
    ACTIVE_MARKER,
    DONE_MARKER,
    EVENT_LOG_NAME,
    FOOTER_MARKER,
    INPUT_LINE,
    INPUT_MARKER_PREFIX,
    LONG_FAILURE_MESSAGE,
    RESIZE_MARKER_PREFIX,
    SIGINT_MARKER,
} from "./pty-driver-child.ts";
import { isProcessAlive, launchPtyCommand } from "./pty-driver.ts";

const CHILD_MODULE = new URL("./pty-driver-child.ts", import.meta.url).pathname;

/**
 * Smoke test for the real-PTY command driver: a child runs `runCommand`
 * (real interactive coordinator, fake agent/runtime/workflow) inside a real
 * PTY, reaches the active state, accepts a resize, receives typed input and
 * SIGINT, exits cleanly, and leaves no child process behind. Everything
 * synchronizes on explicit markers written by the child, never on sleeps.
 */

const cleanedWidth = (text: string): number =>
    Bun.stringWidth(stripTerminalControls(text));

/** Environment for the child: a clean TTY context, never CI. */
const childEnv = (): Record<string, string> => {
    const env: Record<string, string> = { TERM: "xterm-256color" };
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (
            key === "CI" ||
            key === "GITHUB_ACTIONS" ||
            key.startsWith("GITHUB_")
        ) {
            continue;
        }
        env[key] = value;
    }
    return env;
};

describe("PTY command driver", () => {
    test("child reaches the active state, resizes, exits, and leaves no child process behind", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-pty-"));
        const session = await launchPtyCommand({
            command: [process.execPath, CHILD_MODULE, "--workspace", workspace],
            columns: 100,
            rows: 30,
            env: childEnv(),
        });
        try {
            // The child is a PTY session leader with its own process group.
            expect(session.childPgid()).toBe(session.childPid());

            // Active state: the real coordinator painted its interactive
            // footer with the live implementation stage.
            await session.waitFor(FOOTER_MARKER);
            const footerRows = session.screen().map(stripTerminalControls);
            expect(footerRows.join("\n")).toContain("Implementing changes");

            // The agent stream is open and the child waits for the driver.
            await session.waitFor(ACTIVE_MARKER);

            // Resize through the real PTY: the kernel forwards SIGWINCH,
            // the child re-observes its terminal size, and the coordinator
            // repaints at the new width.
            session.resize(60, 20);
            await session.waitFor(`${RESIZE_MARKER_PREFIX}60x20`);

            // Typed input arrives on the child's stdin (cooked mode also
            // echoes it back through the PTY).
            session.write(`${INPUT_LINE}\n`);
            const rawWithInput = await session.waitFor(
                `${INPUT_MARKER_PREFIX}${INPUT_LINE}`,
            );
            expect(rawWithInput).toContain(INPUT_LINE);

            // SIGINT is delivered to the child's process group.
            session.sendSignal("SIGINT");
            await session.waitFor(SIGINT_MARKER);

            // The child closes the stream, settles progress, and exits 0.
            await session.waitFor(DONE_MARKER);
            const exit = await session.waitForExit();
            expect(exit).toEqual({ code: 0, signal: null });

            // Raw output capture: real interactive ANSI bytes flowed
            // through the PTY, including the streamed transcript text.
            const raw = session.raw();
            expect(raw).toContain("\x1b[");
            const cleanRaw = stripTerminalControls(raw);
            expect(cleanRaw).toContain(FOOTER_MARKER);
            expect(cleanRaw).toContain(
                "The PTY driver streams a partial agent transcript line " +
                    "across the resize, the typed input, and SIGINT.",
            );

            // Final-screen inspection after the exit: the long durable
            // failure line was emitted post-resize at 60 columns, so it
            // wraps and no visible row exceeds the new width.
            const screen = session.screen();
            for (const row of screen) {
                expect(cleanedWidth(row)).toBeLessThanOrEqual(60);
            }
            const cleanedScreen = screen.map(stripTerminalControls);
            expect(cleanedScreen.join("")).toContain(LONG_FAILURE_MESSAGE);
            expect(
                cleanedScreen.some((row) => row.includes(LONG_FAILURE_MESSAGE)),
            ).toBe(false);
            expect(session.scrollback().length).toBeGreaterThan(0);

            // The fake workflow wrote its event log into the disposable
            // workspace: nested progress updates, agent events, resize,
            // input, SIGINT, and the final done entry.
            const logText = await readFile(
                join(workspace, EVENT_LOG_NAME),
                "utf8",
            );
            const entries = logText
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "progress",
                        stage: "grounding",
                        status: "started",
                    }),
                    expect.objectContaining({
                        kind: "progress",
                        stage: "implementation",
                        status: "started",
                        repository: "owner/repository",
                        issue: { number: 423, title: "PTY scenario issue" },
                        current: 1,
                        total: 1,
                        attempt: 1,
                        maxAttempts: 3,
                    }),
                    expect.objectContaining({
                        kind: "progress",
                        stage: "implementation",
                        status: "succeeded",
                    }),
                    expect.objectContaining({
                        kind: "progress",
                        stage: "verification",
                        status: "failed",
                    }),
                    expect.objectContaining({ kind: "agent" }),
                    expect.objectContaining({
                        kind: "resize",
                        columns: 60,
                        rows: 20,
                    }),
                    expect.objectContaining({
                        kind: "input",
                        line: INPUT_LINE,
                    }),
                    expect.objectContaining({ kind: "signal", name: "SIGINT" }),
                    expect.objectContaining({ kind: "active" }),
                    expect.objectContaining({ kind: "done" }),
                ]),
            );

            // The child exited by itself; its PID and process group are
            // gone, leaving nothing behind.
            expect(isProcessAlive(session.childPid() as number)).toBe(false);
            expect(isProcessAlive(-(session.childPgid() as number))).toBe(
                false,
            );
        } finally {
            await session.close();
        }
        // Idempotent teardown also reaps the relay helper.
        expect(isProcessAlive(session.helperPid)).toBe(false);
    }, 120_000);
});