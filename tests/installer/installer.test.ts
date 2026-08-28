import { describe, expect, test } from "bun:test";
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dir, "../..");
const apiUrl = "https://api.github.com/repos/beremaran/ralphie/releases/latest";
const canonicalUrl =
    "https://github.com/beremaran/ralphie/releases/download/v0.1.0/ralphie-linux-x64";

type CurlMode = "success" | "failure";

type InstallerOptions = {
    readonly version?: string;
    readonly os?: string;
    readonly arch?: string;
    readonly apiResponse?: string;
    readonly apiMode?: CurlMode;
    readonly assetMode?: CurlMode;
    readonly binaryVersion?: string;
    readonly existingContents?: string;
};

type InstallerFixture = {
    readonly root: string;
    readonly home: string;
    readonly destination: string;
    readonly defaultDestination: string;
    readonly defaultTarget: string;
    readonly explicitTarget: string;
    readonly urls: string;
    readonly environment: Record<string, string>;
};

type CommandResult = {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
};

const curlFixture = `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -H)
            shift 2
            ;;
        -o)
            output=$2
            shift 2
            ;;
        --retry)
            shift 2
            ;;
        -*)
            shift
            ;;
        *)
            url=$1
            shift
            ;;
    esac
done
printf '%s\\n' "$url" >> "$RALPHIE_TEST_URLS"
case "$url" in
    https://api.github.com/repos/beremaran/ralphie/releases/latest)
        [ "$RALPHIE_TEST_API_MODE" = success ] || exit 22
        printf '%s\\n' "$RALPHIE_TEST_API_RESPONSE"
        ;;
    https://github.com/beremaran/ralphie/releases/download/*)
        [ "$RALPHIE_TEST_ASSET_MODE" = success ] || exit 22
        [ -n "$output" ] || exit 2
        cp "$RALPHIE_TEST_ASSET" "$output"
        ;;
    *)
        exit 2
        ;;
esac
`;

const unameFixture = `#!/bin/sh
case "$1" in
    -s) printf '%s\\n' "$RALPHIE_TEST_OS" ;;
    -m) printf '%s\\n' "$RALPHIE_TEST_ARCH" ;;
    *) exit 2 ;;
esac
`;

const executableFixture = `#!/bin/sh
if [ "\${1-}" != "--version" ]; then
    exit 2
fi
printf '%s\\n' "$RALPHIE_TEST_BINARY_VERSION"
`;

async function writeExecutable(path: string, contents: string): Promise<void> {
    await writeFile(path, contents);
    await chmod(path, 0o755);
}

async function makeFixture(
    options: InstallerOptions = {},
): Promise<InstallerFixture> {
    const root = await mkdtemp(join(tmpdir(), "ralphie-installer-test-"));
    const tools = join(root, "tools");
    const home = join(root, "home");
    const destination = join(root, "destination");
    const defaultDestination = join(home, ".local", "bin");
    const urls = join(root, "urls");
    const asset = join(root, "asset");
    const defaultTarget = join(defaultDestination, "ralphie");
    const explicitTarget = join(destination, "ralphie");
    const version = options.version ?? "0.1.0";
    const binaryVersion = options.binaryVersion ?? "0.1.0";

    await mkdir(tools, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(urls, "");
    await writeExecutable(join(tools, "curl"), curlFixture);
    await writeExecutable(join(tools, "uname"), unameFixture);
    await writeExecutable(asset, executableFixture);

    if (options.existingContents !== undefined) {
        await mkdir(destination, { recursive: true });
        await writeFile(explicitTarget, options.existingContents);
    }

    const environment: Record<string, string> = {
        HOME: home,
        PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        RALPHIE_VERSION: version,
        RALPHIE_TEST_API_MODE: options.apiMode ?? "success",
        RALPHIE_TEST_API_RESPONSE:
            options.apiResponse ?? '{"tag_name":"v0.1.0"}',
        RALPHIE_TEST_ASSET_MODE: options.assetMode ?? "success",
        RALPHIE_TEST_ASSET: asset,
        RALPHIE_TEST_BINARY_VERSION: binaryVersion,
        RALPHIE_TEST_OS: options.os ?? "Linux",
        RALPHIE_TEST_ARCH: options.arch ?? "x86_64",
        RALPHIE_TEST_URLS: urls,
    };

    return {
        root,
        home,
        destination,
        defaultDestination,
        defaultTarget,
        explicitTarget,
        urls,
        environment,
    };
}

async function withFixture<T>(
    options: InstallerOptions,
    callback: (fixture: InstallerFixture) => Promise<T>,
): Promise<T> {
    const fixture = await makeFixture(options);
    try {
        return await callback(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
}

function runInstaller(
    fixture: InstallerFixture,
    destination?: string,
): CommandResult {
    const args = ["sh", "scripts/install.sh"];
    if (destination !== undefined) args.push(destination);

    const result = Bun.spawnSync(args, {
        cwd: repositoryRoot,
        env: fixture.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

function runInstalledBinary(
    fixture: InstallerFixture,
    target: string,
): CommandResult {
    const result = Bun.spawnSync([target, "--version"], {
        env: fixture.environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

async function requestedUrls(fixture: InstallerFixture): Promise<string[]> {
    const contents = await readFile(fixture.urls, "utf8");
    return contents.length === 0 ? [] : contents.trimEnd().split("\n");
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function expectNoTarget(
    target: string,
    destination: string,
): Promise<void> {
    expect(await pathExists(target)).toBe(false);
    expect(await readdir(destination)).toEqual([]);
}

async function expectExistingTarget(
    target: string,
    destination: string,
    contents: string,
): Promise<void> {
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(await readdir(destination)).toEqual(["ralphie"]);
}

async function expectSuccessfulInstallation(
    fixture: InstallerFixture,
    target: string,
    result: CommandResult,
): Promise<void> {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ralphie: installed to ${target}`);
    expect(result.stdout).toContain("ralphie: verify with");
    expect(await pathExists(target)).toBe(true);
    expect((await stat(target)).mode & 0o111).not.toBe(0);

    const binary = runInstalledBinary(fixture, target);
    expect(binary).toEqual({ exitCode: 0, stdout: "0.1.0\n", stderr: "" });
}

async function runPinnedVersion(version: string): Promise<string[]> {
    return withFixture({ version }, async (fixture) => {
        const result = runInstaller(fixture);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(await requestedUrls(fixture)).toEqual([canonicalUrl]);
        expect(await pathExists(fixture.defaultTarget)).toBe(true);
        return requestedUrls(fixture);
    });
}

describe("standalone installer", () => {
    test("resolves latest v0.1.0 and downloads the canonical asset", async () => {
        await withFixture(
            {
                version: "latest",
                apiResponse: '{"tag_name":"v0.1.0"}',
            },
            async (fixture) => {
                const result = runInstaller(fixture);
                await expectSuccessfulInstallation(
                    fixture,
                    fixture.defaultTarget,
                    result,
                );

                const urls = await requestedUrls(fixture);
                expect(urls).toEqual([apiUrl, canonicalUrl]);
                expect((urls[1]?.match(/v/g) ?? []).length).toBe(1);
            },
        );
    });

    test("normalizes pinned versions without calling the latest API", async () => {
        const urls = [
            await runPinnedVersion("0.1.0"),
            await runPinnedVersion("v0.1.0"),
        ];

        expect(urls).toEqual([[canonicalUrl], [canonicalUrl]]);
    });

    test("rejects an unsupported operating system before asset installation", async () => {
        await withFixture({ os: "Plan9" }, async (fixture) => {
            const result = runInstaller(fixture);

            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(
                "ralphie: unsupported operating system 'Plan9'",
            );
            expect(await requestedUrls(fixture)).toEqual([]);
            await expectNoTarget(
                fixture.defaultTarget,
                fixture.defaultDestination,
            );
        });
    });

    test("rejects an unsupported architecture before asset installation", async () => {
        await withFixture({ arch: "riscv64" }, async (fixture) => {
            const result = runInstaller(fixture);

            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(
                "ralphie: unsupported architecture 'riscv64'",
            );
            expect(await requestedUrls(fixture)).toEqual([]);
            await expectNoTarget(
                fixture.defaultTarget,
                fixture.defaultDestination,
            );
        });
    });

    test("fails without a target when the latest API cannot be reached", async () => {
        await withFixture(
            { version: "latest", apiMode: "failure" },
            async (fixture) => {
                const result = runInstaller(fixture);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "ralphie: could not resolve latest release",
                );
                expect(await requestedUrls(fixture)).toEqual([apiUrl]);
                await expectNoTarget(
                    fixture.defaultTarget,
                    fixture.defaultDestination,
                );
            },
        );
    });

    test("fails without a target for malformed latest API output", async () => {
        await withFixture(
            { version: "latest", apiResponse: "not-json" },
            async (fixture) => {
                const result = runInstaller(fixture);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "ralphie: latest release returned invalid tag",
                );
                expect(await requestedUrls(fixture)).toEqual([apiUrl]);
                await expectNoTarget(
                    fixture.defaultTarget,
                    fixture.defaultDestination,
                );
            },
        );
    });

    test("fails without a target when the latest API has no tag", async () => {
        await withFixture(
            { version: "latest", apiResponse: '{"name":"ralphie"}' },
            async (fixture) => {
                const result = runInstaller(fixture);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "ralphie: latest release returned invalid tag",
                );
                expect(await requestedUrls(fixture)).toEqual([apiUrl]);
                await expectNoTarget(
                    fixture.defaultTarget,
                    fixture.defaultDestination,
                );
            },
        );
    });

    test("keeps a pre-existing target after an asset download failure", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            { assetMode: "failure", existingContents },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain("ralphie: download failed");
                expect(await requestedUrls(fixture)).toEqual([canonicalUrl]);
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("keeps a pre-existing target when the downloaded version is wrong", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            { binaryVersion: "9.9.9", existingContents },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "reports version '9.9.9', expected '0.1.0'",
                );
                expect(await requestedUrls(fixture)).toEqual([canonicalUrl]);
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("installs to an explicit destination with an executable, verified target", async () => {
        await withFixture({ version: "v0.1.0" }, async (fixture) => {
            const result = runInstaller(fixture, fixture.destination);
            await expectSuccessfulInstallation(
                fixture,
                fixture.explicitTarget,
                result,
            );

            expect(await requestedUrls(fixture)).toEqual([canonicalUrl]);
            expect(await pathExists(join(fixture.home, ".local"))).toBe(false);
        });
    });
});