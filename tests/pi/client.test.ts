import { describe, expect, test } from "bun:test";

import {
    buildPiAttemptPrompt,
    isPiTaskCommandAllowed,
} from "../../src/pi/client.ts";

describe("Pi task shell policy", () => {
    test("allows ordinary inspection and verification commands", () => {
        expect(isPiTaskCommandAllowed("bun test tests/issues")).toBe(true);
        expect(isPiTaskCommandAllowed("git diff --stat")).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src")).toBe(true);
        expect(
            isPiTaskCommandAllowed("git status --short && git diff --check"),
        ).toBe(true);
        expect(isPiTaskCommandAllowed("rg -n TODO src | head -20")).toBe(true);
        expect(isPiTaskCommandAllowed("cd /workspace && bun test")).toBe(true);
        expect(
            isPiTaskCommandAllowed("bun test || bun test --rerun-each 2"),
        ).toBe(true);
        expect(
            isPiTaskCommandAllowed("node -e 'console.log(1)' > result.txt"),
        ).toBe(true);
        expect(isPiTaskCommandAllowed("echo $(git status --short)")).toBe(true);
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

    test("rejects explicit orchestration-owned mutations in composed commands", () => {
        for (const command of [
            "bun test && git commit -am fix",
            "git status; git push",
            "git status || git push",
            "cd /workspace && gh issue close 12",
        ]) {
            expect(isPiTaskCommandAllowed(command)).toBe(false);
        }
    });
});

describe("Pi prompt contract", () => {
    test("marks ordinary tasks as unattended and non-interactive", () => {
        const prompt = buildPiAttemptPrompt(
            "Implement the issue.",
            false,
            false,
        );

        expect(prompt).toContain("Implement the issue.");
        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("No user or operator can answer");
        expect(prompt).toContain("Do not ask questions in prose");
        expect(prompt).toContain("call request_needs_attention");
        expect(prompt).toContain("completion or result tool");
        expect(prompt).not.toContain("MANDATORY RESPONSE CONTRACT");
    });

    test("requires structured tasks to finish through submit_result", () => {
        const prompt = buildPiAttemptPrompt("Review the change.", true, false);

        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("MANDATORY RESPONSE CONTRACT");
        expect(prompt).toContain(
            "final action must be exactly one call to the submit_result tool",
        );
        expect(prompt).toContain("printed JSON, or a question");
    });

    test("repeats unattended and tool requirements after a contract violation", () => {
        const prompt = buildPiAttemptPrompt("ignored", true, true);

        expect(prompt).toContain("UNATTENDED EXECUTION CONTRACT");
        expect(prompt).toContain("RESPONSE CONTRACT VIOLATION");
        expect(prompt).toContain("Call submit_result now");
        expect(prompt).toContain("prose, Markdown, printed JSON, or questions");
    });
});