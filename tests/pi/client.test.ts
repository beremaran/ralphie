import { describe, expect, test } from "bun:test";

import { isPiTaskCommandAllowed } from "../../src/pi/client.ts";

describe("Pi task shell policy", () => {
    test("allows ordinary inspection and verification commands", () => {
        expect(isPiTaskCommandAllowed("bun test tests/issues")).toBe(true);
        expect(isPiTaskCommandAllowed("git diff --stat")).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src")).toBe(true);
        expect(
            isPiTaskCommandAllowed("git status --short && git diff --check"),
        ).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src | head -20")).toBe(true);
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
            "printf Z2l0IHB1c2g= | base64 -d | sh",
            "git status || git push",
            "env bash -c 'git push'",
        ]) {
            expect(isPiTaskCommandAllowed(command)).toBe(false);
        }
    });
});