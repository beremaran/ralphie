import { describe, expect, test } from "bun:test";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { INTERACTIVE_REGION_MAX_ROWS } from "../../src/progress/terminal-controller.ts";
import { FAKE_TOKEN, LONG_FAILURE_MESSAGE } from "./pty-driver-child.ts";
import {
    cleanScreenRows,
    cleanSurfaceRows,
    closePtyScenario,
    inspectLiveFooterFrame,
    launchPtyScenario,
    readScenarioEvents,
    rawWithoutAllowedRegionEscapes,
    waitForScenarioActive,
    waitForScenarioDone,
    waitForScenarioFinalized,
    waitForScenarioFooter,
    waitForScenarioResize,
} from "./pty-assertions.ts";

const assertLiveFrame = (
    session: Parameters<typeof cleanScreenRows>[0],
    width: number,
    label: string,
): void => {
    const frame = inspectLiveFooterFrame(session);
    const { screen, footer, footerIndex, region } = frame;
    expect(
        screen.filter((row) => row.trim() !== "").at(-1),
        `${label}: footer is last`,
    ).toBe(footer);
    expect(
        region.length,
        `${label}: bounded replaceable region`,
    ).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    expect(region.at(-1)).toBe(footer);

    for (const row of cleanSurfaceRows(session)) {
        expect(
            Bun.stringWidth(row),
            `${label}: row exceeds ${String(width)} columns: ${JSON.stringify(row)}`,
        ).toBeLessThanOrEqual(width);
    }
    expect(
        cleanSurfaceRows(session).filter((row) => row === footer),
        `${label}: no stale footer copy in the buffered surface`,
    ).toHaveLength(1);

    // The footer is the complete current-state row at the wide geometry. At
    // the narrow geometry clipFooter intentionally shortens it, while the
    // durable scenario log still proves the state fields were supplied.
    if (width >= 100) {
        expect(footer).toContain("[owner/repository]");
        expect(footer).toContain("[2/5]");
        expect(footer).toContain("Review 2/4");
        expect(
            footer.includes("› Implementing changes") ||
                footer.includes("› Running verification"),
        ).toBe(true);
        expect(footer).toContain("› ");
    }
};

const assertSurfaceSafety = (
    session: Parameters<typeof cleanScreenRows>[0],
): void => {
    const surface = cleanSurfaceRows(session);
    expect(surface.join("\n")).not.toContain(FAKE_TOKEN);
    for (const row of surface) {
        expect(row).toBe(stripTerminalControls(row));
        expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }

    const withoutStyling = session.raw().replace(/\x1b\[[0-?]*[ -/]*m/g, "");
    expect(rawWithoutAllowedRegionEscapes(withoutStyling)).not.toContain(
        "\x1b",
    );
    expect(session.raw()).not.toContain(FAKE_TOKEN);
};

describe("interactive PTY sticky-footer layout", () => {
    test("keeps one state-accurate footer below bounded activity across every live resize", async () => {
        const scenario = await launchPtyScenario();
        try {
            await waitForScenarioFooter(scenario.workspace);
            assertLiveFrame(scenario.session, 100, "first paint");

            await waitForScenarioActive(scenario.workspace);
            assertLiveFrame(scenario.session, 100, "active stream");

            scenario.session.resize(60, 20);
            await waitForScenarioResize(scenario.workspace, 60, 20);
            assertLiveFrame(scenario.session, 60, "narrow resize");

            scenario.session.resize(100, 30);
            await waitForScenarioResize(scenario.workspace, 100, 30);
            assertLiveFrame(scenario.session, 100, "wide resize");

            // The event-log marker mode pauses here, so the post-second-resize
            // live frame is observable before close events and settlement run.
            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioFinalized(scenario.workspace);
            assertLiveFrame(scenario.session, 100, "stream finalized");

            scenario.session.sendSignal("SIGUSR1");
            await waitForScenarioDone(scenario.workspace);
            expect(await scenario.session.waitForExit()).toEqual({
                code: 0,
                signal: null,
            });

            assertSurfaceSafety(scenario.session);
            const entries = await readScenarioEvents(scenario.workspace);
            expect(entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "config",
                        options: expect.objectContaining({
                            repository: "owner/repository",
                            issueCurrent: 2,
                            issueTotal: 5,
                            attempt: 2,
                            maxAttempts: 4,
                        }),
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
                        name: "PTY_STREAM_FINALIZED",
                    }),
                ]),
            );

            // The durable failure line is still present after all live-region
            // replacements, but no live footer/activity row was persisted as
            // a duplicate in the final surface.
            expect(cleanSurfaceRows(scenario.session).join("\n")).toContain(
                LONG_FAILURE_MESSAGE.slice(0, 40),
            );
        } finally {
            await closePtyScenario(scenario);
        }
    }, 120_000);
});