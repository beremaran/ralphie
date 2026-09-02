import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RalphieError } from "../../src/shared/error.ts";
import {
    AmbiguousTargetSelectorError,
    createStandaloneTargetQueryClient,
    IncompleteTargetSelectorError,
    loadStandaloneTargetQueryClient,
    MismatchedTargetSelectorError,
    UnsupportedTargetSelectorError,
    type StandaloneTargetQueryClient,
} from "../../src/targets/standalone-target-query.ts";
import {
    loadStandaloneTargets,
    STANDALONE_TARGETS_PATH,
    type StandaloneTargets,
} from "../../src/targets/standalone-targets.ts";

const ALL_FIELDS = [
    "id",
    "releaseAssetName",
    "os",
    "arch",
    "bunCompileTarget",
    "targetTriple",
    "binaryFormat",
    "runner",
    "bunVersion",
    "dockerPlatform",
];

const mutableCopy = async (): Promise<Array<Record<string, unknown>>> =>
    JSON.parse(JSON.stringify(await loadStandaloneTargets())) as Array<
        Record<string, unknown>
    >;

const clientFor = async (): Promise<StandaloneTargetQueryClient> =>
    createStandaloneTargetQueryClient(await loadStandaloneTargets());

describe("standalone target catalog", () => {
    test("lists the validated manifest in canonical order with every field", async () => {
        const manifest = await loadStandaloneTargets();
        const client = createStandaloneTargetQueryClient(manifest);

        const catalog = client.list();
        expect(catalog).toHaveLength(4);
        expect(catalog).toEqual(manifest);
        expect(catalog.map((target) => target.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        expect(Object.isFrozen(catalog)).toBe(true);
        for (const target of catalog) {
            expect(Object.isFrozen(target)).toBe(true);
            expect(Object.keys(target).sort()).toEqual([...ALL_FIELDS].sort());
        }
    });

    test("returned catalog records cannot be mutated through the client", async () => {
        const client = await clientFor();
        const first = client.list()[0]!;
        expect("releaseAssetName" in first).toBe(true);
        // Frozen records make the readonly contract hold at runtime.
        expect(() => {
            (first as Record<string, unknown>).releaseAssetName = "mutated";
        }).toThrow();
    });
});

describe("target query by stable id", () => {
    test("resolves every target id to its full manifest record", async () => {
        const manifest = await loadStandaloneTargets();
        const client = createStandaloneTargetQueryClient(manifest);

        for (const expected of manifest) {
            const result = client.query({ id: expected.id });
            expect(result).toEqual(expected);
            expect(Object.keys(result).sort()).toEqual([...ALL_FIELDS].sort());
        }
    });

    test("normalizes case and surrounding whitespace in ids", async () => {
        const client = await clientFor();
        expect(client.query({ id: "Darwin-Arm64" }).id).toBe("darwin-arm64");
        expect(client.query({ id: " DARWIN-X64 " }).id).toBe("darwin-x64");
        expect(client.query({ id: "Linux-ARM64" }).id).toBe("linux-arm64");
        expect(client.query({ id: " linux-x64 " }).id).toBe("linux-x64");
    });
});

describe("target query by os/arch pair", () => {
    test("resolves every canonical os/arch pair", async () => {
        const manifest = await loadStandaloneTargets();
        const client = createStandaloneTargetQueryClient(manifest);

        for (const expected of manifest) {
            const result = client.query({
                os: expected.os,
                arch: expected.arch,
            });
            expect(result).toEqual(expected);
        }
    });

    test("normalizes case, whitespace, and common uname aliases", async () => {
        const client = await clientFor();

        const cases: ReadonlyArray<{
            os: string;
            arch: string;
            expectedId: string;
        }> = [
            { os: "darwin", arch: "arm64", expectedId: "darwin-arm64" },
            { os: "Darwin", arch: "aarch64", expectedId: "darwin-arm64" },
            { os: " DARWIN ", arch: " ARM64 ", expectedId: "darwin-arm64" },
            { os: "macOS", arch: "arm64", expectedId: "darwin-arm64" },
            { os: "macos", arch: "aarch64", expectedId: "darwin-arm64" },
            { os: "darwin", arch: "x86_64", expectedId: "darwin-x64" },
            { os: "Darwin", arch: "AMD64", expectedId: "darwin-x64" },
            { os: "darwin", arch: " X86_64 ", expectedId: "darwin-x64" },
            { os: "macOS", arch: "x64", expectedId: "darwin-x64" },
            { os: "linux", arch: "arm64", expectedId: "linux-arm64" },
            { os: "Linux", arch: "aarch64", expectedId: "linux-arm64" },
            { os: " LINUX ", arch: "AARCH64", expectedId: "linux-arm64" },
            { os: "linux", arch: "x86_64", expectedId: "linux-x64" },
            { os: "Linux", arch: "amd64", expectedId: "linux-x64" },
            { os: " LINUX ", arch: " X64 ", expectedId: "linux-x64" },
        ];

        for (const { os, arch, expectedId } of cases) {
            expect(client.query({ os, arch }).id === expectedId).toBe(true);
        }
    });
});

describe("unsupported selectors", () => {
    test("rejects unknown ids with a typed error listing supported ids", async () => {
        const client = await clientFor();
        const run = (): unknown => client.query({ id: "windows-x64" });

        expect(run).toThrow(UnsupportedTargetSelectorError);
        expect(run).toThrow(/Unsupported target id/);
        expect(run).toThrow(/darwin-arm64, darwin-x64, linux-arm64, linux-x64/);
    });

    test("rejects non-string selector components", async () => {
        const client = await clientFor();

        for (const selector of [
            { id: 5 },
            { os: 42, arch: "arm64" },
            { os: "darwin", arch: null },
        ] as const) {
            expect(() => client.query(selector as never)).toThrow(
                UnsupportedTargetSelectorError,
            );
            expect(() => client.query(selector as never)).toThrow(
                /must be a string/,
            );
        }
    });

    test("rejects unsupported os values with a typed error", async () => {
        const client = await clientFor();
        const run = (): unknown => client.query({ os: "windows", arch: "x64" });

        expect(run).toThrow(UnsupportedTargetSelectorError);
        expect(run).toThrow(/Unsupported target os/);
        expect(run).toThrow(/darwin \(macos\), linux/);
    });

    test("rejects unsupported arch values with a typed error", async () => {
        const client = await clientFor();
        const run = (): unknown => client.query({ os: "darwin", arch: "i386" });

        expect(run).toThrow(UnsupportedTargetSelectorError);
        expect(run).toThrow(/Unsupported target arch/);
        expect(run).toThrow(/arm64 \(aarch64\), x64 \(amd64, x86_64\)/);
    });
});

describe("incomplete selectors", () => {
    test("rejects selectors without an id or a full os/arch pair", async () => {
        const client = await clientFor();

        const incomplete = [
            {},
            { os: "darwin" },
            { arch: "arm64" },
            null,
            "darwin-arm64",
            ["darwin", "arm64"],
        ] as const;

        for (const selector of incomplete) {
            expect(() => client.query(selector as never)).toThrow(
                IncompleteTargetSelectorError,
            );
        }
    });

    test("names the missing pair component", async () => {
        const client = await clientFor();
        expect(() => client.query({ os: "darwin" } as never)).toThrow(
            /missing 'arch'/,
        );
        expect(() => client.query({ arch: "arm64" } as never)).toThrow(
            /missing 'os'/,
        );
    });
});

describe("ambiguous selectors", () => {
    test("rejects an id mixed with a partial os/arch pair", async () => {
        const client = await clientFor();

        expect(() =>
            client.query({ id: "darwin-arm64", os: "darwin" }),
        ).toThrow(AmbiguousTargetSelectorError);
        expect(() =>
            client.query({ id: "darwin-arm64", arch: "arm64" }),
        ).toThrow(AmbiguousTargetSelectorError);
        expect(() =>
            client.query({ id: "darwin-arm64", os: "darwin" }),
        ).toThrow(/partial 'os'\/'arch' pair/);
    });
});

describe("mismatched selectors", () => {
    test("rejects an id and a complete pair that disagree", async () => {
        const client = await clientFor();

        expect(() =>
            client.query({ id: "darwin-x64", os: "darwin", arch: "arm64" }),
        ).toThrow(MismatchedTargetSelectorError);
        expect(() =>
            client.query({ id: "linux-arm64", os: "darwin", arch: "arm64" }),
        ).toThrow(MismatchedTargetSelectorError);
        expect(() =>
            client.query({ id: "darwin-arm64", os: "linux", arch: "x64" }),
        ).toThrow(MismatchedTargetSelectorError);
        expect(() =>
            client.query({ id: "darwin-x64", os: "darwin", arch: "arm64" }),
        ).toThrow(/components disagree/);
    });

    test("accepts an id combined with the same target's pair as a cross-check", async () => {
        const client = await clientFor();
        expect(
            client.query({ id: "darwin-arm64", os: "darwin", arch: "aarch64" })
                .id,
        ).toBe("darwin-arm64");
        expect(
            client.query({ id: "linux-x64", os: "linux", arch: "amd64" }).id,
        ).toBe("linux-x64");
    });

    test("rejects a mismatched pair when the id is unsupported", async () => {
        const client = await clientFor();
        expect(() =>
            client.query({ id: "windows-x64", os: "linux", arch: "x64" }),
        ).toThrow(UnsupportedTargetSelectorError);
    });
});

describe("typed error contract", () => {
    test("all selector errors subclass RalphieError with a typed tag", async () => {
        const client = await clientFor();

        const thrown: Array<{
            run: () => unknown;
            expected: typeof RalphieError;
        }> = [
            {
                run: () => client.query({ id: "nope" }),
                expected: UnsupportedTargetSelectorError,
            },
            {
                run: () => client.query({ os: "darwin" } as never),
                expected: IncompleteTargetSelectorError,
            },
            {
                run: () =>
                    client.query({ id: "darwin-arm64", os: "darwin" } as never),
                expected: AmbiguousTargetSelectorError,
            },
            {
                run: () =>
                    client.query({
                        id: "darwin-x64",
                        os: "darwin",
                        arch: "arm64",
                    }),
                expected: MismatchedTargetSelectorError,
            },
        ];

        for (const { run, expected } of thrown) {
            try {
                run();
                expect.unreachable("selector should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(RalphieError);
                expect(error).toBeInstanceOf(expected);
                expect((error as RalphieError)._tag).toBe(expected.name);
                expect((error as Error).message.length).toBeGreaterThan(0);
            }
        }
    });
});

describe("manifest validation before exposure", () => {
    test("rejects malformed records at client creation", async () => {
        const missingField = await mutableCopy();
        delete missingField[0]!.bunCompileTarget;
        expect(() => createStandaloneTargetQueryClient(missingField)).toThrow(
            /bunCompileTarget/,
        );

        const unknownField = await mutableCopy();
        unknownField[0]!.unexpected = true;
        expect(() => createStandaloneTargetQueryClient(unknownField)).toThrow(
            /unexpected/,
        );
    });

    test("rejects exact-target violations at client creation", async () => {
        const nonCanonicalOs = await mutableCopy();
        nonCanonicalOs[0]!.os = "linux";
        expect(() => createStandaloneTargetQueryClient(nonCanonicalOs)).toThrow(
            /Canonical os/,
        );

        const nonCanonicalArch = await mutableCopy();
        nonCanonicalArch[1]!.arch = "arm64";
        expect(() =>
            createStandaloneTargetQueryClient(nonCanonicalArch),
        ).toThrow(/Canonical arch/);

        const wrongDocker = await mutableCopy();
        wrongDocker[2]!.dockerPlatform = "linux/amd64";
        expect(() => createStandaloneTargetQueryClient(wrongDocker)).toThrow(
            /Docker platform/,
        );
    });

    test("rejects duplicate ids, lost targets, and reordered manifests", async () => {
        const duplicate = await mutableCopy();
        duplicate[1]!.id = duplicate[0]!.id;
        expect(() => createStandaloneTargetQueryClient(duplicate)).toThrow(
            /unique/,
        );

        const missing = await mutableCopy();
        missing.pop();
        expect(() => createStandaloneTargetQueryClient(missing)).toThrow(
            /must be exactly/,
        );

        const reordered = await mutableCopy();
        reordered.reverse();
        expect(() => createStandaloneTargetQueryClient(reordered)).toThrow(
            /must be exactly/,
        );
    });

    test("validation failures surface before any list or query", async () => {
        const malformed = await mutableCopy();
        malformed[0]!.runner = "ubuntu-24.04";

        expect(() => createStandaloneTargetQueryClient(malformed)).toThrow(
            /Canonical runner/,
        );
    });
});

describe("injected manifest path", () => {
    test("loads and queries a manifest from an explicit path", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ralphie-targets-query-"));
        try {
            const manifest = await loadStandaloneTargets();
            const path = join(dir, "standalone-targets.json");
            await writeFile(path, JSON.stringify(manifest), "utf8");

            const client = await loadStandaloneTargetQueryClient(path);
            expect(client.list()).toEqual(manifest);
            expect(client.query({ id: "linux-arm64" }).releaseAssetName).toBe(
                "ralphie-linux-arm64",
            );
            expect(client.query({ os: "macOS", arch: "AMD64" }).id).toBe(
                "darwin-x64",
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("rejects a malformed manifest file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ralphie-targets-query-"));
        try {
            const path = join(dir, "standalone-targets.json");
            await writeFile(
                path,
                JSON.stringify([{ id: "darwin-arm64" }]),
                "utf8",
            );
            await expect(loadStandaloneTargetQueryClient(path)).rejects.toThrow(
                /releaseAssetName/,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("rejects a missing manifest file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ralphie-targets-query-"));
        try {
            await expect(
                loadStandaloneTargetQueryClient(
                    join(dir, "does-not-exist.json"),
                ),
            ).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("loads the canonical manifest by default", async () => {
        expect(STANDALONE_TARGETS_PATH).toEndWith(
            "targets/standalone-targets.json",
        );
        const client = await loadStandaloneTargetQueryClient();
        expect(client.list()).toEqual(await loadStandaloneTargets());
        expect(client.query({ id: "darwin-arm64" }).bunVersion).toBe("1.3.14");
    });
});