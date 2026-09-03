import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    checkStandaloneTargetsFile,
    generateStandaloneTargetsDocument,
    parseStandaloneTargetsArgs,
    renderStandaloneTargetQueryDocument,
    renderStandaloneTargetsDocument,
    StandaloneTargetsCommandError,
} from "../../scripts/standalone-targets.ts";
import {
    UnsupportedTargetSelectorError,
    type StandaloneTargetSelector,
} from "../../src/targets/standalone-target-query.ts";
import { serializeStandaloneTargets } from "../../src/targets/standalone-target-serializer.ts";
import { loadStandaloneTargets } from "../../src/targets/standalone-targets.ts";
import type { StandaloneTargetsDocumentRequest } from "../../scripts/standalone-targets.ts";

const canonicalCatalog = await loadStandaloneTargets();

/** Lexicographically sorted key set of a complete canonical target record. */
const EXPECTED_RECORD_KEYS = [
    "arch",
    "binaryFormat",
    "bunCompileTarget",
    "bunVersion",
    "dockerPlatform",
    "id",
    "os",
    "releaseAssetName",
    "runner",
    "targetTriple",
];

const canonicalRecord = (id: string) => {
    const record = canonicalCatalog.find((target) => target.id === id);
    expect(record).toBeDefined();
    return record as (typeof canonicalCatalog)[number];
};

let fixtureDirectory: string;

beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "ralphie-targets-"));
});

afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
});

const fixturePath = (name: string): string => join(fixtureDirectory, name);

const writeFixture = async (name: string, content: string): Promise<string> => {
    const path = fixturePath(name);
    await writeFile(path, content, "utf8");
    return path;
};

/** A manifest that fails exact-target validation (unknown strict field). */
const malformedCatalog: unknown = canonicalCatalog.map((record) => ({
    ...record,
    extraField: "x",
}));

const readJson = (text: string): unknown => JSON.parse(text) as unknown;

describe("parseStandaloneTargetsArgs", () => {
    test("empty args and help flags resolve to the help mode", () => {
        expect(parseStandaloneTargetsArgs([])).toEqual({ mode: "help" });
        expect(parseStandaloneTargetsArgs(["--help"])).toEqual({
            mode: "help",
        });
        expect(parseStandaloneTargetsArgs(["-h"])).toEqual({ mode: "help" });
        expect(parseStandaloneTargetsArgs(["query", "--help"])).toEqual({
            mode: "help",
        });
    });

    test("query resolves by stable id", () => {
        expect(
            parseStandaloneTargetsArgs(["query", "--id", "darwin-arm64"]),
        ).toEqual({
            mode: "query",
            request: {
                selector: { id: "darwin-arm64" },
                manifestPath: undefined,
            },
        });
    });

    test("query resolves by os/arch pair and honors the manifest override", () => {
        expect(
            parseStandaloneTargetsArgs([
                "query",
                "--os",
                "linux",
                "--arch",
                "arm64",
                "--manifest",
                "fixture.json",
            ]),
        ).toEqual({
            mode: "query",
            request: {
                selector: { os: "linux", arch: "arm64" },
                manifestPath: "fixture.json",
            },
        });
    });

    test("query rejects mixed, partial, and unknown selectors", () => {
        expect(() =>
            parseStandaloneTargetsArgs(["query", "--id", "x", "--os", "linux"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs(["query", "--os", "linux"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs(["query", "--arch", "arm64"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs(["query", "--bogus", "x"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() => parseStandaloneTargetsArgs(["query", "--id"])).toThrow(
            StandaloneTargetsCommandError,
        );
        expect(() =>
            parseStandaloneTargetsArgs(["query", "--id", "x", "stray"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs(["frobnicate", "--id", "x"]),
        ).toThrow(StandaloneTargetsCommandError);
    });

    test("generate parses every format with its required flags", () => {
        expect(
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--output",
                "catalog.json",
            ]),
        ).toEqual({
            mode: "generate",
            request: {
                format: "json",
                version: undefined,
                selector: undefined,
                manifestPath: undefined,
                outputPath: "catalog.json",
            },
        });

        expect(
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "homebrew",
                "--version",
                "0.1.2",
                "--output",
                "homebrew.json",
            ]),
        ).toEqual({
            mode: "generate",
            request: {
                format: "homebrew",
                version: "0.1.2",
                selector: undefined,
                manifestPath: undefined,
                outputPath: "homebrew.json",
            },
        });

        expect(
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "posix",
                "--os",
                "darwin",
                "--arch",
                "arm64",
                "--output",
                "posix.json",
            ]),
        ).toEqual({
            mode: "generate",
            request: {
                format: "posix",
                version: undefined,
                selector: { os: "darwin", arch: "arm64" },
                manifestPath: undefined,
                outputPath: "posix.json",
            },
        });
    });

    test("generate rejects unknown formats, flags, and combinations", () => {
        expect(() =>
            parseStandaloneTargetsArgs(["generate", "--output", "x.json"]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--output",
                "x.json",
                "--bogus",
                "y",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "tar",
                "--output",
                "x",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--id",
                "darwin-arm64",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--os",
                "darwin",
                "--arch",
                "arm64",
                "--output",
                "x.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--version",
                "0.1.2",
                "--output",
                "x.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "posix",
                "--os",
                "darwin",
                "--output",
                "x.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "posix",
                "--os",
                "darwin",
                "--arch",
                "arm64",
                "--version",
                "0.1.2",
                "--output",
                "x.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
        expect(() =>
            parseStandaloneTargetsArgs([
                "generate",
                "--format",
                "json",
                "--output",
                "x.json",
                "--file",
                "y.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
    });

    test("check parses like generate but with a checked file", () => {
        expect(
            parseStandaloneTargetsArgs([
                "check",
                "--format",
                "github-matrix",
                "--file",
                "matrix.json",
            ]),
        ).toEqual({
            mode: "check",
            request: {
                format: "github-matrix",
                version: undefined,
                selector: undefined,
                manifestPath: undefined,
                filePath: "matrix.json",
            },
        });
        expect(() =>
            parseStandaloneTargetsArgs([
                "check",
                "--format",
                "json",
                "--output",
                "x.json",
            ]),
        ).toThrow(StandaloneTargetsCommandError);
    });
});

describe("renderStandaloneTargetsDocument", () => {
    test("json emits the complete catalog sorted by id with sorted keys", async () => {
        const document = await renderStandaloneTargetsDocument({
            format: "json",
        });
        const records = readJson(document) as Array<Record<string, unknown>>;
        expect(records).toHaveLength(4);
        expect(records.map((record) => record.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        for (const record of records)
            expect(Object.keys(record)).toEqual(EXPECTED_RECORD_KEYS);
        expect(document.endsWith("]\n")).toBe(true);
        expect(document).not.toContain("\r");
        expect(await renderStandaloneTargetsDocument({ format: "json" })).toBe(
            document,
        );
    });

    test("github-matrix wraps the same records in an include array", async () => {
        const document = await renderStandaloneTargetsDocument({
            format: "github-matrix",
        });
        const matrix = readJson(document) as {
            readonly include: Array<Record<string, unknown>>;
        };
        expect(Object.keys(matrix)).toEqual(["include"]);
        expect(matrix.include).toHaveLength(4);
        expect(matrix.include.map((record) => record.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        expect(document.endsWith("}\n")).toBe(true);
    });

    test("documentation equals the json catalog bytes", async () => {
        const documentation = await renderStandaloneTargetsDocument({
            format: "documentation",
        });
        const json = await renderStandaloneTargetsDocument({ format: "json" });
        expect(documentation).toBe(json);
    });

    test("posix emits the single selected record with normalized aliases", async () => {
        const document = await renderStandaloneTargetsDocument({
            format: "posix",
            selector: { os: "Darwin", arch: "x86_64" },
        });
        const record = readJson(document) as Record<string, unknown>;
        expect(record).toEqual(canonicalRecord("darwin-x64"));
        expect(Object.keys(record)).toEqual(EXPECTED_RECORD_KEYS);
        expect(document.endsWith("}\n")).toBe(true);

        expect(
            readJson(
                await renderStandaloneTargetsDocument({
                    format: "posix",
                    selector: { os: "  linux ", arch: "ARM64" },
                }),
            ),
        ).toEqual(canonicalRecord("linux-arm64"));
    });

    test("homebrew emits rows sorted by id with versioned download URLs", async () => {
        const document = await renderStandaloneTargetsDocument({
            format: "homebrew",
            version: "0.1.2",
        });
        const rows = readJson(document) as Array<{
            readonly target: {
                readonly id: string;
                readonly releaseAssetName: string;
            };
            readonly version: string;
            readonly downloadUrl: string;
        }>;
        expect(rows.map((row) => row.target.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        for (const row of rows) {
            expect(row.version).toBe("0.1.2");
            expect(row.downloadUrl).toBe(
                `https://github.com/beremaran/ralphie/releases/download/v0.1.2/${row.target.releaseAssetName}`,
            );
        }
        expect(document.endsWith("]\n")).toBe(true);
    });

    test("rejects request shapes a format cannot consume", async () => {
        const cases: ReadonlyArray<StandaloneTargetsDocumentRequest> = [
            { format: "homebrew" },
            { format: "homebrew", version: "0.1.2", selector: { id: "x" } },
            { format: "json", version: "0.1.2" },
            { format: "json", selector: { os: "darwin", arch: "arm64" } },
            { format: "json", selector: { id: "darwin-arm64" } },
            { format: "posix" },
            { format: "posix", selector: { id: "darwin-arm64" } },
            {
                format: "posix",
                selector: {
                    os: "darwin",
                } as unknown as StandaloneTargetSelector,
            },
            {
                format: "posix",
                version: "0.1.2",
                selector: { os: "darwin", arch: "arm64" },
            },
            { format: "documentation", version: "0.1.2" },
            { format: "documentation", selector: { id: "darwin-arm64" } },
            { format: "github-matrix", selector: { id: "darwin-arm64" } },
        ];

        for (const request of cases) {
            await expect(
                renderStandaloneTargetsDocument(request),
            ).rejects.toThrow(StandaloneTargetsCommandError);
        }

        await expect(
            renderStandaloneTargetsDocument({
                format: "homebrew",
                version: "latest",
            }),
        ).rejects.toThrow();
    });

    test("resolves selectors through the query API with typed errors", async () => {
        await expect(
            renderStandaloneTargetsDocument({
                format: "posix",
                selector: { os: "darwin", arch: "riscv64" },
            }),
        ).rejects.toThrow(UnsupportedTargetSelectorError);
        await expect(
            renderStandaloneTargetsDocument({
                format: "posix",
                selector: { os: "windows", arch: "arm64" },
            }),
        ).rejects.toThrow(UnsupportedTargetSelectorError);
    });

    test("validates the whole manifest before rendering anything", async () => {
        const fixturePath = await writeFixture(
            "malformed.json",
            JSON.stringify(malformedCatalog, null, 2),
        );
        await expect(
            renderStandaloneTargetsDocument({
                format: "json",
                manifestPath: fixturePath,
            }),
        ).rejects.toThrow();
        await expect(
            renderStandaloneTargetsDocument({
                format: "posix",
                selector: { os: "darwin", arch: "arm64" },
                manifestPath: fixturePath,
            }),
        ).rejects.toThrow();
        await expect(
            renderStandaloneTargetsDocument({
                format: "json",
                manifestPath: join(fixtureDirectory, "missing.json"),
            }),
        ).rejects.toThrow();
    });

    test("the manifest override defaults to the canonical manifest", async () => {
        const fixturePath = await writeFixture(
            "canonical-copy.json",
            serializeStandaloneTargets(canonicalCatalog),
        );
        await expect(
            renderStandaloneTargetsDocument({ format: "json" }),
        ).resolves.toBe(
            await renderStandaloneTargetsDocument({
                format: "json",
                manifestPath: fixturePath,
            }),
        );
    });
});

describe("renderStandaloneTargetQueryDocument", () => {
    test("prints one complete record for id and os/arch selectors", async () => {
        expect(
            readJson(
                await renderStandaloneTargetQueryDocument({
                    selector: { id: "linux-x64" },
                }),
            ),
        ).toEqual(canonicalRecord("linux-x64"));
        expect(
            readJson(
                await renderStandaloneTargetQueryDocument({
                    selector: { os: "macOS", arch: "aarch64" },
                }),
            ),
        ).toEqual(canonicalRecord("darwin-arm64"));

        const document = await renderStandaloneTargetQueryDocument({
            selector: { id: "darwin-arm64" },
        });
        expect(document.endsWith("}\n")).toBe(true);
        expect(document).not.toContain("\r");
    });

    test("rejects unsupported selectors before printing anything", async () => {
        await expect(
            renderStandaloneTargetQueryDocument({
                selector: { id: "windows-x64" },
            }),
        ).rejects.toThrow(UnsupportedTargetSelectorError);
        await expect(
            renderStandaloneTargetQueryDocument({
                selector: {
                    os: "linux",
                } as unknown as StandaloneTargetSelector,
            }),
        ).rejects.toThrow();
    });
});

describe("generateStandaloneTargetsDocument", () => {
    test("writes the exact rendered bytes and leaves no temporary files", async () => {
        const directory = fixturePath("isolated-write");
        await mkdir(directory, { recursive: true });
        const outputPath = join(directory, "catalog.json");
        const document = await generateStandaloneTargetsDocument({
            format: "json",
            outputPath,
        });
        expect(document).toBe(
            await renderStandaloneTargetsDocument({ format: "json" }),
        );
        expect(await readFile(outputPath, "utf8")).toBe(document);
        expect(await readdir(directory)).toEqual(["catalog.json"]);
    });

    test("renders entirely before touching the destination", async () => {
        const outputPath = fixturePath("homebrew.json");
        const document = await generateStandaloneTargetsDocument({
            format: "homebrew",
            version: "0.1.2",
            outputPath,
        });
        expect(readJson(document) as ReadonlyArray<unknown>).toHaveLength(4);
        expect(await readFile(outputPath, "utf8")).toBe(document);
    });

    test("preserves an existing destination when validation fails", async () => {
        const outputPath = fixturePath("existing.json");
        await writeFile(outputPath, "sentinel\n", "utf8");
        await expect(
            generateStandaloneTargetsDocument({
                format: "json",
                manifestPath: await writeFixture(
                    "malformed-b.json",
                    JSON.stringify(malformedCatalog, null, 2),
                ),
                outputPath,
            }),
        ).rejects.toThrow();
        expect(await readFile(outputPath, "utf8")).toBe("sentinel\n");

        await expect(
            generateStandaloneTargetsDocument({
                format: "homebrew",
                outputPath,
            }),
        ).rejects.toThrow();
        expect(await readFile(outputPath, "utf8")).toBe("sentinel\n");
    });

    test("leaves no output or temporary file after a failed generation", async () => {
        const outputPath = fixturePath("never-written.json");
        await expect(
            generateStandaloneTargetsDocument({
                format: "posix",
                selector: { os: "darwin", arch: "arm64" },
                manifestPath: await writeFixture(
                    "malformed-c.json",
                    JSON.stringify(malformedCatalog, null, 2),
                ),
                outputPath,
            }),
        ).rejects.toThrow();
        await expect(readFile(outputPath, "utf8")).rejects.toThrow();
        const leftover = await readdir(fixtureDirectory);
        expect(leftover.filter((name) => name.includes(".tmp"))).toEqual([]);
    });
});

describe("checkStandaloneTargetsFile", () => {
    test("matches exactly and never rewrites the checked file", async () => {
        const outputPath = fixturePath("matched.json");
        const document = await renderStandaloneTargetsDocument({
            format: "json",
        });
        await writeFile(outputPath, document, "utf8");

        expect(
            await checkStandaloneTargetsFile({
                format: "json",
                filePath: outputPath,
            }),
        ).toEqual({ status: "match" });
        expect(await readFile(outputPath, "utf8")).toBe(document);
    });

    test("rejects byte-level deviations from the deterministic contract", async () => {
        const document = await renderStandaloneTargetsDocument({
            format: "posix",
            selector: { os: "darwin", arch: "arm64" },
        });
        const record = readJson(document) as Record<string, unknown>;
        const reversedKeys = Object.keys(record).reverse();
        const unsortedKeys = `{\n${reversedKeys
            .map((key) => `  "${key}": ${JSON.stringify(record[key])}`)
            .join(",\n")}\n}\n`;

        const deviations: Array<[string, string]> = [
            ["missing final newline", document.slice(0, -1)],
            ["extra trailing newline", `${document}\n`],
            ["CRLF line endings", document.replaceAll("\n", "\r\n")],
            ["unsorted object keys", unsortedKeys],
            ["minified JSON", JSON.stringify(record)],
        ];

        for (const [label, content] of deviations) {
            const path = fixturePath(
                `deviation-${label.replaceAll(" ", "-")}.json`,
            );
            await writeFile(path, content, "utf8");
            const outcome = await checkStandaloneTargetsFile({
                format: "posix",
                selector: { os: "darwin", arch: "arm64" },
                filePath: path,
            });
            expect(outcome.status).toBe("mismatch");
            if (outcome.status === "mismatch") {
                expect(outcome.reason.length).toBeGreaterThan(0);
                expect(outcome.reason).toMatch(/byte|length|offset/i);
            }
            // The checked file is never rewritten.
            expect(await readFile(path, "utf8")).toBe(content);
        }
    });

    test("reports mismatches for missing, empty, and wrong files", async () => {
        const emptyPath = fixturePath("empty.json");
        await writeFile(emptyPath, "", "utf8");

        expect(
            await checkStandaloneTargetsFile({
                format: "json",
                filePath: emptyPath,
            }),
        ).toEqual({
            status: "mismatch",
            reason: expect.stringContaining("bytes"),
        });

        const wrongPath = fixturePath("homebrew-check.json");
        await writeFile(
            wrongPath,
            await renderStandaloneTargetsDocument({
                format: "homebrew",
                version: "0.1.2",
            }),
            "utf8",
        );
        expect(
            await checkStandaloneTargetsFile({
                format: "json",
                filePath: wrongPath,
            }),
        ).toEqual({
            status: "mismatch",
            reason: expect.stringMatching(/byte/i),
        });

        expect(
            await checkStandaloneTargetsFile({
                format: "json",
                filePath: join(fixtureDirectory, "missing.json"),
            }),
        ).toEqual({
            status: "mismatch",
            reason: expect.stringContaining("cannot be read"),
        });
    });

    test("validation errors surface before the checked file is considered", async () => {
        const path = fixturePath("homebrew-check.json");
        await expect(
            checkStandaloneTargetsFile({
                format: "homebrew",
                filePath: path,
            }),
        ).rejects.toThrow(StandaloneTargetsCommandError);
        expect(await readFile(path, "utf8")).toBe(
            await renderStandaloneTargetsDocument({
                format: "homebrew",
                version: "0.1.2",
            }),
        );
    });
});