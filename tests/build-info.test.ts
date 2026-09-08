import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import packageJson from "../package.json";
import { BUILD_INFO, LOCAL_BUILD_COMMIT_SHA } from "../src/build-info.ts";

const repositoryRoot = join(import.meta.dir, "..");

const run = (command: string, args: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync([command, ...args], {
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed: ${result.stderr.toString()}`,
        );
    }
    return stdout;
};

describe("build info", () => {
    test("uses package.json as the sole runtime version authority", () => {
        expect(BUILD_INFO.version).toBe(packageJson.version);
    });

    test("uses the documented sentinel without injected release metadata", () => {
        expect(BUILD_INFO.commitSha).toBe(LOCAL_BUILD_COMMIT_SHA);
    });

    test("embeds explicit release metadata in built JSON version output", () => {
        const commitSha = "0123456789abcdef0123456789abcdef01234567";
        run(process.execPath, [
            "run",
            "build",
            "--",
            "--commit-sha",
            commitSha,
        ]);

        expect(
            JSON.parse(
                run(process.execPath, [
                    "./dist/ralphie.js",
                    "--version",
                    "--output",
                    "json",
                ]),
            ),
        ).toEqual({ version: packageJson.version, commitSha });
    });
});