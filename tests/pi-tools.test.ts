import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

import { makePiTools } from "../src/pi/adapters/tools.ts";

const guardContext = (input: {
    readonly name: string;
    readonly args: Record<string, unknown>;
}): BeforeToolCallContext =>
    ({
        toolCall: { name: input.name },
        args: input.args,
    }) as unknown as BeforeToolCallContext;

describe("pi tool guard", () => {
    test("denies delivery-state git and GitHub commands", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-guard-"));
        try {
            const tools = makePiTools({ directory });
            for (const command of [
                "git push origin main",
                "git commit -m nope",
                "gh issue list",
                "echo hi && git reset --hard",
            ]) {
                const result = await tools.beforeToolCall(
                    guardContext({ name: "bash", args: { command } }),
                );
                expect(result?.block).toBe(true);
            }
            for (const command of [
                "git diff --cached",
                "git status --short",
                "bun test tests",
            ]) {
                const result = await tools.beforeToolCall(
                    guardContext({ name: "bash", args: { command } }),
                );
                expect(result).toBeUndefined();
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("denies file access outside the repository checkout", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-guard-"));
        const outside = await mkdtemp(join(tmpdir(), "ralphie-pi-outside-"));
        try {
            await writeFile(join(directory, "inside.txt"), "inside", "utf8");
            await writeFile(join(outside, "secret.txt"), "secret", "utf8");
            await symlink(
                join(outside, "secret.txt"),
                join(directory, "escape.txt"),
            );
            const tools = makePiTools({ directory });

            expect(
                await tools.beforeToolCall(
                    guardContext({
                        name: "read",
                        args: { path: "inside.txt" },
                    }),
                ),
            ).toBeUndefined();
            for (const path of [
                "../secret.txt",
                join(outside, "secret.txt"),
                "escape.txt",
            ]) {
                const result = await tools.beforeToolCall(
                    guardContext({ name: "read", args: { path } }),
                );
                expect(result?.block).toBe(true);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });

    test("review sessions block file mutations but allow reads", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-guard-"));
        try {
            const tools = makePiTools({ directory, readOnly: true });
            expect(
                await tools.beforeToolCall(
                    guardContext({
                        name: "write",
                        args: { path: "file.txt", content: "x" },
                    }),
                ),
            ).toMatchObject({ block: true });
            expect(
                await tools.beforeToolCall(
                    guardContext({
                        name: "edit",
                        args: {
                            path: "file.txt",
                            edits: [{ oldText: "a", newText: "b" }],
                        },
                    }),
                ),
            ).toMatchObject({ block: true });
            expect(
                await tools.beforeToolCall(
                    guardContext({
                        name: "read",
                        args: { path: "file.txt" },
                    }),
                ),
            ).toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("wraps pi built-in tools and executes them inside the checkout", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-tools-"));
        try {
            const tools = makePiTools({ directory });
            expect(tools.tools.map((tool) => tool.name)).toEqual([
                "read",
                "write",
                "edit",
                "bash",
            ]);

            const write = tools.tools.find((tool) => tool.name === "write");
            const read = tools.tools.find((tool) => tool.name === "read");
            if (write === undefined || read === undefined) {
                throw new Error("built-in tools missing");
            }

            await write.execute("call-1", {
                path: "hello.txt",
                content: "hi there",
            });
            const result = await read.execute("call-2", { path: "hello.txt" });
            expect(JSON.stringify(result.content)).toContain("hi there");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});