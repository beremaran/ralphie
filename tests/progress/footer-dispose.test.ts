import { describe, expect, test } from "bun:test";

import {
    makeFooterRefreshScheduler,
    type FooterTimer,
} from "../../src/progress/footer.ts";

type RecordingTimer = FooterTimer & {
    readonly run: () => void;
    readonly lastScheduled: () => unknown;
    readonly cancelled: () => readonly unknown[];
};

/** Fake timer that records the handle passed to every `cancel` call. */
const makeRecordingTimer = (): RecordingTimer => {
    const callbacks = new Map<unknown, () => void>();
    const cancelled: unknown[] = [];
    let lastHandle: unknown;
    let sequence = 0;
    return {
        schedule: (callback) => {
            sequence += 1;
            lastHandle = sequence;
            callbacks.set(lastHandle, callback);
            return lastHandle;
        },
        cancel: (handle) => {
            cancelled.push(handle);
            callbacks.delete(handle);
        },
        run: () => {
            const entry = callbacks.entries().next().value as
                | readonly [unknown, () => void]
                | undefined;
            if (entry === undefined) return;
            callbacks.delete(entry[0]);
            entry[1]();
        },
        lastScheduled: () => lastHandle,
        cancelled: () => cancelled,
    };
};

const makeRepaintSpy = () => {
    let calls = 0;
    return {
        repaint: () => {
            calls += 1;
        },
        count: () => calls,
    };
};

describe("footer refresh scheduler dispose safety", () => {
    test("double dispose is harmless and later invalidate/flush never repaint", () => {
        const { repaint, count } = makeRepaintSpy();
        const timer = makeRecordingTimer();
        const scheduler = makeFooterRefreshScheduler({ repaint, timer });

        scheduler.invalidate();
        scheduler.flush();
        expect(count()).toBe(1);
        expect(timer.cancelled()).toHaveLength(1);

        // A second dispose throws nothing and cancels nothing extra.
        scheduler.dispose();
        expect(() => scheduler.dispose()).not.toThrow();
        expect(timer.cancelled()).toHaveLength(1);

        // invalidate() and flush() are no-ops once disposed.
        scheduler.invalidate();
        scheduler.flush();
        timer.run();
        expect(count()).toBe(1);
    });

    test("dispose cancels the pending handle so a fired timer cannot repaint", () => {
        const { repaint, count } = makeRepaintSpy();
        const timer = makeRecordingTimer();
        const scheduler = makeFooterRefreshScheduler({ repaint, timer });

        scheduler.invalidate();
        expect(timer.lastScheduled()).toBeDefined();

        scheduler.dispose();
        expect(timer.cancelled()).toEqual([timer.lastScheduled()]);

        timer.run();
        expect(count()).toBe(0);
    });

    test("flush after dispose never invokes repaint", () => {
        const { repaint, count } = makeRepaintSpy();
        const timer = makeRecordingTimer();
        const scheduler = makeFooterRefreshScheduler({ repaint, timer });

        scheduler.dispose();
        scheduler.invalidate();
        scheduler.flush();
        timer.run();
        expect(count()).toBe(0);
        expect(timer.cancelled()).toEqual([]);
    });
});