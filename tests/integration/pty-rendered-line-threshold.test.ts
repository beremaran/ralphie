import { describe, expect, test } from "bun:test";

import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { FAKE_TOKEN } from "./pty-driver-child.ts";
import {
    cleanSurfaceRows,
    closePtyScenario,
    launchPtyScenario,
    rawWithoutAllowedRegionEscapes,
    readScenarioEvents,
    waitForScenarioActive,
    waitForScenarioDone,
    waitForScenarioFinalized,
    waitForScenarioResize,
} from "./pty-assertions.ts";

const PROBE_THRESHOLDS = [
    { base: 4, values: [3, 4, 5] },
    { base: 8, values: [7, 8, 9] },
    { base: 16, values: [15, 16, 17] },
] as const;

type ThresholdObservation = {
    readonly threshold: number;
    readonly wideBreadcrumbs: number;
    readonly narrowBreadcrumbs: number;
    readonly rewideBreadcrumbs: number;
    readonly wideRows: number;
    readonly narrowRows: number;
};

const surfaceSnapshot = (
    session: Parameters<typeof cleanSurfaceRows>[0],
): { readonly breadcrumbs: number; readonly rows: number } => {
    const rows = cleanSurfaceRows(session).filter((row) => row.trim() !== "");
    return {
        // Contextual breadcrumb rows begin with the durable `│  [` prefix;
        // footer rows use `◐ [` and are deliberately excluded.
        breadcrumbs: rows.filter((row) => row.startsWith("│  [")).length,
        rows: rows.length,
    };
};

const assertSafeSurface = (
    session: Parameters<typeof cleanSurfaceRows>[0],
): void => {
    const rows = cleanSurfaceRows(session);
    expect(rows.join("\n")).not.toContain(FAKE_TOKEN);
    for (const row of rows) {
        expect(row).toBe(stripTerminalControls(row));
        expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    const withoutStyling = session.raw().replace(/\x1b\[[0-?]*[ -/]*m/g, "");
    expect(rawWithoutAllowedRegionEscapes(withoutStyling)).not.toContain(
        "\x1b",
    );
};

const runThresholdProbe = async (
    threshold: number,
): Promise<ThresholdObservation> => {
    const scenario = await launchPtyScenario({ threshold });
    try {
        await waitForScenarioActive(scenario.workspace);
        const wide = surfaceSnapshot(scenario.session);

        scenario.session.resize(40, 20);
        await waitForScenarioResize(scenario.workspace, 40, 20);
        const narrow = surfaceSnapshot(scenario.session);

        scenario.session.resize(100, 30);
        await waitForScenarioResize(scenario.workspace, 100, 30);
        const rewide = surfaceSnapshot(scenario.session);

        // Reflow changes physical rows but does not replay the assistant
        // stream or create a second set of breadcrumbs.
        expect(rewide.breadcrumbs).toBe(wide.breadcrumbs);
        expect(narrow.rows).toBeGreaterThan(wide.rows);
        expect(rewide.rows).toBeGreaterThan(0);
        assertSafeSurface(scenario.session);

        scenario.session.sendSignal("SIGUSR1");
        await waitForScenarioFinalized(scenario.workspace);
        scenario.session.sendSignal("SIGUSR1");
        await waitForScenarioDone(scenario.workspace);
        expect(await scenario.session.waitForExit()).toEqual({
            code: 0,
            signal: null,
        });

        const entries = await readScenarioEvents(scenario.workspace);
        expect(
            entries.some(
                (entry) =>
                    entry.kind === "config" &&
                    (entry.options as { threshold?: unknown }).threshold ===
                        threshold,
            ),
        ).toBe(true);

        return {
            threshold,
            wideBreadcrumbs: wide.breadcrumbs,
            narrowBreadcrumbs: narrow.breadcrumbs,
            rewideBreadcrumbs: rewide.breadcrumbs,
            wideRows: wide.rows,
            narrowRows: narrow.rows,
        };
    } finally {
        await closePtyScenario(scenario);
    }
};

describe("interactive PTY rendered-line threshold semantics", () => {
    test("uses visual rows for below/at/above cadence probes at both widths and after reflow", async () => {
        const observations: ThresholdObservation[] = [];
        for (const group of PROBE_THRESHOLDS) {
            for (const threshold of group.values) {
                observations.push(await runThresholdProbe(threshold));
            }
        }

        const observationFor = (threshold: number): ThresholdObservation => {
            const observation = observations.find(
                (value) => value.threshold === threshold,
            );
            if (observation === undefined) {
                throw new Error(
                    `Missing threshold observation ${String(threshold)}`,
                );
            }
            return observation;
        };

        for (const group of PROBE_THRESHOLDS) {
            const below = observationFor(group.values[0]);
            const at = observationFor(group.values[1]);
            const above = observationFor(group.values[2]);

            // A smaller cadence emits at least as many contextual rows as the
            // exact boundary, which emits at least as many as the larger
            // cadence. Equal counts are valid when adjacent crossings are
            // de-duplicated by the display-state key.
            for (const width of [
                "wideBreadcrumbs",
                "narrowBreadcrumbs",
                "rewideBreadcrumbs",
            ] as const) {
                expect(below[width]).toBeGreaterThanOrEqual(at[width]);
                expect(at[width]).toBeGreaterThanOrEqual(above[width]);
                expect(at[width]).toBeGreaterThan(0);
            }

            // The same boundary decision survives narrow→wide reflow without
            // replaying the stream; only physical row count changes.
            expect(at.rewideBreadcrumbs).toBe(at.wideBreadcrumbs);
            expect(at.narrowRows).toBeGreaterThan(at.wideRows);
        }
    }, 120_000);
});