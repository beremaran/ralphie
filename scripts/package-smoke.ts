#!/usr/bin/env bun

import {
    access,
    mkdtemp,
    mkdir,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import packageJson from "../package.json";

type JsonRecord = Record<string, unknown>;

type SmokeOptions = {
    readonly dryRun: boolean;
    readonly help: boolean;
    readonly packageSpec?: string;
    readonly registry: boolean;
};

type ProcessOutput = {
    readonly stderr: string;
    readonly stdout: string;
};

type TemporaryLayout = {
    readonly cache: string;
    readonly home: string;
    readonly install: string;
    readonly pack: string;
    readonly registry: string;
    readonly root: string;
};

type InstalledPackage = {
    readonly executable: string;
    readonly manifest: JsonRecord;
    readonly root: string;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const expectedPackageName = "@beremaran/ralphie";
const expectedRepository = "beremaran/ralphie";
const usage = `Usage:
  bun run package:check
  bun run package:check -- --dry-run
  bun run package:check -- --registry --package-spec @beremaran/ralphie@<version>

The default checks the package built from this checkout. --dry-run only
inspects npm pack's file list. --registry is required for a package spec so
registry checks cannot happen during ordinary local checks.`;

const fail = (message: string): never => {
    throw new Error(`Package smoke check: ${message}`);
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const pathExists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

type ParserState = {
    dryRun: boolean;
    help: boolean;
    packageSpec?: string;
    registry: boolean;
};

const parseOptionValue = (
    args: ReadonlyArray<string>,
    index: number,
    option: string,
): string => {
    const value = args[index + 1];
    if (value === undefined) {
        return fail(`${option} requires a package spec value.`);
    }
    if (value.startsWith("-")) {
        return fail(`${option} requires a package spec value.`);
    }
    return value;
};

const setPackageSpec = (state: ParserState, value: string): void => {
    if (value.length === 0) fail("package spec cannot be empty.");
    if (state.packageSpec !== undefined) {
        fail(`received more than one package spec: ${value}`);
    }
    state.packageSpec = value;
};

const parseOtherArgument = (argument: string, state: ParserState): void => {
    const inlinePrefixes = ["--package-spec=", "--package=", "--spec="];
    const prefix = inlinePrefixes.find((candidate) =>
        argument.startsWith(candidate),
    );
    if (prefix !== undefined) {
        setPackageSpec(state, argument.slice(prefix.length));
        return;
    }
    if (argument.startsWith("-")) fail(`unknown option: ${argument}`);
    setPackageSpec(state, argument);
};

const validatedOptions = (state: ParserState): SmokeOptions => {
    if (state.help) return state;
    if (state.packageSpec !== undefined && !state.registry) {
        fail(
            "a package spec requires --registry; the default is the local checkout.",
        );
    }
    if (state.registry && state.packageSpec === undefined) {
        fail("--registry requires --package-spec <name>@<version>.");
    }
    return state;
};

const parseOptions = (args: ReadonlyArray<string>): SmokeOptions => {
    const state: ParserState = {
        dryRun: false,
        help: false,
        registry: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === undefined) {
            return fail("received an empty argument.");
        }
        switch (argument) {
            case "--dry-run":
                state.dryRun = true;
                break;
            case "--help":
            case "-h":
                state.help = true;
                break;
            case "--registry":
                state.registry = true;
                break;
            case "--package-spec":
            case "--package":
            case "--spec":
                setPackageSpec(state, parseOptionValue(args, index, argument));
                index += 1;
                break;
            default:
                parseOtherArgument(argument, state);
        }
    }
    return validatedOptions(state);
};

const commandDescription = (
    command: string,
    args: ReadonlyArray<string>,
): string => [command, ...args].join(" ");

const spawnProcess = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env?: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> => {
    try {
        return Bun.spawnSync([command, ...args], {
            cwd,
            env,
            stderr: "pipe",
            stdout: "pipe",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `could not start ${commandDescription(command, args)} in ${cwd}: ${message}`,
        );
    }
};

const runProcess = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    label: string,
    env?: Record<string, string>,
): ProcessOutput => {
    const result = spawnProcess(command, args, cwd, env);
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (result.exitCode !== 0) {
        fail(
            `${label} failed with exit code ${result.exitCode}.
Command: ${commandDescription(command, args)}
stdout:
${stdout || "(empty)"}
stderr:
${stderr || "(empty)"}`,
        );
    }
    return { stderr, stdout };
};

const parseJsonOutput = (output: string, label: string): unknown => {
    const trimmed = output.trim();
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        const start = trimmed.indexOf("[");
        const end = trimmed.lastIndexOf("]");
        if (start < 0 || end < start) {
            return fail(
                `${label} did not produce JSON. Output was:\n${output}`,
            );
        }
        try {
            return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            return fail(`${label} produced invalid JSON: ${message}`);
        }
    }
};

const packRecordFrom = (output: string): JsonRecord => {
    const parsed = parseJsonOutput(output, "npm pack --dry-run");
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isRecord(record)) {
        return fail("npm pack --dry-run returned no package record.");
    }
    return record;
};

const normalizeArchivePath = (entry: string): string => {
    let normalized = entry.replace(/^\.?\//, "").replace(/^package\//, "");
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
};

const dryRunFilesFrom = (output: string): ReadonlyArray<string> => {
    const record = packRecordFrom(output);
    const rawFiles = record.files;
    if (!Array.isArray(rawFiles)) {
        return fail("npm pack --dry-run returned no file list.");
    }
    return rawFiles.map((file: unknown) => {
        if (!isRecord(file) || typeof file.path !== "string") {
            return fail("npm pack --dry-run returned a file without a path.");
        }
        return normalizeArchivePath(file.path);
    });
};

const archiveFilesFrom = (
    tarball: string,
    cwd: string,
): ReadonlyArray<string> => {
    const output = runProcess(
        "tar",
        ["-tzf", tarball],
        cwd,
        "tarball inspection",
    ).stdout;
    const files = output
        .split(/\r?\n/)
        .filter((entry) => !entry.endsWith("/"))
        .map((entry) => normalizeArchivePath(entry))
        .filter((entry) => entry.length > 0);
    if (files.length === 0) fail(`tarball ${tarball} is empty.`);
    return files;
};

const sourceRuntimeEntry = (): string => {
    const bin = packageJson.bin;
    const entry =
        typeof bin === "string"
            ? bin
            : bin && typeof bin.ralphie === "string"
              ? bin.ralphie
              : undefined;
    if (entry === undefined)
        return fail("package.json does not define the ralphie bin.");
    return normalizeArchivePath(entry);
};

const allowedDocumentationEntries = new Set([
    "docs/architecture.md",
    "docs/cli-reference.md",
    "docs/development.md",
    "docs/end-to-end-execution.md",
    "docs/getting-started.md",
    "docs/operations-and-recovery.md",
    "docs/public-distribution.md",
    "docs/README.md",
    "docs/releases.md",
    "docs/safety.md",
    "docs/workflows.md",
]);

const isAllowedArchiveEntry = (entry: string, runtimeEntry: string): boolean =>
    entry === "package.json" ||
    entry === "README.md" ||
    entry === "CHANGELOG.md" ||
    entry === "LICENSE" ||
    entry === runtimeEntry ||
    allowedDocumentationEntries.has(entry);

const isForbiddenArchiveEntry = (entry: string): boolean =>
    entry === "Dockerfile" ||
    entry === ".editorconfig" ||
    entry === "bun.lock" ||
    entry === "biome.json" ||
    entry === "tsconfig.json" ||
    entry.startsWith("tests/") ||
    entry.startsWith(".github/") ||
    entry.startsWith("Formula/") ||
    entry.startsWith("src/") ||
    entry.startsWith("scripts/");

const validateArchiveFiles = (
    files: ReadonlyArray<string>,
    label: string,
    runtimeEntry: string,
): void => {
    const uniqueFiles = [...new Set(files)];
    if (!uniqueFiles.includes("package.json")) {
        fail(`${label} is missing package.json.`);
    }
    if (!uniqueFiles.includes(runtimeEntry)) {
        fail(
            `${label} is missing the selected runtime entry ${runtimeEntry}. Included files: ${uniqueFiles.join(", ")}`,
        );
    }

    const forbidden = uniqueFiles.filter(isForbiddenArchiveEntry);
    if (forbidden.length > 0) {
        fail(
            `${label} contains forbidden repository content (${forbidden.join(", ")}); tests, workflows, the formula, Dockerfile, .editorconfig, and source files must be excluded.`,
        );
    }
    const unrelated = uniqueFiles.filter(
        (entry) => !isAllowedArchiveEntry(entry, runtimeEntry),
    );
    if (unrelated.length > 0) {
        fail(
            `${label} contains unrelated repository content: ${unrelated.join(", ")}. Expected only the runtime entry, package metadata, documentation, and license files.`,
        );
    }
};

const npmArgs = (cache: string): ReadonlyArray<string> => [
    "--cache",
    cache,
    "--no-audit",
    "--no-fund",
];

const inspectPack = (
    options: SmokeOptions,
    layout: TemporaryLayout,
): ReadonlyArray<string> => {
    const args = ["pack"];
    if (options.packageSpec !== undefined) args.push(options.packageSpec);
    args.push(
        "--dry-run",
        "--json",
        "--ignore-scripts",
        ...npmArgs(layout.cache),
    );
    const cwd = options.registry ? layout.registry : repositoryRoot;
    const output = runProcess(
        "npm",
        args,
        cwd,
        "npm pack --dry-run",
        isolatedEnvironment(layout.home),
    ).stdout;
    return dryRunFilesFrom(output);
};

const packageTarball = async (
    options: SmokeOptions,
    layout: TemporaryLayout,
): Promise<string> => {
    const args = ["pack"];
    if (options.packageSpec !== undefined) args.push(options.packageSpec);
    args.push(
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        layout.pack,
        ...npmArgs(layout.cache),
    );
    const cwd = options.registry ? layout.registry : repositoryRoot;
    runProcess("npm", args, cwd, "npm pack", isolatedEnvironment(layout.home));

    const tarballs = (await readdir(layout.pack)).filter((entry) =>
        entry.endsWith(".tgz"),
    );
    if (tarballs.length !== 1) {
        return fail(
            `expected npm pack to create one tarball in ${layout.pack}, found ${tarballs.length}.`,
        );
    }
    const tarball = tarballs[0];
    if (tarball === undefined) {
        return fail(`npm pack did not create a tarball in ${layout.pack}.`);
    }
    return join(layout.pack, tarball);
};

const validateSourcePackage = (): void => {
    if (packageJson.name !== expectedPackageName) {
        return fail(
            `package.json declares package name ${JSON.stringify(packageJson.name)}; expected ${JSON.stringify(expectedPackageName)}.`,
        );
    }
};

const packageBuild = (): void => {
    runProcess(
        process.execPath,
        ["run", "scripts/build.ts", "--package"],
        repositoryRoot,
        "package build",
    );
};

const makeLayout = async (): Promise<TemporaryLayout> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-package-smoke-"));
    const checkoutRelation = relative(repositoryRoot, root);
    const outsideCheckout =
        checkoutRelation === ".." ||
        checkoutRelation.startsWith(`..${sep}`) ||
        checkoutRelation.startsWith(sep);
    if (!outsideCheckout) {
        await rm(root, { force: true, recursive: true });
        fail(
            `temporary package smoke directory is inside the checkout: ${root}`,
        );
    }

    const layout = {
        cache: join(root, "npm-cache"),
        home: join(root, "home"),
        install: join(root, "install"),
        pack: join(root, "pack"),
        registry: join(root, "registry"),
        root,
    } satisfies TemporaryLayout;
    await Promise.all(
        [
            layout.cache,
            layout.home,
            layout.install,
            layout.pack,
            layout.registry,
        ].map((path) => mkdir(path, { recursive: true })),
    );
    return layout;
};

const directDependencyName = async (
    layout: TemporaryLayout,
): Promise<string> => {
    const fixtureManifest = await readJsonRecord(
        join(layout.install, "package.json"),
        "fresh fixture manifest",
    );
    const dependencies = fixtureManifest.dependencies;
    if (!isRecord(dependencies)) {
        return fail("fresh fixture has no installed package dependency.");
    }
    const dependencyNames = Object.keys(dependencies);
    if (dependencyNames.length !== 1) {
        return fail(
            `fresh fixture should have one direct package dependency, found ${dependencyNames.join(", ") || "none"}.`,
        );
    }
    const packageName = dependencyNames[0];
    if (packageName === undefined) {
        return fail("fresh fixture dependency name is missing.");
    }
    return packageName;
};

const installedExecutable = async (
    root: string,
    manifest: JsonRecord,
): Promise<string> => {
    const bin = manifest.bin;
    const binEntry =
        typeof bin === "string"
            ? bin
            : isRecord(bin) && typeof bin.ralphie === "string"
              ? bin.ralphie
              : undefined;
    if (binEntry === undefined) {
        return fail(
            "installed package does not define the ralphie executable.",
        );
    }
    const packageRoot = resolve(root);
    const executable = resolve(packageRoot, binEntry);
    const rootPrefix = `${packageRoot}${sep}`;
    if (executable !== packageRoot && !executable.startsWith(rootPrefix)) {
        return fail(
            `installed executable escapes the package directory: ${binEntry}`,
        );
    }
    if (!(await pathExists(executable))) {
        return fail(`installed executable is missing: ${executable}.`);
    }
    return executable;
};

const installFixture = async (
    tarball: string,
    layout: TemporaryLayout,
): Promise<InstalledPackage> => {
    await writeFile(
        join(layout.install, "package.json"),
        `${JSON.stringify(
            {
                name: "ralphie-package-smoke-fixture",
                private: true,
                version: "1.0.0",
            },
            null,
            2,
        )}\n`,
    );
    runProcess(
        "npm",
        [
            "install",
            "--omit=dev",
            "--ignore-scripts",
            "--package-lock=false",
            ...npmArgs(layout.cache),
            tarball,
        ],
        layout.install,
        "production-only tarball install",
        isolatedEnvironment(layout.home),
    );

    if (await pathExists(join(layout.install, "package-lock.json"))) {
        return fail(
            "production-only install unexpectedly created a package-lock.json.",
        );
    }
    const packageName = await directDependencyName(layout);
    const root = join(layout.install, "node_modules", packageName);
    const manifestPath = join(root, "package.json");
    if (!(await pathExists(manifestPath))) {
        return fail(
            `installed package ${packageName} is missing its manifest at ${manifestPath}.`,
        );
    }
    const manifest = await readJsonRecord(
        manifestPath,
        "installed package manifest",
    );
    const executable = await installedExecutable(root, manifest);
    return { executable, manifest, root };
};

const readJsonRecord = async (
    path: string,
    label: string,
): Promise<JsonRecord> => {
    let text: string;
    try {
        text = await Bun.file(path).text();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read ${label} at ${path}: ${message}`);
    }
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${label} at ${path} is not valid JSON: ${message}`);
    }
    if (!isRecord(value)) {
        return fail(`${label} at ${path} is not a JSON object.`);
    }
    return value;
};

const repositoryUrlFrom = (repository: unknown): string | undefined => {
    if (typeof repository === "string") return repository;
    if (isRecord(repository) && typeof repository.url === "string") {
        return repository.url;
    }
    return undefined;
};

const normalizedRepository = (url: string): string =>
    url
        .replace(/^git\+/, "")
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/^git@github\.com:/, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "");

const expectedInstalledVersion = (options: SmokeOptions): string => {
    if (!options.registry) return packageJson.version;

    const packageSpec = options.packageSpec;
    const prefix = `${expectedPackageName}@`;
    if (packageSpec === undefined || !packageSpec.startsWith(prefix)) {
        return fail(
            `registry checks require an exact package spec in the form ${expectedPackageName}@<version>.`,
        );
    }
    const version = packageSpec.slice(prefix.length);
    if (version.length === 0 || version.includes("@")) {
        return fail(
            `registry checks require an exact package version in ${JSON.stringify(packageSpec)}; tags and ranges are not supported.`,
        );
    }
    return version;
};

const validateInstalledIdentity = (
    installed: InstalledPackage,
    options: SmokeOptions,
    layout: TemporaryLayout,
): void => {
    const { manifest } = installed;
    if (manifest.name !== expectedPackageName) {
        fail(
            `installed package identity is ${JSON.stringify(manifest.name)}; expected ${JSON.stringify(expectedPackageName)}. The package may have resolved to the unscoped ralphie package.`,
        );
    }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
        fail("installed package manifest has no usable version.");
    }
    const expectedVersion = expectedInstalledVersion(options);
    if (manifest.version !== packageJson.version) {
        fail(
            `installed package version ${manifest.version} differs from package.json version ${packageJson.version}.`,
        );
    }
    if (manifest.version !== expectedVersion) {
        fail(
            `installed package version ${manifest.version} differs from requested version ${expectedVersion}.`,
        );
    }

    const repositoryUrl = repositoryUrlFrom(manifest.repository);
    if (
        repositoryUrl === undefined ||
        normalizedRepository(repositoryUrl) !== expectedRepository
    ) {
        fail(
            `installed package repository metadata is ${JSON.stringify(repositoryUrl)}; expected ${expectedRepository}.`,
        );
    }

    const environment = isolatedEnvironment(layout.home);
    const result = runProcess(
        process.execPath,
        [installed.executable, "--version"],
        layout.install,
        "installed executable --version",
        environment,
    );
    const expectedOutput = `${manifest.version}\n`;
    if (result.stdout !== expectedOutput) {
        fail(
            `installed executable reported ${JSON.stringify(result.stdout)}; expected exactly ${JSON.stringify(expectedOutput)} for manifest version ${manifest.version}.`,
        );
    }
};

const isolatedEnvironment = (home: string): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) environment[key] = value;
    }
    environment.HOME = home;
    environment.XDG_CONFIG_HOME = join(home, ".config");
    environment.NPM_CONFIG_USERCONFIG = join(home, ".npmrc");
    delete environment.NODE_PATH;
    delete environment.npm_config_userconfig;
    return environment;
};

const runSmoke = async (options: SmokeOptions): Promise<void> => {
    const layout = await makeLayout();
    try {
        validateSourcePackage();
        if (!options.registry) packageBuild();
        const runtimeEntry = sourceRuntimeEntry();
        const dryRunFiles = inspectPack(options, layout);
        validateArchiveFiles(
            dryRunFiles,
            "npm pack --dry-run file list",
            runtimeEntry,
        );
        if (options.dryRun) {
            console.log(
                `Package smoke dry run passed for ${options.packageSpec ?? "the local checkout"}.`,
            );
            return;
        }

        const tarball = await packageTarball(options, layout);
        const archiveFiles = archiveFilesFrom(tarball, layout.root);
        validateArchiveFiles(archiveFiles, "created tarball", runtimeEntry);
        const installed = await installFixture(tarball, layout);
        validateInstalledIdentity(installed, options, layout);
        console.log(
            `Package smoke passed for ${options.packageSpec ?? `${expectedPackageName}@${packageJson.version}`}.`,
        );
    } finally {
        await rm(layout.root, { force: true, recursive: true }).catch(
            () => undefined,
        );
    }
};

const main = async (): Promise<void> => {
    const options = parseOptions(Bun.argv.slice(2));
    if (options.help) {
        console.log(usage);
        return;
    }
    await runSmoke(options);
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