import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand, type CommandFactories } from "../src/command.ts";
import { yamlConfigDocumentReader } from "../src/config/adapters/yaml-file.ts";
import { loadSettings } from "../src/config/load.ts";
import { parseRepositoryArgument } from "../src/github/repository.ts";
import { resolveRoleAssignments } from "../src/harness/app/roles.ts";
import { makeHarnessStartupChecker } from "../src/harness/app/startup-checks.ts";
import { HARNESS_NAMES, type HarnessProbe } from "../src/harness/ports.ts";
import {
    temporaryDirectory,
    workflowErrorFor,
} from "./shared/config-fixture.ts";

const probeWith = (
    installed: ReadonlyArray<string>,
): Pick<HarnessProbe, "installed"> & HarnessProbe => ({
    capabilities: () => ({ nativeSchema: true, budgetCap: true }),
    installed: async (name) =>
        installed.includes(name)
            ? { ok: true }
            : { ok: false, message: "not found" },
    safeAccess: async () => ({ ok: true }),
});

const runInit = async (
    installed: ReadonlyArray<string>,
    home: string,
    extraArgs: ReadonlyArray<string> = [],
): Promise<string> => {
    let stdout = "";
    await runCommand(["init", ...extraArgs], {
        environment: {},
        homeDirectory: home,
        output: {
            stdout: (text) => {
                stdout += text;
            },
            stderr: () => {},
        },
        factories: { harnessProbe: probeWith(installed) },
    });
    return stdout;
};

const configPathFor = (home: string): string =>
    join(home, ".config", "ralphie", "config.yaml");

describe("ralphie init", () => {
    test("writes a commented config at the default location", async () => {
        const home = await temporaryDirectory();

        const stdout = await runInit(["claude", "codex"], home);

        const text = await readFile(configPathFor(home), "utf8");
        expect(text).toContain("# ");
        expect(text).toContain("default: claude");
        expect(stdout).toContain(configPathFor(home));
        expect(stdout).toContain("claude, codex");
    });

    test("honors --config", async () => {
        const home = await temporaryDirectory();
        const path = join(home, "custom.yaml");

        await runInit(["codex"], home, ["--config", path]);

        expect(await readFile(path, "utf8")).toContain("default: codex");
    });

    test("never overwrites an existing config", async () => {
        const home = await temporaryDirectory();
        const path = configPathFor(home);
        await runInit(["claude"], home);
        await writeFile(path, "approval: yolo\n");

        await expect(runInit(["claude"], home)).rejects.toThrow(
            "already exists",
        );
        expect(await readFile(path, "utf8")).toBe("approval: yolo\n");
    });

    test("fails when no harness is on PATH", async () => {
        const home = await temporaryDirectory();

        await expect(runInit([], home)).rejects.toThrow(
            "No supported harness found",
        );
    });

    for (const harness of HARNESS_NAMES) {
        test(`defaults for ${harness} pass the startup checks`, async () => {
            const home = await temporaryDirectory();
            await runInit([harness], home);

            const loaded = await loadSettings({
                reader: yamlConfigDocumentReader,
                environment: {},
                homeDirectory: home,
                overrides: [],
                repository: parseRepositoryArgument("o/r"),
                githubLogin: async () => "o",
            });
            const report = await makeHarnessStartupChecker(
                probeWith([harness]),
            )({ roles: resolveRoleAssignments(loaded.settings) });

            expect(report.errors).toEqual([]);
        });
    }

    test("a run without a config points at init", async () => {
        const home = await temporaryDirectory();
        const factories: CommandFactories = {};

        const error = await workflowErrorFor(["owner/repository"], {
            homeDirectory: home,
            factories,
        });

        expect(error.message).toContain("ralphie init");
    });
});