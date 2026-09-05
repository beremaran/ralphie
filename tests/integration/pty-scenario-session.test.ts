import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import type { TerminalOutputStrategy } from "../../src/progress/terminal-controller.ts";
import {
    ACTIVE_MARKER,
    buildScenarioStreamDeltas,
    FAKE_TOKEN,
    STREAM_FINALIZED_MARKER,
    scenarioLifecycleEvents,
    scenarioProgressUpdates,
    scenarioThinkingEvents,
    SCENARIO_CLOSE_EVENT_COUNT,
    type PtyScenarioOptions,
} from "./pty-driver-child.ts";

const OPTIONS: PtyScenarioOptions = {
    columns: 100,
    rows: 30,
    issueCurrent: 1,
    issueTotal: 1,
    issueNumber: 423,
    repository: "owner/repository",
    attempt: 1,
    maxAttempts: 3,
    threshold: 30,
};

const CONTEXT: AgentEventContext = {
    sessionID: "pty-driver-session",
    directory: "/workspace/repository",
    title: "Task",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const WIDE_FIRST = "👩\u200d";
const WIDE_SECOND = "💻";
const WIDE_PAIR = `${WIDE_FIRST}${WIDE_SECOND}`;

/** The full delta stream concatenated, exactly as the child streams it. */
const streamText = (): string => buildScenarioStreamDeltas(OPTIONS).join("");

/** The full ordered agent event script the coordinator renders. */
const scriptEvents = (): readonly AgentSessionEvent[] => [
    asEvent({ type: "agent_start" }),
    ...scenarioThinkingEvents(),
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    }),
    ...buildScenarioStreamDeltas(OPTIONS).map((delta) =>
        asEvent({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta,
            },
        }),
    ),
    ...scenarioLifecycleEvents(),
];

const runScenarioIn = (
    mode: "plain" | "json",
    threshold: number,
    width: number,
): (() => string) => {
    let output = "";
    const coordinator = makeProgressCoordinator({
        mode,
        verbose: false,
        colors: false,
        width: () => width,
        renderedLineThreshold: threshold,
        write: (text) => {
            output += text;
        },
    });
    for (const update of scenarioProgressUpdates(OPTIONS).slice(0, 3)) {
        void coordinator.progress.emit(update);
    }
    for (const event of scriptEvents()) {
        coordinator.piListener(event, CONTEXT);
    }
    return () => output;
};

/** Serialized payloads that must never carry the token (continuations, etc.). */
const forbiddenPayloadJson = (): string => {
    const forbidden: unknown[] = [];
    for (const event of scenarioLifecycleEvents()) {
        if (event.type === "tool_execution_update") continue;
        if (event.type === "message_update") continue;
        forbidden.push(event);
    }
    forbidden.push(
        ...scenarioProgressUpdates(OPTIONS).map((update) => update.message),
    );
    return JSON.stringify(forbidden);
};

describe("PTY scenario agent session", () => {
    describe("buildScenarioStreamDeltas", () => {
        test("contains the required control bytes inside the deltas", () => {
            const text = streamText();
            expect(text).toContain("\u001b[31m"); // SGR red run
            expect(text).toContain("\u001b]8;;https://example.invalid"); // OSC hyperlink
            expect(text).toContain("\u0007"); // BEL (OSC terminator and literal)
            expect(text).toContain("\u0008"); // backspace
        });

        test("contains a wide grapheme and splits a ZWJ grapheme across a delta boundary", () => {
            const deltas = buildScenarioStreamDeltas(OPTIONS);
            const text = streamText();

            // A wide-grapheme run exists (CJK/emoji, width >= 2 per char).
            const wideCharacters = Array.from(text).filter(
                (character) => Bun.stringWidth(character) >= 2,
            );
            expect(wideCharacters.length).toBeGreaterThan(2);

            // The ZWJ pair is split across two consecutive deltas: the first
            // delta ends with the leading surrogate pair plus the ZWJ joiner,
            // the second begins with the trailing half of the grapheme.
            const splitIndex = deltas.findIndex((delta) =>
                delta.includes(WIDE_FIRST),
            );
            expect(splitIndex).toBeGreaterThanOrEqual(0);
            expect(deltas[splitIndex]?.endsWith(WIDE_FIRST)).toBe(true);
            expect(deltas[splitIndex + 1]?.startsWith(WIDE_SECOND)).toBe(true);

            // The concatenated stream still carries the full grapheme as one
            // segment straddling the delta boundary, so the renderer and the
            // terminal re-join what the deltas split.
            const pairAt = text.indexOf(WIDE_PAIR);
            const boundary = deltas.slice(0, splitIndex + 1).join("").length;
            expect(pairAt).toBeGreaterThanOrEqual(0);
            expect(pairAt).toBeLessThan(boundary);
            expect(pairAt + WIDE_PAIR.length).toBeGreaterThan(boundary);
            const segments = [
                ...new Intl.Segmenter(undefined, {
                    granularity: "grapheme",
                }).segment(text),
            ];
            expect(
                segments.some((segment) => segment.segment === WIDE_PAIR),
            ).toBe(true);
        });

        test("ends mid-line with no trailing newline and fits the render budget", () => {
            const deltas = buildScenarioStreamDeltas(OPTIONS);
            const text = streamText();
            expect(deltas.at(-1)?.endsWith("\n")).toBe(false);
            expect(text.endsWith("\n")).toBe(false);
            // The whole message fits the coordinator's 140-unit per-stream
            // render budget, so the full text (including the mid-line tail)
            // is what the PTY displays.
            expect(Array.from(text).length).toBeLessThanOrEqual(140);
            // The stream mixes mid-line-ending deltas with newline-bearing
            // deltas (the newlines fund the visible volume).
            expect(deltas.some((delta) => !delta.endsWith("\n"))).toBe(true);
            expect(deltas.some((delta) => delta.includes("\n"))).toBe(true);
        });

        test("cumulative volume crosses any configured threshold at default geometry, scaling with it", () => {
            const counts = new Map<number, number>();
            for (const threshold of [1, 2, 3, 5, 10, 20, 30]) {
                const output = runScenarioIn(
                    "plain",
                    threshold,
                    OPTIONS.columns,
                )();
                counts.set(
                    threshold,
                    output.split("\n").filter((line) => line.startsWith("│  ["))
                        .length,
                );
            }

            const countAt = (threshold: number): number =>
                counts.get(threshold) ?? 0;

            // Every configured threshold in the practical range — including
            // the default 30 — is crossed at least once at 100x30 geometry;
            // arbitrarily small thresholds cross many times.
            for (const threshold of [1, 2, 3, 5, 10, 20, 30]) {
                expect(countAt(threshold)).toBeGreaterThanOrEqual(1);
            }
            expect(countAt(1)).toBeGreaterThanOrEqual(3);

            // Crossing count scales with the threshold: non-increasing as the
            // threshold grows, with strict drops across the cadence range.
            const thresholds = [1, 2, 3, 5, 10, 20, 30];
            for (let index = 1; index < thresholds.length; index += 1) {
                expect(countAt(thresholds[index] ?? 0)).toBeLessThanOrEqual(
                    countAt(thresholds[index - 1] ?? 0),
                );
            }
            expect(countAt(1)).toBeGreaterThan(countAt(5));
            expect(countAt(5)).toBeGreaterThan(countAt(20));
            expect(countAt(1)).toBeGreaterThan(countAt(30));
        });
    });

    describe("FAKE_TOKEN placement", () => {
        test("the literal is distinctive and absent from assistant text", () => {
            expect(FAKE_TOKEN).toMatch(/^rk_s3cret_pty_[0-9a-f]{4}_token$/);
            expect(streamText()).not.toContain(FAKE_TOKEN);
        });

        test("lives only inside partialResult.content and one thinking delta", () => {
            const script = [
                ...scenarioThinkingEvents(),
                ...scenarioLifecycleEvents(),
            ];
            const carriers = script.filter((event) =>
                JSON.stringify(event).includes(FAKE_TOKEN),
            );

            // Exactly two carriers: one tool_execution_update (via its
            // partialResult.content) and one thinking_delta (via its content).
            expect(carriers).toHaveLength(2);
            expect(
                carriers.filter(
                    (event) => event.type === "tool_execution_update",
                ),
            ).toHaveLength(1);
            expect(
                carriers.filter(
                    (event) =>
                        event.type === "message_update" &&
                        event.assistantMessageEvent?.type === "thinking_delta",
                ),
            ).toHaveLength(1);
            const update = carriers.find(
                (event) => event.type === "tool_execution_update",
            ) as { partialResult?: { content?: string } } | undefined;
            expect(update?.partialResult?.content).toContain(FAKE_TOKEN);
            const thinking = carriers.find(
                (event) =>
                    event.type === "message_update" &&
                    event.assistantMessageEvent?.type === "thinking_delta",
            ) as { assistantMessageEvent?: { delta?: string } } | undefined;
            expect(thinking?.assistantMessageEvent?.delta).toContain(
                FAKE_TOKEN,
            );

            expect(forbiddenPayloadJson()).not.toContain(FAKE_TOKEN);
        });

        test("the visible surface stays credential-free while the JSON event stream keeps the literal", () => {
            // Plain mode: the human transcript and breadcrumb rows never
            // render the token.
            const plainOutput = runScenarioIn(
                "plain",
                OPTIONS.threshold,
                OPTIONS.columns,
            )();
            expect(plainOutput).not.toContain(FAKE_TOKEN);

            // Interactive mode: the painted footer (activity rows) is also
            // credential-free.
            let paints = "";
            const strategy: TerminalOutputStrategy = {
                write: (text) => {
                    paints += text;
                },
                paintFooter: (text) => {
                    paints += text;
                },
                clearFooter: () => {},
                restore: () => {},
            };
            const timer = makeFakeTimer();
            const coordinator = makeProgressCoordinator({
                mode: "interactive",
                verbose: false,
                colors: false,
                width: () => OPTIONS.columns,
                renderedLineThreshold: OPTIONS.threshold,
                strategy,
                footer: { timer: timer.timer },
                write: (text) => {
                    paints += text;
                },
            });
            for (const update of scenarioProgressUpdates(OPTIONS).slice(0, 3)) {
                void coordinator.progress.emit(update);
            }
            for (const event of scriptEvents()) {
                coordinator.piListener(event, CONTEXT);
            }
            while (timer.run()) {
                // Drain every scheduled footer repaint.
            }
            expect(paints).not.toContain(FAKE_TOKEN);

            // JSON mode is lossless: the raw event stream contains the token.
            const jsonOutput = runScenarioIn(
                "json",
                OPTIONS.threshold,
                OPTIONS.columns,
            )();
            expect(jsonOutput).toContain(FAKE_TOKEN);
        });
    });

    describe("scenarioLifecycleEvents", () => {
        test("ordering is canonical", () => {
            const types = scenarioLifecycleEvents().map((event) =>
                event.type === "message_update"
                    ? `message_update:${event.assistantMessageEvent?.type}`
                    : event.type,
            );
            expect(types).toEqual([
                "compaction_start",
                "compaction_end",
                "auto_retry_start",
                "auto_retry_end",
                "summarization_retry_scheduled",
                "summarization_retry_attempt_start",
                "summarization_retry_finished",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_update",
                "tool_execution_update",
                "tool_execution_end",
                "tool_execution_end",
                "agent_end",
            ]);
        });

        test("failing tool end then ordinary close end, with the close tail reserved", () => {
            const events = scenarioLifecycleEvents();
            const toolEnds = events.filter(
                (event) => event.type === "tool_execution_end",
            );
            const failing = toolEnds.at(0) as { isError?: boolean } | undefined;
            const closing = toolEnds.at(-1) as
                | { isError?: boolean }
                | undefined;
            expect(failing?.isError).toBe(true);
            expect(closing?.isError).toBe(false);
            expect(events.at(-1)).toMatchObject({
                type: "agent_end",
                willRetry: false,
            });
            expect(events.at(-2)).toMatchObject({
                type: "tool_execution_end",
            });
            expect(SCENARIO_CLOSE_EVENT_COUNT).toBe(2);
        });

        test("thinking block order and the smoke markers stay stable", () => {
            const kinds = scenarioThinkingEvents().map(
                (event) => event.assistantMessageEvent?.type,
            );
            expect(kinds).toEqual([
                "thinking_start",
                "thinking_delta",
                "thinking_end",
            ]);
            expect(ACTIVE_MARKER).toBe("PTY_ACTIVE");
            expect(STREAM_FINALIZED_MARKER).toBe("PTY_STREAM_FINALIZED");
        });
    });
});

const makeFakeTimer = (): {
    readonly timer: FooterTimer;
    readonly run: () => boolean;
} => {
    let scheduled: (() => void) | undefined;
    return {
        timer: {
            schedule: (callback) => {
                scheduled = callback;
                return scheduled;
            },
            cancel: () => {
                scheduled = undefined;
            },
        },
        run: () => {
            const callback = scheduled;
            scheduled = undefined;
            if (callback === undefined) return false;
            callback();
            return true;
        },
    };
};