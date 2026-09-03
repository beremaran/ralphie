import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { RalphieExitCode } from "../../src/process/exit-code.ts";
import {
    ACTIVE_MARKER,
    DISPOSED_MARKER,
    EVENT_LOG_NAME,
    FOOTER_MARKER,
    LIFECYCLE_MESSAGES,
    LIFECYCLE_STREAM_DELTAS,
    POST_DISPOSE_MARKER,
    QUIESCENT_MARKER,
    type LifecycleScenario,
} from "./pty-driver-child.ts";
import {
    isProcessAlive,
    launchPtyCommand,
    type PtyExitInfo,
    type PtySession,
} from "./pty-driver.ts";

const CHILD_MODULE = new URL("./pty-driver-child.ts", import.meta.url).pathname;

const INITIAL_COLUMNS = 100;
const INITIAL_ROWS = 30;
/**
 * Post-settle observation window: comfortably longer than the footer refresh
 * scheduler's 100-125 ms window, so any leaked timer would repaint within it.
 */
const POST_SETTLE_WAIT_MS = 700;

/**
 * Real-PTY lifecycle cleanup suite (issue #427): a command running inside a
 * real PTY ends through normal completion, a SIGINT/Ctrl-C abort, or an early
 * workflow failure. After `runCommand` has fully returned and disposed, the
 * interactive footer/status region must release every resource and leave no
 * screen or scrollback residue. Everything synchronizes on explicit raw-PTY
 * milestones and the child's post-dispose markers, never on sleeps — except
 * the deliberate observation windows that prove bytes stay absent.
 */

/** Clean TTY context for the child: a TTY, never CI. */
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

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

const launchLifecycle = async (
    workspace: string,
    scenario: LifecycleScenario,
): Promise<PtySession> =>
    launchPtyCommand({
        command: [
            process.execPath,
            CHILD_MODULE,
            "--workspace",
            workspace,
            "--scenario",
            scenario,
        ],
        columns: INITIAL_COLUMNS,
        rows: INITIAL_ROWS,
        env: childEnv(),
    });

const streamText = (scenario: LifecycleScenario): string =>
    LIFECYCLE_STREAM_DELTAS[scenario].join("");

/**
 * Every cleanup assertion for a settled lifecycle run. Runs before any
 * post-settle driver resize, so screen/scrollback still model the run's own
 * terminal surface.
 */
const expectCleanSettlement = (
    session: PtySession,
    scenario: LifecycleScenario,
): void => {
    const raw = session.raw();
    const text = streamText(scenario);
    const cleanRaw = stripTerminalControls(raw);

    // The streamed transcript text is intact and appears exactly once.
    expect(cleanRaw.split(text)).toHaveLength(2);
    expect(cleanRaw.indexOf(text)).toBeGreaterThan(-1);

    // The final durable marker ends the byte stream: the tail is exactly the
    // POST_DISPOSE line, with no cursor-motion or region bytes after it.
    const postDisposeIndex = raw.lastIndexOf(POST_DISPOSE_MARKER);
    expect(postDisposeIndex).toBeGreaterThan(-1);
    expect(raw.slice(postDisposeIndex)).toBe(`${POST_DISPOSE_MARKER}\r\n`);
    expect(raw.endsWith(`${POST_DISPOSE_MARKER}\r\n`)).toBe(true);

    // Between the post-dispose markers there is nothing but the marker lines:
    // pending footer timers, re-fired fake events, and the double dispose all
    // wrote zero bytes to the PTY.
    const disposedEnd = raw.indexOf(DISPOSED_MARKER) + DISPOSED_MARKER.length;
    const quiescentStart = raw.indexOf(QUIESCENT_MARKER);
    expect(disposedEnd).toBeGreaterThan(DISPOSED_MARKER.length);
    expect(quiescentStart).toBeGreaterThan(disposedEnd);
    expect(raw.slice(disposedEnd, quiescentStart)).toBe("\r\n");
    const quiescentEnd = quiescentStart + QUIESCENT_MARKER.length;
    expect(quiescentEnd).toBeLessThan(postDisposeIndex);
    expect(raw.slice(quiescentEnd, postDisposeIndex)).toBe("\r\n");

    // No stale or ephemeral footer: scrollback and the final screen contain
    // no live-region content (the ◐ indicator, › stage/status fragments, the
    // live-only progress messages, or activity rows).
    const screenRows = [...session.screen()];
    const historyRows = [...session.scrollback()];
    const liveOnlyFragments = [
        "◐",
        "›",
        LIFECYCLE_MESSAGES.groundingStarted,
        LIFECYCLE_MESSAGES.implementationStarted,
        "bash echo lifecycle probe",
        "lifecycle tick",
    ] as const;
    for (const row of [...historyRows, ...screenRows]) {
        for (const fragment of liveOnlyFragments) {
            expect(
                row,
                `settled ${scenario} row contains live-only fragment ${JSON.stringify(fragment)}`,
            ).not.toContain(fragment);
        }
    }

    // No scrollback rows at all: nothing ever scrolled on the 30-row surface,
    // so no cleared-then-stale region fragment can hide there. The streamed
    // transcript occupies at most one terminal row (never duplicated).
    expect(historyRows).toEqual([]);
    const textRows = [...historyRows, ...screenRows].filter((row) =>
        row.includes(text),
    );
    expect(textRows.length).toBeLessThanOrEqual(1);

    // Visible screen is clean: every row is a durable line or blank and
    // respects the PTY width; the bottom-most non-blank row is the final
    // POST_DISPOSE line, proving cursor and scroll state were restored.
    for (const row of screenRows) {
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(INITIAL_COLUMNS);
    }
    const nonBlankRows = screenRows.filter((row) => row.trim() !== "");
    expect(nonBlankRows.at(-1)).toBe(POST_DISPOSE_MARKER);
};

/** Assert the scenario's milestones landed in the workspace event log. */
const expectScenarioEventLog = (
    entries: readonly Record<string, unknown>[],
    scenario: LifecycleScenario,
): void => {
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
            }),
            expect.objectContaining({ kind: "marker", name: FOOTER_MARKER }),
            expect.objectContaining({ kind: "marker", name: ACTIVE_MARKER }),
            expect.objectContaining({
                kind: "marker",
                name: DISPOSED_MARKER,
            }),
            expect.objectContaining({
                kind: "marker",
                name: QUIESCENT_MARKER,
            }),
            expect.objectContaining({
                kind: "marker",
                name: POST_DISPOSE_MARKER,
            }),
        ]),
    );
    if (scenario === "completion") {
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "settled" }),
                expect.objectContaining({
                    kind: "progress",
                    stage: "verification",
                    status: "succeeded",
                }),
            ]),
        );
    }
    if (scenario === "interrupt") {
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "signal", name: "SIGINT" }),
                expect.objectContaining({ kind: "run_failed" }),
            ]),
        );
    }
    if (scenario === "failure") {
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "run_failed",
                    message: "simulated mid-stream workflow failure",
                }),
            ]),
        );
    }
};

/** Drive one lifecycle scenario through its real-PTY lifecycle and assert. */
const runLifecycleScenario = async (
    scenario: LifecycleScenario,
    options: { readonly deliver?: "signal" | "etx" } = {},
): Promise<void> => {
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-lifecycle-"));
    const session = await launchLifecycle(workspace, scenario);
    try {
        const expectedExit: PtyExitInfo =
            scenario === "completion"
                ? { code: RalphieExitCode.Success, signal: null }
                : scenario === "interrupt"
                  ? { code: RalphieExitCode.Cancelled, signal: null }
                  : { code: RalphieExitCode.Failure, signal: null };

        // Positive control: the live footer painted (the region exists before
        // the run settles), synchronized on the live-only progress message.
        // The grounding message only ever reaches the PTY as a painted region
        // row, and every region paint also carries the ◐ status row, so the
        // cumulative raw stream proves the region was painted. Checking the
        // live screen instead would race: the region is cleared as soon as the
        // transcript stream opens, so the paint bytes and the clear bytes can
        // surface inside one chunk and the instantaneous screen may already be
        // empty even though the footer was painted.
        const rawWithGrounding = await session.waitFor(
            LIFECYCLE_MESSAGES.groundingStarted,
        );
        expect(rawWithGrounding).toContain("◐");

        // The agent transcript stream is open: sync on its first delta, which
        // only exists in the streamed transcript bytes.
        const deltas = LIFECYCLE_STREAM_DELTAS[scenario];
        const firstDelta = deltas[0] as string;
        await session.waitFor(firstDelta);
        expect(
            session.screen().some((row) => row.includes(firstDelta)),
            "streamed delta missing from the live screen",
        ).toBe(true);

        // Interrupt the run while the transcript stream is open: SIGINT via
        // the process group, or the raw Ctrl-C byte (the PTY's ETX-to-SIGINT
        // path); both reach the child's SIGINT -> AbortController handler.
        if (scenario === "interrupt") {
            if (options.deliver === "etx") {
                // The tty echoes the Ctrl-C byte as "^C" at the cursor, so it
                // must land only after the full stream: the stream stays open
                // (unsettled) until the abort, so the interruption still
                // happens mid-transcript.
                await session.waitFor(deltas.at(-1) as string);
                session.write("\x03");
            } else {
                session.sendSignal("SIGINT");
            }
        }

        // The child writes POST_DISPOSE only after runCommand has fully
        // returned and disposed (including the quiescence probes).
        await session.waitFor(POST_DISPOSE_MARKER);

        expectCleanSettlement(session, scenario);

        const cleanRaw = stripTerminalControls(session.raw());
        if (scenario === "completion") {
            // Completing runs keep their settled durable tail.
            expect(cleanRaw).toContain(
                LIFECYCLE_MESSAGES.verificationSucceeded,
            );
            expect(cleanRaw).toContain("╰─ done");
        } else {
            // Interrupted/failed runs never settle the agent session.
            expect(cleanRaw).not.toContain("╰─");
            expect(cleanRaw).not.toContain(
                LIFECYCLE_MESSAGES.verificationSucceeded,
            );
        }

        // Resize subscriptions are removed: a post-settle resize writes zero
        // new bytes and does not crash the (still-alive) child, whose stderr
        // resize listener was unregistered at disposal.
        const rawLengthBeforeResize = session.raw().length;
        session.resize(60, 24);
        await sleep(POST_SETTLE_WAIT_MS);
        expect(session.raw().length).toBe(rawLengthBeforeResize);
        expect(isProcessAlive(session.childPgid() as number)).toBe(true);

        // Release the child; it exits with the exit code runCommand chose.
        session.sendSignal("SIGUSR1");
        const exit = await session.waitForExit();
        expect(exit).toEqual(expectedExit);

        // Nothing survives: child PID and process group are gone.
        expect(isProcessAlive(session.childPid() as number)).toBe(false);
        expect(isProcessAlive(-(session.childPgid() as number))).toBe(false);

        // The event log carries the scenario's milestones (mid-run milestones
        // are logged, never written to the PTY).
        const logText = await readFile(join(workspace, EVENT_LOG_NAME), "utf8");
        const entries = logText
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expectScenarioEventLog(entries, scenario);
    } finally {
        await session.close();
    }
    await rm(workspace, { recursive: true, force: true });
};

describe("interactive footer cleanup in real-PTY lifecycles", () => {
    test("completion: every stage settles and the footer disposes without residue", async () => {
        await runLifecycleScenario("completion");
    }, 60_000);

    test("interrupt: SIGINT aborts the run and the footer disposes without residue", async () => {
        await runLifecycleScenario("interrupt", { deliver: "signal" });
    }, 60_000);

    test("interrupt: the raw Ctrl-C byte aborts through the same path", async () => {
        await runLifecycleScenario("interrupt", { deliver: "etx" });
    }, 60_000);

    test("failure: a mid-stream workflow error disposes the footer without residue", async () => {
        await runLifecycleScenario("failure");
    }, 60_000);
});