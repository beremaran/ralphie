import { describe, expect, test } from "bun:test";

import { buildScenarioStreamDeltas, FAKE_TOKEN } from "./pty-driver-child.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import {
    cleanSurfaceRows,
    closePtyScenario,
    countOccurrences,
    inspectLiveFooterFrame,
    launchPtyScenario,
    rawWithoutAllowedRegionEscapes,
    readScenarioEvents,
    waitForScenarioActive,
    waitForScenarioDone,
    waitForScenarioFinalized,
    waitForScenarioFooter,
    waitForScenarioResize,
} from "./pty-assertions.ts";

const STREAM_FRAGMENTS = [
    "agent run",
    "ASCII run",
    "graphemes",
    "（漢字） 🎉",
    "👩\u200d💻 SGRred",
    "OSC x",
    "BEL BS",
    "mid-line",
    "│    finalize",
] as const;

const assertWidthAndStream = (
    session: Parameters<typeof cleanSurfaceRows>[0],
    width: number,
    label: string,
): void => {
    const rows = cleanSurfaceRows(session);
    for (const row of rows) {
        expect(
            Bun.stringWidth(row),
            `${label}: row exceeds ${String(width)} columns: ${JSON.stringify(row)}`,
        ).toBeLessThanOrEqual(width);
    }

    const surface = rows.join("");
    for (const fragment of STREAM_FRAGMENTS) {
        expect(
            countOccurrences(surface, fragment),
            `${label}: stream fragment ${JSON.stringify(fragment)} count`,
        ).toBe(1);
    }
};

const assertLiveFooter = (
    session: Parameters<typeof cleanSurfaceRows>[0],
    width: number,
    label: string,
): void => {
    const frame = inspectLiveFooterFrame(session);
    expect(frame.region.length, `${label}: region height`).toBeLessThanOrEqual(
        3,
    );
    expect(frame.region.at(-1)).toBe(frame.footer);
    expect(
        frame.screen.filter((row) => row.trim() !== "").at(-1),
        `${label}: footer is last non-blank row`,
    ).toBe(frame.footer);
    for (const row of frame.region) {
        expect(
            Bun.stringWidth(row),
            `${label}: live row exceeds ${String(width)} columns`,
        ).toBeLessThanOrEqual(width);
    }
};

const assertReflowSafety = (
    session: Parameters<typeof cleanSurfaceRows>[0],
): void => {
    const rows = cleanSurfaceRows(session);
    expect(rows.join("\n")).not.toContain(FAKE_TOKEN);
    for (const row of rows) {
        expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    const withoutStyling = session.raw().replace(/\x1b\[[0-?]*[ -/]*m/g, "");
    expect(rawWithoutAllowedRegionEscapes(withoutStyling)).not.toContain(
        "\x1b",
    );
    expect(session.raw()).not.toContain(FAKE_TOKEN);
};

describe("interactive PTY resize and reflow", () => {
    test("keeps a mid-line stream complete exactly once across narrow and wide reflow", async () => {
        const scenario = await launchPtyScenario({ threshold: 16 });
        try {
            await waitForScenarioFooter(scenario.workspace);
            await waitForScenarioActive(scenario.workspace);
            assertLiveFooter(scenario.session, 100, "wide active");
            assertWidthAndStream(scenario.session, 100, "wide active");

            scenario.session.resize(40, 20);
            await waitForScenarioResize(scenario.workspace, 40, 20);
            assertLiveFooter(scenario.session, 40, "narrow reflow");
            assertWidthAndStream(scenario.session, 40, "narrow reflow");

            scenario.session.resize(100, 30);
            await waitForScenarioResize(scenario.workspace, 100, 30);
            assertLiveFooter(scenario.session, 100, "wide reflow");
            assertWidthAndStream(scenario.session, 100, "wide reflow");

            // The second resize is held after its durable marker, so the
            // complete pre-finalization frame is observable before release.
            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioFinalized(scenario.workspace);
            assertWidthAndStream(scenario.session, 100, "finalized stream");
            assertReflowSafety(scenario.session);

            const cleanRaw = stripTerminalControls(scenario.session.raw());
            expect(cleanRaw).not.toContain(FAKE_TOKEN);

            const entries = await readScenarioEvents(scenario.workspace);
            expect(
                entries.filter(
                    (entry) =>
                        entry.kind === "agent" && entry.type === "text_delta",
                ),
            ).toHaveLength(buildScenarioStreamDeltas(scenario.options).length);
            expect(
                entries.filter(
                    (entry) =>
                        entry.kind === "marker" &&
                        entry.name === "PTY_STREAM_FINALIZED",
                ),
            ).toHaveLength(1);
            expect(
                entries.filter(
                    (entry) =>
                        entry.kind === "agent" && entry.type === "agent_end",
                ),
            ).toHaveLength(1);

            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioDone(scenario.workspace);
            expect(await scenario.session.waitForExit()).toEqual({
                code: 0,
                signal: null,
            });
        } finally {
            await closePtyScenario(scenario);
        }
    }, 120_000);
});