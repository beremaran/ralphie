import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveWorkspacePath, Workspace, WorkspaceLive } from "./workspace.ts";

describe("workspace cleanup", () => {
  test("expands the default workspace path", () => {
    expect(resolveWorkspacePath("~/.ralphie")).toBe(resolve(homedir(), ".ralphie"));
  });

  test("prepares the workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ralphie-workspace-"));
    const path = join(parent, "nested", "workspace");
    try {
      await Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.prepare(path);
      }).pipe(Effect.provide(WorkspaceLive), Effect.runPromise);

      expect((await stat(path)).isDirectory()).toBeTrue();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test.each(["/", homedir(), resolve(process.cwd(), ".."), process.cwd()])(
    "refuses to remove protected path %s",
    async (path) => {
      const exit = await Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.remove(path);
      }).pipe(Effect.provide(WorkspaceLive), Effect.runPromiseExit);

      expect(Exit.isFailure(exit)).toBeTrue();
    },
  );
});
