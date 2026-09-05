import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import {
    ACTIVE_MARKER,
    DONE_MARKER,
    EVENT_LOG_NAME,
    FAKE_TOKEN,
    FOOTER_MARKER,
    LONG_FAILURE_MESSAGE,
    RESIZE_MARKER_PREFIX,
    SCENARIO_DONE_MARKER,
    STREAM_FINALIZED_MARKER,
} from "./pty-driver-child.ts";
import { isProcessAlive, launchPtyCommand } from "./pty-driver.ts";

const CHILD_MODULE = new URL("./pty-driver-child.ts", import.meta.url).pathname;

/**
 * Smoke test for the real-PTY command driver: a child runs `runCommand`
 * (real interactive coordinator, fake agent/runtime/workflow) inside a real
 * PTY, reaches the active state with the deterministic scenario stream open,
 * accepts two resizes (100x30 -> 60x20 -> 100x30), finalizes the stream
 * exactly once after the second resize, exits cleanly, and leaves no child
 * process behind. Everything synchronizes on explicit markers written by the
 * child, never on sleeps.
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
    test("scenario session stays open across two resizes, finalizes once, and exits cleanly", async () => {
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

            // The scenario stream is open and the child waits for the driver.
            await session.waitFor(ACTIVE_MARKER);

            // Resize twice through the real PTY (100x30 -> 60x20 -> 100x30):
            // the kernel forwards SIGWINCH, the child re-observes its
            // terminal size, and the coordinator repaints at each width.
            session.resize(60, 20);
            await session.waitFor(`${RESIZE_MARKER_PREFIX}60x20`);
            session.resize(100, 30);
            await session.waitFor(`${RESIZE_MARKER_PREFIX}100x30`);

            // The stream finalizes exactly once, arrives only after the
            // second resize, and is detectable in the raw capture.
            const rawAtFinalize = await session.waitFor(
                STREAM_FINALIZED_MARKER,
            );
            expect(
                rawAtFinalize.indexOf(STREAM_FINALIZED_MARKER),
            ).toBeGreaterThan(
                rawAtFinalize.indexOf(`${RESIZE_MARKER_PREFIX}100x30`),
            );
            expect(
                rawAtFinalize.split(STREAM_FINALIZED_MARKER).length - 1,
            ).toBe(1);

            // The child settles progress and exits 0.
            await session.waitFor(DONE_MARKER);
            await session.waitFor(SCENARIO_DONE_MARKER);
            const exit = await session.waitForExit();
            expect(exit).toEqual({ code: 0, signal: null });

            // Raw output capture: real interactive ANSI bytes flowed through
            // the PTY, including the streamed scenario transcript with its
            // wide graphemes; the stream-finalized marker appears exactly
            // once across the whole run.
            const raw = session.raw();
            expect(raw).toContain("\x1b[");
            expect(raw.split(STREAM_FINALIZED_MARKER).length - 1).toBe(1);
            expect(raw.split(SCENARIO_DONE_MARKER).length - 1).toBe(1);
            const cleanRaw = stripTerminalControls(raw);
            expect(cleanRaw).toContain(FOOTER_MARKER);
            expect(cleanRaw).toContain("PTY scenario");
            expect(cleanRaw).toContain("agent run");
            expect(cleanRaw).toContain("（漢字）");
            // The ZWJ grapheme pair was split across two consecutive deltas:
            // each half is styled separately, but the terminal re-joins the
            // grapheme, so the cleaned capture keeps the pair contiguous.
            expect(stripTerminalControls(raw)).toContain("👩\u200d💻");

            // The visible surface stays credential-free: neither the raw
            // capture nor the final screen ever shows the fake token.
            expect(raw).not.toContain(FAKE_TOKEN);

            // Final-screen inspection after the exit: the long durable
            // failure line was emitted at the final 100-column width, so it
            // wraps and no visible row exceeds that width.
            const screen = session.screen();
            for (const row of screen) {
                expect(cleanedWidth(row)).toBeLessThanOrEqual(100);
            }
            const cleanedScreen = screen.map(stripTerminalControls);
            expect(cleanedScreen.join("")).toContain(LONG_FAILURE_MESSAGE);
            expect(
                cleanedScreen.some((row) => row.includes(LONG_FAILURE_MESSAGE)),
            ).toBe(false);
            expect(session.scrollback().length).toBeGreaterThan(0);
            expect(cleanedScreen.join("")).not.toContain(FAKE_TOKEN);

            // The fake workflow wrote its event log into the disposable
            // workspace: progress updates, every scenario agent milestone,
            // both resizes, and the finalize/done markers.
            const logText = await readFile(
                join(workspace, EVENT_LOG_NAME),
                "utf8",
            );
            expect(logText).not.toContain(FAKE_TOKEN);
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
                    expect.objectContaining({
                        kind: "agent",
                        type: "agent_start",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "text_delta",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "compaction_start",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "auto_retry_start",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "summarization_retry_scheduled",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "tool_execution_start",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "tool_execution_update",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "tool_execution_end",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "agent_end",
                    }),
                    expect.objectContaining({
                        kind: "resize",
                        columns: 60,
                        rows: 20,
                    }),
                    expect.objectContaining({
                        kind: "resize",
                        columns: 100,
                        rows: 30,
                    }),
                    expect.objectContaining({ kind: "active" }),
                    expect.objectContaining({
                        kind: "marker",
                        name: STREAM_FINALIZED_MARKER,
                    }),
                    expect.objectContaining({ kind: "done" }),
                ]),
            );
            // The typed-input and SIGINT gate steps are gone from the smoke
            // contract: no input or signal entries may appear in the log.
            expect(
                entries.some(
                    (entry) =>
                        entry.kind === "input" || entry.kind === "signal",
                ),
            ).toBe(false);

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