import { describe, expect, test } from "bun:test";

import { makeFooterRefreshScheduler } from "../../src/adapters/progress/footer.ts";

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
    test("double dispose is harmless and later invalidate/flush never repaint", async () => {
        const { repaint, count } = makeRepaintSpy();
        const scheduler = makeFooterRefreshScheduler({ repaint });

        scheduler.invalidate();
        scheduler.flush();
        expect(count()).toBe(1);

        // A second dispose throws nothing.
        scheduler.dispose();
        expect(() => scheduler.dispose()).not.toThrow();

        // invalidate() and flush() are no-ops once disposed.
        scheduler.invalidate();
        scheduler.flush();
        await Bun.sleep(150);
        expect(count()).toBe(1);
    });

    test("dispose cancels the pending handle so a fired timer cannot repaint", async () => {
        const { repaint, count } = makeRepaintSpy();
        const scheduler = makeFooterRefreshScheduler({ repaint });

        scheduler.invalidate();
        scheduler.dispose();

        await Bun.sleep(150);
        expect(count()).toBe(0);
    });

    test("flush after dispose never invokes repaint", async () => {
        const { repaint, count } = makeRepaintSpy();
        const scheduler = makeFooterRefreshScheduler({ repaint });

        scheduler.dispose();
        scheduler.invalidate();
        scheduler.flush();
        await Bun.sleep(150);
        expect(count()).toBe(0);
    });
});