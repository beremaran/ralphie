import { describe, expect, test } from "bun:test";

import { RunStateStoreLive } from "../../src/run/adapters/state.ts";
import { RUN_STATE_VERSION, runStateSchema } from "../../src/run/state.ts";

describe("run state version", () => {
    test("rejects state written by another version without migrating it", () => {
        const parsed = runStateSchema.safeParse({
            version: RUN_STATE_VERSION - 1,
        });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("version");
    });

    test("the store refuses to persist a state with a stale version", async () => {
        const stale = { version: RUN_STATE_VERSION - 1 } as never;
        await expect(
            RunStateStoreLive.save("/nonexistent/state.json", stale),
        ).rejects.toThrow("Failed to persist run state");
    });
});