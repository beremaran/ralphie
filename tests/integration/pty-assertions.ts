import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ACTIVE_MARKER,
    DONE_MARKER,
    EVENT_LOG_NAME,
    FOOTER_MARKER,
    RESIZE_MARKER_PREFIX,
    SCENARIO_DONE_MARKER,
    STREAM_FINALIZED_MARKER,
    type PtyScenarioOptions,
} from "./pty-driver-child.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { launchPtyCommand, type PtySession } from "./pty-driver.ts";

const CHILD_MODULE = new URL("./pty-driver-child.ts", import.meta.url).pathname;

export const DEFAULT_PTY_SCENARIO_OPTIONS: PtyScenarioOptions = {
    columns: 100,
    rows: 30,
    issueCurrent: 2,
    issueTotal: 5,
    issueNumber: 423,
    repository: "owner/repository",
    attempt: 2,
    maxAttempts: 4,
    threshold: 30,
};

/** Clean TTY context for child processes, with no CI/GitHub leakage. */
const childEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = {
        TERM: "xterm-256color",
        // PTY markers are synchronized through the durable event log. Writing
        // marker text to the live PTY would move the terminal cursor and make
        // the fixture itself look like a stale footer or transcript row.
        RALPHIE_PTY_MARKERS: "event-log",
    };
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (
            key === "CI" ||
            key === "GITHUB_ACTIONS" ||
            key.startsWith("GITHUB_") ||
            key === "RALPHIE_PTY_MARKERS"
        ) {
            continue;
        }
        env[key] = value;
    }
    return env;
};

const argumentFor = (value: number): string => String(value);

export type PtyScenarioHandle = {
    readonly workspace: string;
    readonly options: PtyScenarioOptions;
    readonly session: PtySession;
};

/** Launch the shared active-stream child with out-of-band marker logging. */
export const launchPtyScenario = async (
    overrides: Partial<PtyScenarioOptions> = {},
): Promise<PtyScenarioHandle> => {
    const options = {
        ...DEFAULT_PTY_SCENARIO_OPTIONS,
        ...overrides,
    } satisfies PtyScenarioOptions;
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-pty-layout-"));
    try {
        const session = await launchPtyCommand({
            command: [
                process.execPath,
                CHILD_MODULE,
                "--workspace",
                workspace,
                "--columns",
                argumentFor(options.columns),
                "--rows",
                argumentFor(options.rows),
                "--issue-current",
                argumentFor(options.issueCurrent),
                "--issue-total",
                argumentFor(options.issueTotal),
                "--issue-number",
                argumentFor(options.issueNumber),
                "--repository",
                options.repository,
                "--attempt",
                argumentFor(options.attempt),
                "--max-attempts",
                argumentFor(options.maxAttempts),
                "--threshold",
                argumentFor(options.threshold),
            ],
            columns: options.columns,
            rows: options.rows,
            env: childEnv(),
        });
        return { workspace, options, session };
    } catch (error) {
        await rm(workspace, { recursive: true, force: true });
        throw error;
    }
};

export const closePtyScenario = async (
    scenario: PtyScenarioHandle,
): Promise<void> => {
    await scenario.session.close();
    await rm(scenario.workspace, { recursive: true, force: true });
};

export type ScenarioEvent = Readonly<Record<string, unknown>>;

export const readScenarioEvents = async (
    workspace: string,
): Promise<readonly ScenarioEvent[]> => {
    let text = "";
    try {
        text = await readFile(join(workspace, EVENT_LOG_NAME), "utf8");
    } catch {
        return [];
    }
    return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as ScenarioEvent);
};

/** Wait for a durable fixture event; the predicate is the synchronization primitive. */
export const waitForScenarioEvent = async (
    workspace: string,
    predicate: (events: readonly ScenarioEvent[]) => boolean,
    description: string,
    timeoutMs = 30_000,
): Promise<readonly ScenarioEvent[]> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await readScenarioEvents(workspace);
        if (predicate(events)) return events;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for PTY scenario event: ${description}`);
};

export const waitForScenarioMarker = (
    workspace: string,
    marker: string,
): Promise<readonly ScenarioEvent[]> =>
    waitForScenarioEvent(
        workspace,
        (events) =>
            events.some(
                (event) => event.kind === "marker" && event.name === marker,
            ),
        marker,
    );

export const waitForScenarioResize = (
    workspace: string,
    columns: number,
    rows: number,
): Promise<readonly ScenarioEvent[]> =>
    waitForScenarioEvent(
        workspace,
        (events) =>
            events.some(
                (event) =>
                    event.kind === "resize" &&
                    event.columns === columns &&
                    event.rows === rows,
            ),
        `${RESIZE_MARKER_PREFIX}${columns}x${rows}`,
    );

export const waitForScenarioFooter = (workspace: string) =>
    waitForScenarioMarker(workspace, FOOTER_MARKER);

export const waitForScenarioActive = (workspace: string) =>
    waitForScenarioEvent(
        workspace,
        (events) => events.some((event) => event.kind === "active"),
        ACTIVE_MARKER,
    );

export const waitForScenarioFinalized = (workspace: string) =>
    waitForScenarioMarker(workspace, STREAM_FINALIZED_MARKER);

export const waitForScenarioDone = (workspace: string) =>
    waitForScenarioEvent(
        workspace,
        (events) =>
            events.some(
                (event) =>
                    event.kind === "marker" &&
                    event.name === SCENARIO_DONE_MARKER,
            ) &&
            events.some(
                (event) =>
                    event.kind === "marker" && event.name === DONE_MARKER,
            ),
        SCENARIO_DONE_MARKER,
    );

/** Remove only fixture synchronization text; terminal controls are separate. */
export const stripFixtureMarkers = (text: string): string =>
    text
        .replace(/PTY_RESIZED:\d+x\d+/g, "")
        .replace(
            /PTY_(?:FOOTER|ACTIVE|DONE|STREAM_FINALIZED|SCENARIO_DONE|DRIVER_ACTIONS_TIMEOUT)/g,
            "",
        );

export const cleanScreenRows = (session: PtySession): readonly string[] =>
    session
        .screen()
        .map((row) => stripTerminalControls(stripFixtureMarkers(row)));

export const cleanSurfaceRows = (session: PtySession): readonly string[] =>
    [...session.scrollback(), ...session.screen()].map((row) =>
        stripTerminalControls(stripFixtureMarkers(row)),
    );

export const countOccurrences = (text: string, fragment: string): number => {
    if (fragment === "") return 0;
    let count = 0;
    let offset = 0;
    while (true) {
        const found = text.indexOf(fragment, offset);
        if (found < 0) return count;
        count += 1;
        offset = found + fragment.length;
    }
};

export const scenarioFooterRows = (session: PtySession): readonly string[] =>
    cleanScreenRows(session).filter((row) => row.startsWith("◐ ["));

export type LiveFooterFrame = {
    readonly screen: readonly string[];
    readonly footer: string;
    readonly footerIndex: number;
    readonly region: readonly string[];
};

/** Locate the current bounded live region without duplicating PTY row logic. */
export const inspectLiveFooterFrame = (
    session: PtySession,
): LiveFooterFrame => {
    const screen = cleanScreenRows(session);
    const footerRows = scenarioFooterRows(session);
    if (footerRows.length !== 1) {
        throw new Error(
            `Expected exactly one live footer, received ${String(footerRows.length)}.`,
        );
    }
    const footer = footerRows[0] as string;
    const footerIndex = screen.lastIndexOf(footer);
    if (footerIndex < 0) {
        throw new Error(
            "The live footer is not present on the current screen.",
        );
    }
    let regionStart = footerIndex;
    while (
        regionStart > 0 &&
        (screen[regionStart - 1] as string).startsWith("◐ ")
    ) {
        regionStart -= 1;
    }
    return {
        screen,
        footer,
        footerIndex,
        region: screen.slice(regionStart, footerIndex + 1),
    };
};

export const lastNonBlankScreenRow = (
    session: PtySession,
): string | undefined =>
    [...cleanScreenRows(session)].filter((row) => row.trim() !== "").at(-1);

export const rawWithoutAllowedRegionEscapes = (raw: string): string =>
    raw.replaceAll("\r\x1b[2K", "").replaceAll("\x1b[1A", "");

export const scenarioMarkers = {
    active: ACTIVE_MARKER,
    done: DONE_MARKER,
    footer: FOOTER_MARKER,
    finalized: STREAM_FINALIZED_MARKER,
    scenarioDone: SCENARIO_DONE_MARKER,
} as const;