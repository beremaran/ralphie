import { describe, expect, test } from "bun:test";

import { isPiTaskCommandAllowed } from "../client.ts";

describe("Pi task shell policy", () => {
  test("allows ordinary inspection and verification commands", () => {
    expect(isPiTaskCommandAllowed("bun test src/issues")).toBe(true);
    expect(isPiTaskCommandAllowed("git diff --stat")).toBe(true);
    expect(isPiTaskCommandAllowed("rg -n TODO src")).toBe(true);
  });

  test("reserves Git and GitHub mutations for Ralphie", () => {
    for (const command of [
      "git commit -m fix",
      "git push origin main",
      "git checkout other",
      "git reset --hard HEAD~1",
      "gh issue close 12",
    ]) {
      expect(isPiTaskCommandAllowed(command)).toBe(false);
    }
  });

  test("rejects shell composition that could hide a forbidden command", () => {
    for (const command of [
      "bun test && git commit -am fix",
      "git status; git push",
      "echo ok | sh",
      "echo $(git status)",
      "echo ok > result.txt",
    ]) {
      expect(isPiTaskCommandAllowed(command)).toBe(false);
    }
  });
});