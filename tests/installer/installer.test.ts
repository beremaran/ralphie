import { createHash } from "node:crypto";
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
const commitUrl =
    "https://api.github.com/repos/beremaran/ralphie/commits/v0.1.0";
const checksumsUrl =
    "https://github.com/beremaran/ralphie/releases/download/v0.1.0/SHA256SUMS";
const bundleUrl =
    "https://github.com/beremaran/ralphie/releases/download/v0.1.0/SHA256SUMS.sigstore.json";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";

type CurlMode = "success" | "failure";
type ManifestMode = "valid" | "wrong-platform" | "checksum-mismatch";

type InstallerOptions = {
    readonly version?: string;
    readonly os?: string;
    readonly arch?: string;
    readonly apiResponse?: string;
    readonly apiMode?: CurlMode;
    readonly commitMode?: CurlMode;
    readonly assetMode?: CurlMode;
    readonly sigstoreMode?: CurlMode;
    readonly manifestMode?: ManifestMode;
    readonly assetContents?: string;
    readonly manifestAssetContents?: string;
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
    readonly sigstoreArgs: string;
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
    https://api.github.com/repos/beremaran/ralphie/commits/*)
        [ "$RALPHIE_TEST_COMMIT_MODE" = success ] || exit 22
        printf '{"sha":"%s"}\\n' "$RALPHIE_TEST_SOURCE_SHA"
        ;;
    https://github.com/beremaran/ralphie/releases/download/*/ralphie-*)
        [ "$RALPHIE_TEST_ASSET_MODE" = success ] || exit 22
        [ -n "$output" ] || exit 2
        cp "$RALPHIE_TEST_ASSET" "$output"
        ;;
    https://github.com/beremaran/ralphie/releases/download/*/SHA256SUMS)
        [ -n "$output" ] || exit 2
        printf '%s' "$RALPHIE_TEST_MANIFEST" > "$output"
        ;;
    https://github.com/beremaran/ralphie/releases/download/*/SHA256SUMS.sigstore.json)
        [ -n "$output" ] || exit 2
        printf '%s\\n' '{"bundle":"fixture"}' > "$output"
        ;;
    *)
        exit 2
        ;;
esac
`;

const sigstoreFixture = `#!/bin/sh
set -eu
: > "$RALPHIE_TEST_SIGSTORE_ARGS"
for argument do
    printf '%s\\n' "$argument" >> "$RALPHIE_TEST_SIGSTORE_ARGS"
done
[ "$RALPHIE_TEST_SIGSTORE_MODE" = success ]
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

function makeManifest(
    options: InstallerOptions,
    assetContents: string,
): string {
    const manifestAssetContents =
        options.manifestAssetContents ?? assetContents;
    const assetDigest = createHash("sha256")
        .update(manifestAssetContents)
        .digest("hex");
    switch (options.manifestMode) {
        case "wrong-platform":
            return `${assetDigest}  ralphie-linux-arm64\n`;
        case "checksum-mismatch":
            return `${"0".repeat(64)}  ralphie-linux-x64\n`;
        default:
            return `${assetDigest}  ralphie-linux-x64\n`;
    }
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
    const sigstoreArgs = join(root, "sigstore-args");
    const asset = join(root, "asset");
    const defaultTarget = join(defaultDestination, "ralphie");
    const explicitTarget = join(destination, "ralphie");
    const version = options.version ?? "0.1.0";
    const binaryVersion = options.binaryVersion ?? "0.1.0";
    const assetContents = options.assetContents ?? executableFixture;
    const manifest = makeManifest(options, assetContents);

    await mkdir(tools, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(urls, "");
    await writeFile(sigstoreArgs, "");
    await writeExecutable(join(tools, "curl"), curlFixture);
    await writeExecutable(join(tools, "sigstore"), sigstoreFixture);
    await writeExecutable(join(tools, "uname"), unameFixture);
    await writeFile(asset, assetContents);

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
        RALPHIE_TEST_COMMIT_MODE: options.commitMode ?? "success",
        RALPHIE_TEST_SOURCE_SHA: sourceSha,
        RALPHIE_TEST_ASSET_MODE: options.assetMode ?? "success",
        RALPHIE_TEST_SIGSTORE_MODE: options.sigstoreMode ?? "success",
        RALPHIE_TEST_SIGSTORE_ARGS: sigstoreArgs,
        RALPHIE_TEST_MANIFEST: manifest,
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
        sigstoreArgs,
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

async function requestedSigstoreArgs(
    fixture: InstallerFixture,
): Promise<string[]> {
    const contents = await readFile(fixture.sigstoreArgs, "utf8");
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

async function runCodexnnedVersion(version: string): Promise<string[]> {
    return withFixture({ version }, async (fixture) => {
        const result = runInstaller(fixture);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(await requestedUrls(fixture)).toEqual([
            commitUrl,
            canonicalUrl,
            checksumsUrl,
            bundleUrl,
        ]);
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
                expect(urls).toEqual([
                    apiUrl,
                    commitUrl,
                    canonicalUrl,
                    checksumsUrl,
                    bundleUrl,
                ]);
                expect((urls[2]?.match(/v/g) ?? []).length).toBe(1);
                const verifierArgs = await requestedSigstoreArgs(fixture);
                expect(verifierArgs).toContain("verify");
                expect(verifierArgs).toContain("github");
                expect(verifierArgs).toContain("--repository");
                expect(verifierArgs).toContain("beremaran/ralphie");
                expect(verifierArgs).toContain("--name");
                expect(verifierArgs).toContain("Release");
                expect(verifierArgs).toContain("--cert-identity");
                expect(verifierArgs).toContain(
                    "https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/v0.1.0",
                );
                expect(verifierArgs).toContain("--trigger");
                expect(verifierArgs).toContain("push");
                expect(verifierArgs).toContain("--sha");
                expect(verifierArgs).toContain(sourceSha);
                expect(verifierArgs).toContain("--ref");
                expect(verifierArgs).toContain("refs/tags/v0.1.0");
            },
        );
    });

    test("normalizes pinned versions without calling the latest API", async () => {
        const urls = [
            await runCodexnnedVersion("0.1.0"),
            await runCodexnnedVersion("v0.1.0"),
        ];

        expect(urls).toEqual([
            [commitUrl, canonicalUrl, checksumsUrl, bundleUrl],
            [commitUrl, canonicalUrl, checksumsUrl, bundleUrl],
        ]);
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
                expect(await requestedUrls(fixture)).toEqual([
                    commitUrl,
                    canonicalUrl,
                ]);
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("keeps a pre-existing target when the signed manifest is tampered", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            { sigstoreMode: "failure", existingContents },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "ralphie: Sigstore verification failed",
                );
                expect(await requestedUrls(fixture)).toEqual([
                    commitUrl,
                    canonicalUrl,
                    checksumsUrl,
                    bundleUrl,
                ]);
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("rejects a wrong-platform manifest without replacing the target", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            { manifestMode: "wrong-platform", existingContents },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain(
                    "no single valid entry for ralphie-linux-x64",
                );
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("rejects a tampered asset when its signed checksum does not match", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            {
                assetContents: `${executableFixture}\ntampered`,
                manifestAssetContents: executableFixture,
                existingContents,
            },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain("ralphie: checksum mismatch");
                await expectExistingTarget(
                    fixture.explicitTarget,
                    fixture.destination,
                    existingContents,
                );
            },
        );
    });

    test("rejects a checksum mismatch without replacing the target", async () => {
        const existingContents = "old executable\n";
        await withFixture(
            { manifestMode: "checksum-mismatch", existingContents },
            async (fixture) => {
                const result = runInstaller(fixture, fixture.destination);

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toContain("ralphie: checksum mismatch");
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
                expect(await requestedUrls(fixture)).toEqual([
                    commitUrl,
                    canonicalUrl,
                    checksumsUrl,
                    bundleUrl,
                ]);
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

            expect(await requestedUrls(fixture)).toEqual([
                commitUrl,
                canonicalUrl,
                checksumsUrl,
                bundleUrl,
            ]);
            expect(await pathExists(join(fixture.home, ".local"))).toBe(false);
        });
    });
});