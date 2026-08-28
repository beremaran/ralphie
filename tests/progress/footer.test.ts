import { describe, expect, test } from "bun:test";

import {
    clipFooter,
    makeFooterRefreshScheduler,
    renderFooter,
    type FooterTimer,
} from "../../src/progress/footer.ts";
import type { DisplayState } from "../../src/progress/display-state.ts";

const state: DisplayState = {
    repository: "owner/repo",
    issue: { current: 2, total: 5, number: 42, title: "Footer work" },
    stage: "implementation",
    reviewAttempt: { current: 1, total: 3 },
    activity: "tool",
    activityLabel: "Using bash",
    stageStartedAt: 1_000,
};

describe("interactive footer", () => {
    test("renders the stored leaf context with an injectable clock and indicator", () => {
        expect(
            renderFooter(state, {
                now: () => 92_000,
                width: () => 200,
                indicator: "◐",
            }),
        ).toBe(
            "◐ [owner/repo] [2/5] #42 Footer work Review 1/3 › Implementing changes › Using bash · 1m 31s",
        );
    });

    test("sanitizes fields, omits unavailable metadata, and clips styled text", () => {
        const line = renderFooter(
            {
                activity: "tool",
                activityLabel: "Using\x1b[2J bash\nnow",
                issue: {
                    current: 1,
                    total: 2,
                    number: 7,
                    title: "wide 界 title",
                },
            },
            { width: () => 24, color: (text) => `\x1b[31m${text}\x1b[0m` },
        );
        expect(line).not.toContain("\x1b[2J");
        expect(line).not.toContain("\n");
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24);
        expect(line.endsWith("\x1b[0m")).toBe(true);
        expect(clipFooter("abc", 2)).toBe("a…");
    });

    test("renders nothing when no finite positive width is available", () => {
        expect(renderFooter(state, { width: () => 0 })).toBe("");
        expect(clipFooter("abc", -1)).toBe("");
        expect(clipFooter("abc", Number.NaN)).toBe("");
        expect(clipFooter("abc", Number.POSITIVE_INFINITY)).toBe("");
    });

    test("closes an OSC 8 hyperlink when clipping inside its label", () => {
        const linked =
            "\x1b]8;;https://example.com\x1b\\linked label\x1b]8;;\x1b\\";

        expect(clipFooter(linked, 7)).toBe(
            "\x1b]8;;https://example.com\x1b\\linked…\x1b]8;;\x1b\\",
        );
    });
});

describe("footer refresh scheduler", () => {
    test("coalesces thousands of invalidations with an undefined timer handle", () => {
        let callback: (() => void) | undefined;
        let scheduleCount = 0;
        let scheduledDelay = 0;
        const timer: FooterTimer = {
            schedule: (next, delay) => {
                callback = next;
                scheduleCount += 1;
                scheduledDelay = delay;
                return undefined;
            },
            cancel: () => {
                callback = undefined;
            },
        };
        let repaints = 0;
        const scheduler = makeFooterRefreshScheduler({
            repaint: () => {
                repaints += 1;
            },
            timer,
        });
        for (let index = 0; index < 5_000; index += 1) scheduler.invalidate();

        expect(scheduleCount).toBe(1);
        expect(scheduledDelay).toBe(100);
        expect(repaints).toBe(0);
        callback?.();
        expect(repaints).toBe(1);
    });
});