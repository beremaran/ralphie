import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import { NeedsAttentionStop } from "../../src/process/exit-code.ts";
import { makeCommandRuntimeHarness } from "./command-runtime-harness.ts";

describe("command/runtime display harness", () => {
    test("routes maintenance mode to its guarded entry point", async () => {
        const previousExitCode = process.exitCode;
        try {
            const harness = makeCommandRuntimeHarness();

            await expect(
                harness.run(["owner/repository", "--mode", "maintain-issues"]),
            ).rejects.toThrow(
                "The maintain-issues execution mode is not implemented yet.",
            );
            expect(harness.lifecycle).not.toContain("workflow");
        } finally {
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("routes fake progress and Pi events through the command coordinator", async () => {
        const harness = makeCommandRuntimeHarness();

        await harness.run();
        await harness.dispose();
        await harness.dispose();

        expect(harness.stderr.join("")).toContain("Fake progress");
        expect(harness.stderr.join("")).toContain("fake Pi event");
        expect(harness.stdout).toEqual([]);
        expect(harness.piEvents).toHaveLength(1);
        expect(harness.eventLogPath).toEndWith("events.jsonl");
        expect(harness.runtime?.githubClient).toBeDefined();
        expect(harness.runtime?.gitRepository).toBeDefined();
        expect(harness.runtime?.workspace).toBeDefined();
        expect(harness.lifecycle.slice(0, 3)).toEqual([
            "pi",
            "runtime",
            "workflow",
        ]);
        expect(
            harness.lifecycle.filter((call) => call === "runtime.dispose"),
        ).toHaveLength(1);
        expect(
            harness.lifecycle.filter((call) => call === "coordinator.dispose"),
        ).toHaveLength(1);
    });

    test("still disposes the coordinator when runtime disposal fails", async () => {
        const harness = makeCommandRuntimeHarness();
        harness.failRuntimeDisposalWith(new Error("runtime disposal failed"));

        await expect(harness.run()).rejects.toThrow("runtime disposal failed");
        expect(harness.lifecycle).toContain("runtime.dispose");
        expect(harness.lifecycle).toContain("coordinator.dispose");
    });

    test("uses the package version for plain and JSON version output", async () => {
        const plainHarness = makeCommandRuntimeHarness();
        await plainHarness.run(["--version"]);

        expect(plainHarness.stdout).toEqual([`${packageJson.version}\n`]);
        expect(plainHarness.stderr).toEqual([]);
        expect(plainHarness.lifecycle).toEqual([]);

        const jsonHarness = makeCommandRuntimeHarness();
        await jsonHarness.run(["--version", "--output", "json"]);

        expect(jsonHarness.stdout).toHaveLength(1);
        expect(JSON.parse(jsonHarness.stdout[0] ?? "")).toMatchObject({
            version: packageJson.version,
            commitSha: expect.any(String),
        });
        expect(jsonHarness.stderr).toEqual([]);
        expect(jsonHarness.lifecycle).toEqual([]);
    });

    test("handles a needs-attention stop with its distinct exit code", async () => {
        const previousExitCode = process.exitCode;
        try {
            const harness = makeCommandRuntimeHarness();
            harness.failWith(
                new NeedsAttentionStop({
                    issueNumber: 42,
                    summary: "missing prerequisite",
                }),
            );

            await harness.run();

            expect(process.exitCode).toBe(2);
            expect(harness.stderr.join(" ")).not.toContain("failed");
            expect(harness.lifecycle).toContain("runtime.dispose");
            expect(harness.lifecycle).toContain("coordinator.dispose");
        } finally {
            process.exitCode = previousExitCode ?? 0;
        }
    });

    test("captures deterministic abort and failure triggers", async () => {
        const previousExitCode = process.exitCode;
        try {
            const harness = makeCommandRuntimeHarness();
            harness.abortController.abort();
            harness.failWith(new Error("fake failure"));
            harness.failRuntimeDisposalWith(
                new Error("runtime disposal failed"),
            );

            await expect(harness.run()).rejects.toThrow("fake failure");
            expect(process.exitCode).toBe(130);
            expect(harness.lifecycle).toContain("runtime.dispose");
            expect(harness.lifecycle).toContain("coordinator.dispose");
        } finally {
            process.exitCode = previousExitCode ?? 0;
        }
    });
});