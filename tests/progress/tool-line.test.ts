import { describe, expect, test } from "bun:test";

import {
    contentText,
    toolTarget,
} from "../../src/progress/adapters/tool-line.ts";

describe("tool lines", () => {
    test("extracts text from strings, parts, and nested content", () => {
        expect(contentText("plain")).toBe("plain");
        expect(contentText({ text: "text field" })).toBe("text field");
        expect(contentText({ content: "nested string" })).toBe("nested string");
        expect(
            contentText({
                content: [{ text: "part one" }, { text: "part two" }],
            }),
        ).toBe("part one\npart two");
        expect(contentText({ content: [{ type: "image" }] })).toBeUndefined();
        expect(contentText(undefined)).toBeUndefined();
    });

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