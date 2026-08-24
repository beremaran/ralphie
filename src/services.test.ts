import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  parseRepositorySlug,
  resolveWorkspacePath,
  Workspace,
  WorkspaceLive,
} from "./services.ts";

describe("repository parsing", () => {
  test.each([
    "owner/repository",
    "https://github.com/owner/repository.git",
    "git@github.com:owner/repository.git",
  ])("normalizes %s", (repository) => {
    expect(parseRepositorySlug(repository)).toEqual({
      slug: "owner/repository",
      name: "repository",
    });
  });

  test.each(["repository", "../repository", "owner/..", "owner/repo/extra"])(
    "rejects invalid repository %s",
    (repository) => {
      expect(() => parseRepositorySlug(repository)).toThrow(
        "Expected owner/repository",
      );
    },
  );
});

describe("workspace cleanup", () => {
  test("expands the default workspace path", () => {
    expect(resolveWorkspacePath("~/.ralphie")).toBe(
      resolve(homedir(), ".ralphie"),
    );
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
