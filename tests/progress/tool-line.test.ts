import { describe, expect, test } from "bun:test";

import { toolTarget } from "../../src/progress/adapters/tool-line.ts";

describe("tool lines", () => {
    test("renders tool invocations as one line", () => {
        expect(toolTarget("bash", { command: "bun test\n--watch" })).toBe(
            "$ bun test --watch",
        );
        expect(
            toolTarget("read", { path: "src/a.ts", offset: 10, limit: 5 }),
        ).toBe("read src/a.ts:10-14");
        expect(toolTarget("grep", { pattern: "x" })).toBe(
            'grep {"pattern":"x"}',
        );
    });
});