#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");
const packageName = "@beremaran/ralphie";
const usage = `Usage:
  bun run package:check
  bun run package:check -- --dry-run
  bun run package:check -- --registry --package-spec @beremaran/ralphie@<version>

The default checks the package built from this checkout. --dry-run only
inspects npm pack's file list. --registry is required for a package spec so
registry checks cannot happen during ordinary local checks.`;

type CheckOptions = {
    readonly dryRun: boolean;
    readonly packageSpec: string | undefined;
    readonly registry: boolean;
};

type CheckLayout = {
    readonly cache: string;
    readonly home: string;
    readonly install: string;
    readonly pack: string;
    readonly root: string;
};

const fail = (message: string): never => {
    throw new Error(`Package check: ${message}`);
};

const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env?: Record<string, string>,
): string => {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
        result = Bun.spawnSync([command, ...args], {
            cwd,
            env,
            stderr: "pipe",
            stdout: "pipe",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not start ${command} ${args.join(" ")}: ${message}`);
    }
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (result.exitCode !== 0) {
        return fail(
            `${command} ${args.join(" ")} failed with exit ${result.exitCode}.\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`,
        );
    }
    return stdout;
};

const isolatedEnv = (home: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.toLowerCase().startsWith("npm_")) {
            env[key] = value;
        }
    }
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.NPM_CONFIG_USERCONFIG = join(home, ".npmrc");
    delete env.NODE_PATH;
    return env;
};

const parseCheckOptions = (): CheckOptions => {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            "dry-run": { type: "boolean", default: false },
            registry: { type: "boolean", default: false },
            "package-spec": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: false,
    });
    if (values.help) {
        console.log(usage);
        process.exit(0);
    }
    const options = {
        dryRun: values["dry-run"] ?? false,
        packageSpec: values["package-spec"],
        registry: values.registry ?? false,
    };
    if (options.packageSpec !== undefined && !options.registry) {
        return fail(
            "a package spec requires --registry; the default is the local checkout.",
        );
    }
    if (options.registry && options.packageSpec === undefined) {
        return fail("--registry requires --package-spec <name>@<version>.");
    }
    return options;
};

const exactVersionPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const exactVersion = (options: CheckOptions): string => {
    if (!options.registry) return packageJson.version;
    const prefix = `${packageName}@`;
    const spec = options.packageSpec ?? "";
    if (!spec.startsWith(prefix)) {
        return fail(
            `registry checks require an exact package spec in the form ${packageName}@<version>.`,
        );
    }
    const version = spec.slice(prefix.length);
    if (!exactVersionPattern.test(version)) {
        return fail(
            `registry checks require an exact package version in ${JSON.stringify(spec)}; tags and ranges are not supported.`,
        );
    }
    return version;
};

const normalizeEntry = (entry: string): string =>
    entry
        .replace(/^\.?\//, "")
        .replace(/^package\//, "")
        .replace(/\/$/, "");

const assertAllowlist = (files: ReadonlyArray<string>): void => {
    const expected = new Set<string>([
        ...((packageJson as { files?: ReadonlyArray<string> }).files ?? []),
        "package.json",
    ]);
    const actual = new Set(
        files.map(normalizeEntry).filter((entry) => entry.length > 0),
    );
    const missing = [...expected].filter((entry) => !actual.has(entry));
    if (missing.length > 0) {
        return fail(`package file list is missing ${missing.join(", ")}.`);
    }
    const unexpected = [...actual].filter((entry) => !expected.has(entry));
    if (unexpected.length > 0) {
        return fail(
            `package file list contains unexpected ${unexpected.join(", ")}.`,
        );
    }
};

const packRecordFrom = (
    output: string,
    label: string,
): Record<string, unknown> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output.trim()) as unknown;
    } catch {
        return fail(`${label} did not produce JSON. Output was:\n${output}`);
    }
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<
        string,
        unknown
    >;
    if (typeof record !== "object" || record === null) {
        return fail(`${label} returned no package record.`);
    }
    return record;
};

const packFileList = (
    options: CheckOptions,
    layout: CheckLayout,
    cwd: string,
): ReadonlyArray<string> => {
    const args = ["pack"];
    if (options.packageSpec !== undefined) args.push(options.packageSpec);
    args.push(
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--cache",
        layout.cache,
        "--no-audit",
        "--no-fund",
    );
    const record = packRecordFrom(
        run("npm", args, cwd, isolatedEnv(layout.home)),
        "npm pack --dry-run",
    );
    if (record.name !== packageName) {
        return fail(
            `npm pack --dry-run reports package name ${JSON.stringify(record.name)}; expected ${packageName}.`,
        );
    }
    if (!Array.isArray(record.files)) {
        return fail("npm pack --dry-run returned no file list.");
    }
    return (record.files as ReadonlyArray<unknown>).map((file) => {
        const path =
            typeof file === "object" && file !== null
                ? (file as Record<string, unknown>).path
                : undefined;
        if (typeof path !== "string") {
            return fail("npm pack --dry-run returned a file without a path.");
        }
        return path;
    });
};

const packTarball = (
    options: CheckOptions,
    layout: CheckLayout,
    cwd: string,
): string => {
    const args = ["pack"];
    if (options.packageSpec !== undefined) args.push(options.packageSpec);
    args.push(
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        layout.pack,
        "--cache",
        layout.cache,
        "--no-audit",
        "--no-fund",
    );
    const record = packRecordFrom(
        run("npm", args, cwd, isolatedEnv(layout.home)),
        "npm pack",
    );
    const filename = record.filename;
    if (typeof filename !== "string") {
        return fail("npm pack returned no tarball filename.");
    }
    return join(layout.pack, filename);
};

const assertVersionOutputs = (
    executable: string,
    cwd: string,
    expectedVersion: string,
    env: Record<string, string>,
): void => {
    const plain = run(process.execPath, [executable, "--version"], cwd, env);
    if (plain !== `${expectedVersion}\n`) {
        return fail(
            `installed executable reported ${JSON.stringify(plain)}; expected exactly ${JSON.stringify(`${expectedVersion}\n`)}.`,
        );
    }
    const jsonOutput = run(
        process.execPath,
        [executable, "--version", "--output", "json"],
        cwd,
        env,
    );
    const record = packRecordFrom(
        jsonOutput,
        "installed executable --version --output json",
    );
    if (record.version !== expectedVersion) {
        return fail(
            `JSON version output was ${JSON.stringify(record)}; expected version ${expectedVersion}.`,
        );
    }
    if (typeof record.commitSha !== "string" || record.commitSha.length === 0) {
        return fail("JSON version output has no build commit SHA.");
    }
};

const makeLayout = async (): Promise<CheckLayout> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-package-"));
    const layout = {
        cache: join(root, "npm-cache"),
        home: join(root, "home"),
        install: join(root, "install"),
        pack: join(root, "pack"),
        root,
    };
    await Promise.all(
        [layout.cache, layout.home, layout.pack, layout.install].map((path) =>
            mkdir(path, { recursive: true }),
        ),
    );
    return layout;
};

const installAndVerify = async (
    tarball: string,
    layout: CheckLayout,
    expectedVersion: string,
): Promise<void> => {
    await writeFile(
        join(layout.install, "package.json"),
        `${JSON.stringify({ name: "ralphie-package-fixture", private: true, version: "1.0.0" }, null, 2)}\n`,
    );
    const env = isolatedEnv(layout.home);
    run(
        "npm",
        [
            "install",
            "--omit=dev",
            "--ignore-scripts",
            "--package-lock=false",
            "--cache",
            layout.cache,
            "--no-audit",
            "--no-fund",
            tarball,
        ],
        layout.install,
        env,
    );
    const installedRoot = join(layout.install, "node_modules", packageName);
    const manifest = JSON.parse(
        await Bun.file(join(installedRoot, "package.json")).text(),
    ) as Record<string, unknown>;
    if (manifest.name !== packageName || manifest.version !== expectedVersion) {
        return fail(
            `installed package is ${JSON.stringify(manifest.name)}@${JSON.stringify(manifest.version)}; expected ${packageName}@${expectedVersion}.`,
        );
    }
    const bin = manifest.bin as Record<string, string> | undefined;
    if (typeof bin?.ralphie !== "string") {
        return fail(
            "installed package does not define the ralphie executable.",
        );
    }
    assertVersionOutputs(
        resolve(installedRoot, bin.ralphie),
        layout.install,
        expectedVersion,
        env,
    );
};

const main = async (): Promise<void> => {
    const options = parseCheckOptions();
    const expectedVersion = exactVersion(options);
    if (!options.registry && packageJson.name !== packageName) {
        return fail(
            `package.json declares package name ${JSON.stringify(packageJson.name)}; expected ${JSON.stringify(packageName)}.`,
        );
    }
    const layout = await makeLayout();
    try {
        if (!options.registry) {
            run(
                process.execPath,
                ["run", "scripts/build.ts", "--package"],
                repositoryRoot,
            );
        }
        const cwd = options.registry ? layout.root : repositoryRoot;
        assertAllowlist(packFileList(options, layout, cwd));
        if (options.dryRun) {
            console.log(
                `Package dry run passed for ${options.packageSpec ?? "the local checkout"}.`,
            );
            return;
        }
        await installAndVerify(
            packTarball(options, layout, cwd),
            layout,
            expectedVersion,
        );
        console.log(
            `Package check passed for ${options.packageSpec ?? `${packageName}@${expectedVersion}`}.`,
        );
    } finally {
        await rm(layout.root, { force: true, recursive: true }).catch(
            () => undefined,
        );
    }
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}