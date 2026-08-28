import { describe, expect, test } from "bun:test";

import { RALPHIE_VERSION } from "../../src/version.ts";
import { makeCommandRuntimeHarness } from "./command-runtime-harness.ts";

describe("command/runtime display harness", () => {
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

    test("captures output written directly by command orchestration", async () => {
        const harness = makeCommandRuntimeHarness();

        await harness.run(["--version"]);

        expect(harness.stdout).toEqual([`${RALPHIE_VERSION}\n`]);
        expect(harness.stderr).toEqual([]);
        expect(harness.lifecycle).toEqual([]);
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