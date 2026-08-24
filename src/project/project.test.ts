import { describe, expect, test } from "bun:test";

import {
  assertSafeProjectName,
  assertUniqueProjectRepositoryNames,
  projectRepositoryPath,
  singleRepositoryProjectPath,
} from "./project.ts";

describe("project checkout layout", () => {
  test("places repositories beneath a safe multi-repository project root", () => {
    expect(projectRepositoryPath("/workspace", "proj-b", "owner/frontend")).toBe(
      "/workspace/proj-b/frontend",
    );
  });

  test("uses the repository clone itself for a single-repository project", () => {
    expect(singleRepositoryProjectPath("/workspace", "owner/lonely-repo")).toBe(
      "/workspace/lonely-repo",
    );
  });

  test.each([
    ".",
    "..",
    ".ralphie",
    "../escape",
    "with/slash",
    "/absolute",
    "with space",
  ])("rejects unsafe project name %s", (name) =>
    expect(() => assertSafeProjectName(name)).toThrow(),
  );

  test("rejects repositories that would share a project clone directory", () => {
    expect(() =>
      assertUniqueProjectRepositoryNames("project", [
        "first/frontend",
        "second/frontend",
      ]),
    ).toThrow("duplicate clone directory names");
  });
});
