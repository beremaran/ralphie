import { describe, expect, test } from "bun:test";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { INTERACTIVE_REGION_MAX_ROWS } from "../../src/progress/terminal-controller.ts";
import {
    buildScenarioStreamDeltas,
    DISPOSED_MARKER,
    LONG_FAILURE_MESSAGE,
    POST_DISPOSE_MARKER,
    QUIESCENT_MARKER,
} from "./pty-driver-child.ts";
import {
    cleanScreenRows,
    cleanSurfaceRows,
    closePtyScenario,
    inspectLiveFooterFrame,
    launchPtyScenario,
    readScenarioEvents,
    waitForScenarioActive,
    waitForScenarioDone,
    waitForScenarioFinalized,
    waitForScenarioFooter,
    waitForScenarioMarker,
    waitForScenarioResize,
} from "./pty-assertions.ts";
import { launchPtyCommand } from "./pty-driver.ts";

const assertLiveFrame = (
    session: Parameters<typeof cleanScreenRows>[0],
    width: number,
): void => {
    const frame = inspectLiveFooterFrame(session);
    const physicalScreenRows = session.screenRows();
    const regionStart = frame.footerIndex - frame.region.length + 1;
    expect(frame.screen.slice(regionStart, frame.footerIndex + 1)).toEqual([
        ...frame.region,
    ]);
    const physicalRegion = physicalScreenRows.slice(
        regionStart,
        frame.footerIndex + 1,
    );
    expect(physicalRegion).toHaveLength(frame.region.length);
    for (const row of physicalRegion) {
        expect(row.softWrap).toBe(false);
    }
    const physicalFooter = session.screenRows()[frame.footerIndex];
    if (physicalFooter === undefined) {
        throw new Error(
            "The live footer is not present on the physical screen.",
        );
    }
    expect(physicalFooter.text).toBe(frame.footer);
    expect(physicalFooter.softWrap).toBe(false);
    expect(
        session
            .screenRows()
            .slice(frame.footerIndex + 1)
            .filter((row) => row.text.trim() !== ""),
    ).toEqual([]);
    expect(frame.region.length).toBeLessThanOrEqual(
        INTERACTIVE_REGION_MAX_ROWS,
    );
    expect(frame.region.at(-1)).toBe(frame.footer);
    expect(frame.screen.filter((row) => row.trim() !== "").at(-1)).toBe(
        frame.footer,
    );
    expect(frame.screen.filter((row) => row === frame.footer)).toHaveLength(1);
    expect(
        cleanSurfaceRows(session).filter((row) => row === frame.footer),
    ).toHaveLength(1);
    if (width < 80) {
        // A width-bounded emulator row alone cannot distinguish clipping from
        // wrapping. The ellipsis and exact width prove the footer was clipped
        // to one physical row before it reached the PTY.
        expect(frame.footer.endsWith("…")).toBe(true);
        expect(Bun.stringWidth(frame.footer)).toBe(width);
        for (const row of physicalScreenRows) {
            if (row.text.startsWith("◐ ")) {
                expect(row.softWrap).toBe(false);
            }
        }
    }
    for (const row of cleanSurfaceRows(session)) {
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    }
};

const assertTranscript = (
    session: Parameters<typeof cleanScreenRows>[0],
    options: Parameters<typeof buildScenarioStreamDeltas>[0],
): void => {
    const rows = cleanSurfaceRows(session);
    const prefix = "│  ✦ assistant ";
    const continuation = "│    ";
    expect(rows.filter((row) => row.startsWith(prefix))).toHaveLength(1);
    const start = rows.findIndex((row) => row.startsWith(prefix));
    const first = rows[start];
    if (first === undefined) throw new Error("assistant transcript is missing");
    const transcriptRows = [first.slice(prefix.length)];
    for (
        let index = start + 1;
        rows[index]?.startsWith(continuation);
        index += 1
    ) {
        transcriptRows.push(rows[index]?.slice(continuation.length) ?? "");
    }
    expect(
        rows
            .slice(start + transcriptRows.length)
            .filter((row) => row.startsWith(continuation)),
    ).toEqual([]);
    expect(transcriptRows.join("\n")).toBe(
        stripTerminalControls(buildScenarioStreamDeltas(options).join("")),
    );
};

const assertControlFreeCapture = (raw: string): string => {
    const normalized = stripTerminalControls(raw);
    expect(normalized).toBe(raw.replace(/\r\n?/g, "\n"));
    expect(raw).not.toContain("\x1b");
    return normalized;
};

const OSC_PAYLOAD_PREFIX = "OSC_SPLIT_PREFIX";
const OSC_PAYLOAD_SUFFIX = "OSC_SPLIT_SUFFIX";

const splitSequenceCommand = [
    process.execPath,
    "-e",
    [
        'process.stdout.write("\\x1b[1JBEFORE\\n")',
        'process.stdout.write("\\x1b[2")',
        "setTimeout(() => {",
        '  process.stdout.write("J")',
        `  process.stdout.write("\\x1b]52;c;${OSC_PAYLOAD_PREFIX}")`,
        "  setTimeout(() => {",
        `    process.stdout.write("${OSC_PAYLOAD_SUFFIX}")`,
        "    setTimeout(() => {",
        '      process.stdout.write("\\x07AFTER\\nSPLIT_DONE\\n")',
        "    }, 150)",
        "  }, 150)",
        "}, 150)",
    ].join(";"),
] as const;

const runOutputMode = async (outputMode: "plain" | "json"): Promise<void> => {
    const scenario = await launchPtyScenario(
        { columns: 80, rows: 24 },
        { outputMode },
    );
    try {
        await waitForScenarioActive(scenario.workspace);
        scenario.session.resize(40, 10);
        await waitForScenarioResize(scenario.workspace, 40, 10);
        scenario.session.resize(80, 24);
        await waitForScenarioResize(scenario.workspace, 80, 24);
        scenario.session.sendSignal("SIGUSR1");
        await waitForScenarioFinalized(scenario.workspace);
        scenario.session.sendSignal("SIGUSR1");
        await waitForScenarioDone(scenario.workspace);
        await scenario.session.waitForExit();

        const capture = assertControlFreeCapture(scenario.session.raw());
        if (outputMode === "plain") {
            expect(capture).toContain("PTY scenario");
            return;
        }
        const records = capture
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map(
                (line) => JSON.parse(line) as Readonly<Record<string, unknown>>,
            );
        expect(records.length).toBeGreaterThan(0);
        expect(records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    stage: "run",
                    status: "info",
                    message: "PTY driver run started",
                }),
                expect.objectContaining({
                    stage: "verification",
                    status: "failed",
                    message: LONG_FAILURE_MESSAGE,
                }),
            ]),
        );
    } finally {
        await closePtyScenario(scenario);
    }
};

describe("real PTY lifecycle and output-mode matrix", () => {
    test("keeps the interactive lifecycle bounded and contiguous through resize and dispose", async () => {
        const scenario = await launchPtyScenario({
            columns: 80,
            rows: 24,
            threshold: 16,
        });
        try {
            await waitForScenarioFooter(scenario.workspace);
            assertLiveFrame(scenario.session, 80);
            await waitForScenarioActive(scenario.workspace);
            assertLiveFrame(scenario.session, 80);

            scenario.session.resize(40, 10);
            await waitForScenarioResize(scenario.workspace, 40, 10);
            const narrowFooter = inspectLiveFooterFrame(
                scenario.session,
            ).footer;
            assertLiveFrame(scenario.session, 40);

            scenario.session.resize(80, 24);
            await waitForScenarioResize(scenario.workspace, 80, 24);
            assertLiveFrame(scenario.session, 80);
            const wideFrame = inspectLiveFooterFrame(scenario.session);
            const repaintedSurface = cleanSurfaceRows(scenario.session);
            expect(wideFrame.footer).not.toBe(narrowFooter);
            expect(repaintedSurface).not.toContain(narrowFooter);
            expect(
                repaintedSurface.filter((row) => row.startsWith("◐ [")),
            ).toEqual([wideFrame.footer]);

            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioFinalized(scenario.workspace);
            assertTranscript(scenario.session, scenario.options);

            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioDone(scenario.workspace);
            expect(await scenario.session.waitForExit()).toEqual({
                code: 0,
                signal: null,
            });

            const rows = cleanSurfaceRows(scenario.session);
            expect(rows.filter((row) => row.startsWith("◐ ["))).toEqual([]);
            const entries = await readScenarioEvents(scenario.workspace);
            expect(entries.filter((entry) => entry.kind === "resize")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ columns: 40, rows: 10 }),
                    expect.objectContaining({ columns: 80, rows: 24 }),
                ]),
            );
        } finally {
            await closePtyScenario(scenario);
        }
    }, 120_000);

    test("keeps disposal and post-dispose resize idempotent without stale footer bytes", async () => {
        const scenario = await launchPtyScenario(
            { columns: 80, rows: 24 },
            { scenario: "completion" },
        );
        try {
            await waitForScenarioMarker(scenario.workspace, "PTY_ACTIVE");
            const rawBeforeDispose = scenario.session.raw();
            expect(rawBeforeDispose).toContain("◐ ");
            await waitForScenarioMarker(scenario.workspace, DISPOSED_MARKER);
            const rawAtDispose = scenario.session.raw();
            const captureThroughDispose = rawAtDispose.slice(
                rawBeforeDispose.length,
            );
            const cleanupStart = captureThroughDispose.lastIndexOf("\r\x1b[2K");
            expect(cleanupStart).toBeGreaterThanOrEqual(0);
            const cleanupCapture = captureThroughDispose.slice(cleanupStart);
            expect(cleanupCapture).not.toContain("◐ ");
            expect(
                stripTerminalControls(cleanupCapture).replaceAll("\n", ""),
            ).toBe("");
            await waitForScenarioMarker(scenario.workspace, QUIESCENT_MARKER);
            // The captured PTY bytes must stay unchanged while disposed
            // timers, sources, and the double-dispose probe run.
            expect(scenario.session.raw()).toBe(rawAtDispose);
            await waitForScenarioMarker(
                scenario.workspace,
                POST_DISPOSE_MARKER,
            );
            expect(scenario.session.raw()).toBe(rawAtDispose);
            scenario.session.resize(40, 10);
            scenario.session.resize(80, 24);
            expect(scenario.session.raw()).toBe(rawAtDispose);
            expect(
                cleanSurfaceRows(scenario.session).some((row) =>
                    row.includes("◐ ["),
                ),
            ).toBe(false);

            scenario.session.sendSignal("SIGUSR1");
            expect(await scenario.session.waitForExit()).toEqual({
                code: 0,
                signal: null,
            });
            expect(scenario.session.raw()).toBe(rawAtDispose);
            await scenario.session.close();
            await scenario.session.close();
        } finally {
            await closePtyScenario(scenario);
        }
    }, 120_000);

    test("keeps plain and JSON captures control-free on the same runtime", async () => {
        for (const outputMode of ["plain", "json"] as const) {
            await runOutputMode(outputMode);
        }
    }, 120_000);

    test("defers split CSI and OSC rendering until each sequence is complete", async () => {
        const session = await launchPtyCommand({
            command: splitSequenceCommand,
            columns: 40,
            rows: 10,
            env: { TERM: "xterm-256color" },
        });
        try {
            await session.waitFor("\x1b[2");
            expect(session.screen().join("\n")).toContain("BEFORE");
            expect(session.screen().join("\n")).not.toContain("2");
            expect(session.screen().join("\n")).not.toContain("J");

            await session.waitFor(`\x1b]52;c;${OSC_PAYLOAD_PREFIX}`);
            expect(session.screen().join("\n")).not.toContain(
                OSC_PAYLOAD_PREFIX,
            );
            expect(session.screen().join("\n")).not.toContain(
                OSC_PAYLOAD_SUFFIX,
            );
            expect(session.screen().join("\n")).not.toContain("AFTER");

            await session.waitFor(OSC_PAYLOAD_SUFFIX);
            expect(session.screen().join("\n")).not.toContain(
                OSC_PAYLOAD_SUFFIX,
            );
            expect(session.screen().join("\n")).not.toContain("AFTER");

            await session.waitFor("SPLIT_DONE");
            expect(session.screen().join("\n")).not.toContain("BEFORE");
            expect(session.screen().join("\n")).not.toContain(
                OSC_PAYLOAD_PREFIX,
            );
            expect(session.screen().join("\n")).not.toContain(
                OSC_PAYLOAD_SUFFIX,
            );
            expect(session.screen().join("\n")).toContain("AFTER");
            expect(session.screen().join("\n")).toContain("SPLIT_DONE");
            expect(await session.waitForExit()).toEqual({
                code: 0,
                signal: null,
            });
        } finally {
            await session.close();
        }
    }, 30_000);
});