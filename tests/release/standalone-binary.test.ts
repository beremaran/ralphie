import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import packageJson from "../../package.json";

/**
 * Standalone binary smoke test.
 *
 * The native `dist/cli` produced by `bun run build` embeds the Bun runtime,
 * so a release binary must launch when no Bun executable is reachable through
 * `PATH`. This test compiles a FRESH native executable from `index.ts` with
 * release-like fixture version and commit-SHA metadata (never an old
 * `dist/cli`), launches it from a disposable working directory with a PATH
 * that contains no Bun and no checkout `node_modules`, and asserts the exact
 * plain and JSON version output.
 *
 * It also documents and verifies the other side of the contract: compiling
 * (`scripts/build.ts`) and source-running (`bun run index.ts`) still require
 * Bun on `PATH`. The compiled binary is standalone only in the narrow sense
 * proven here: the no-Bun invocation succeeds.
 */

const FIXTURE_VERSION = "7.7.7";
const FIXTURE_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

const repositoryRoot = join(import.meta.dir, "..", "..");

type SpawnOutcome = {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
};

let sandbox: string | undefined;
let binaryPath: string;
let runDir: string;
let noBunEnvironment: Record<string, string>;

const ambientEnvironment = (): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) environment[key] = value;
    }
    return environment;
};

const spawnWith = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env: Record<string, string>,
): SpawnOutcome => {
    const result = Bun.spawnSync([command, ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
};

const mustSucceed = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env: Record<string, string>,
    label: string,
): SpawnOutcome => {
    const outcome = spawnWith(command, args, cwd, env);
    if (outcome.exitCode !== 0) {
        throw new Error(
            `${label} failed with exit code ${outcome.exitCode}.\n` +
                `command: ${command} ${args.join(" ")}\n` +
                `cwd: ${cwd}\n` +
                `stdout:\n${outcome.stdout}\n` +
                `stderr:\n${outcome.stderr}`,
        );
    }
    return outcome;
};

const environmentWithoutBun = (binDir: string): Record<string, string> => {
    const environment = ambientEnvironment();
    // The sole PATH entry is an intentionally empty directory. It structurally
    // contains no Bun executable and cannot point at the checkout's
    // node_modules, so a successful launch proves the binary does not rely on
    // either at runtime.
    environment.PATH = binDir;
    delete environment.NODE_PATH;
    return environment;
};

beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "ralphie-standalone-smoke-"));
    const relation = relative(repositoryRoot, sandbox);
    if (!(relation === ".." || relation.startsWith(`..${sep}`))) {
        await rm(sandbox, { force: true, recursive: true });
        throw new Error(
            `standalone smoke sandbox is inside the checkout: ${sandbox}`,
        );
    }
    runDir = join(sandbox, "run");
    const binDir = join(sandbox, "bin");
    await mkdir(runDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Mirror the native branch of scripts/build.ts, but emit the fresh fixture
    // binary into the disposable sandbox instead of the checkout's dist/cli.
    binaryPath = join(sandbox, "ralphie");
    const build = await Bun.build({
        entrypoints: [join(repositoryRoot, "index.ts")],
        define: {
            RALPHIE_BUILD_INFO: JSON.stringify({
                version: FIXTURE_VERSION,
                commitSha: FIXTURE_COMMIT_SHA,
            }),
        },
        compile: { outfile: binaryPath },
    });
    if (!build.success) {
        throw new Error(
            "standalone fixture build failed:\n" +
                build.logs.map((log) => String(log)).join("\n"),
        );
    }
    if (((await stat(binaryPath)).mode & 0o111) === 0) {
        throw new Error(`standalone fixture is not executable: ${binaryPath}`);
    }
    noBunEnvironment = environmentWithoutBun(binDir);
});

afterAll(async () => {
    if (sandbox !== undefined) {
        await rm(sandbox, { force: true, recursive: true });
    }
});

describe("standalone native binary smoke", () => {
    test("launches without Bun on PATH and prints the injected version", () => {
        // cwd is the disposable run directory, and PATH contains only an empty
        // directory: a successful launch proves the compiled binary does not
        // need a Bun executable or the checkout's node_modules.
        const plain = mustSucceed(
            binaryPath,
            ["--version"],
            runDir,
            noBunEnvironment,
            "fixture binary --version",
        );
        expect(plain.stdout).toBe(`${FIXTURE_VERSION}\n`);
        expect(plain.stderr).toBe("");
    });

    test("prints stable JSON metadata carrying the injected version and commit SHA", () => {
        const expected = `${JSON.stringify({
            version: FIXTURE_VERSION,
            commitSha: FIXTURE_COMMIT_SHA,
        })}\n`;
        const json = mustSucceed(
            binaryPath,
            ["--version", "--output", "json"],
            runDir,
            noBunEnvironment,
            "fixture binary --version --output json",
        );
        expect(json.stdout).toBe(expected);
        expect(json.stderr).toBe("");
        expect(JSON.parse(json.stdout)).toEqual({
            version: FIXTURE_VERSION,
            commitSha: FIXTURE_COMMIT_SHA,
        });
    });

    test("documents that compiling and source-running still require Bun", () => {
        // Under the same no-Bun PATH that launches the compiled fixture, Bun
        // itself cannot be found, so `bun run index.ts` (source execution) and
        // `bun run scripts/build.ts` (compilation) both fail before starting.
        const sourceRun = spawnWith(
            "/bin/sh",
            ["-c", "bun run index.ts --version"],
            runDir,
            noBunEnvironment,
        );
        expect(sourceRun.exitCode).not.toBe(0);
        expect(sourceRun.stdout).toBe("");
        expect(sourceRun.stderr.length).toBeGreaterThan(0);

        const compile = spawnWith(
            "/bin/sh",
            ["-c", "bun run scripts/build.ts"],
            runDir,
            noBunEnvironment,
        );
        expect(compile.exitCode).not.toBe(0);
        expect(compile.stdout).toBe("");
        expect(compile.stderr.length).toBeGreaterThan(0);

        // With Bun available the same source entry point runs and reports the
        // checkout version (the local `local` commit sentinel path): source
        // execution is real, but it is not standalone.
        const sourceRunWithBun = mustSucceed(
            process.execPath,
            ["run", "index.ts", "--version"],
            repositoryRoot,
            ambientEnvironment(),
            "bun run index.ts --version",
        );
        expect(sourceRunWithBun.stdout).toBe(`${packageJson.version}\n`);
    });
});