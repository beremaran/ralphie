import { describe, expect, test } from "bun:test";

import {
    parseSmokeOptions,
    requireScratchRepository,
    SCRATCH_ENV,
    smokeConfig,
} from "../scripts/live-smoke.ts";

describe("live smoke guard", () => {
    test("requires the repository to be named in flag and environment", () => {
        expect(() => requireScratchRepository(undefined, {})).toThrow(
            "required",
        );
        expect(() => requireScratchRepository("a/b", {})).toThrow("Refusing");
        expect(() =>
            requireScratchRepository("a/b", { [SCRATCH_ENV]: "a/c" }),
        ).toThrow("Refusing");
        expect(requireScratchRepository("a/b", { [SCRATCH_ENV]: "a/b" })).toBe(
            "a/b",
        );
    });

    test("refuses the project repository even when named", () => {
        expect(() =>
            requireScratchRepository("beremaran/ralphie", {
                [SCRATCH_ENV]: "beremaran/ralphie",
            }),
        ).toThrow("not a scratch");
    });

    test("parses harness selection and rejects unknown names", () => {
        const environment = { [SCRATCH_ENV]: "a/b" };
        expect(
            parseSmokeOptions(
                ["--scratch-repo", "a/b", "--harness", "claude,pi"],
                environment,
            ).harnesses,
        ).toEqual(["claude", "pi"]);
        expect(() =>
            parseSmokeOptions(
                ["--scratch-repo", "a/b", "--harness", "x"],
                environment,
            ),
        ).toThrow("Unknown");
    });

    test("config assigns the harness to every role and filters intake", () => {
        const config = smokeConfig("codex", "/tmp/w");
        expect(config).toContain("default: codex");
        expect(config).toContain("requireLabels: [smoke-codex]");
    });
});