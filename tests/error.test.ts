import { describe, expect, test } from "bun:test";

import {
    causesOf,
    errorMessage,
    hasErrorCode,
    RunHaltedError,
} from "../src/shared/error.ts";
import {
    exitCodeForError,
    RalphieExitCode,
} from "../src/workflow/exit-code.ts";

const wrap = (error: unknown, times: number): unknown => {
    let current = error;
    for (let index = 0; index < times; index += 1) {
        current = new Error(`wrap ${index}`, { cause: current });
    }
    return current;
};

describe("causesOf", () => {
    test("walks the whole chain, however deep", () => {
        const root = new Error("root");
        const causes = causesOf(wrap(root, 12));
        expect(causes).toHaveLength(12);
        expect(causes.at(-1)).toBe(root);
    });

    test("stops at a cycle instead of looping", () => {
        const first = new Error("first");
        const second = new Error("second", { cause: first });
        first.cause = second;
        expect(causesOf(first)).toEqual([second]);
    });

    test("follows plain objects that carry a cause", () => {
        const root = new Error("root");
        expect(causesOf({ cause: { cause: root } })).toEqual([
            { cause: root },
            root,
        ]);
    });
});

test("a halt deep in the cause chain still exits as halted", () => {
    expect(
        exitCodeForError(
            wrap(new RunHaltedError({ message: "limit" }), 12),
            new AbortController().signal,
        ),
    ).toBe(RalphieExitCode.Halted);
});

test("errorMessage and hasErrorCode read any thrown value", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
    expect(hasErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(hasErrorCode(new Error("x"), "ENOENT")).toBe(false);
    expect(hasErrorCode(undefined, "ENOENT")).toBe(false);
});