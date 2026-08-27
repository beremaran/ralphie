import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
    resolveWorkspacePath,
    WorkspaceLive,
} from "../../src/workspace/workspace.ts";

describe("workspace cleanup", () => {
    test("expands the default workspace path", () => {
        expect(resolveWorkspacePath("~/.ralphie")).toBe(
            resolve(homedir(), ".ralphie"),
        );
    });

    test("prepares the workspace root", async () => {
        const parent = await mkdtemp(join(tmpdir(), "ralphie-workspace-"));
        const path = join(parent, "nested", "workspace");
        try {
            await WorkspaceLive.prepare(path);
            expect((await stat(path)).isDirectory()).toBeTrue();
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    test.each(["/", homedir(), resolve(process.cwd(), ".."), process.cwd()])(
        "refuses to remove protected path %s",
        async (path) => {
            await expect(WorkspaceLive.remove(path)).rejects.toThrow(
                "Refusing to clean up protected workspace path",
            );
        },
    );
});