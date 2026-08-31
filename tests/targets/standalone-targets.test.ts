import { describe, expect, test } from "bun:test";

import {
    STANDALONE_TARGETS_PATH,
    loadStandaloneTargets,
    parseStandaloneTargets,
} from "../../src/targets/standalone-targets.ts";

const mutableCopy = async (): Promise<Array<Record<string, unknown>>> =>
    JSON.parse(JSON.stringify(await loadStandaloneTargets())) as Array<
        Record<string, unknown>
    >;

describe("standalone target manifest", () => {
    test("loads the canonical targets in deterministic order", async () => {
        const targets = await loadStandaloneTargets();

        expect(STANDALONE_TARGETS_PATH).toEndWith(
            "targets/standalone-targets.json",
        );
        expect(targets.map((target) => target.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        expect(targets.map((target) => target.releaseAssetName)).toEqual([
            "ralphie-darwin-arm64",
            "ralphie-darwin-x64",
            "ralphie-linux-arm64",
            "ralphie-linux-x64",
        ]);
        expect(targets.every((target) => target.bunVersion === "1.3.14")).toBe(
            true,
        );
        expect(targets.map((target) => target.dockerPlatform)).toEqual([
            null,
            null,
            "linux/arm64",
            "linux/amd64",
        ]);
    });

    test("rejects non-canonical fields for a target ID", async () => {
        const mutations: Array<{ field: string; value: unknown }> = [
            {
                field: "releaseAssetName",
                value: "ralphie-darwin-arm64-custom",
            },
            { field: "os", value: "linux" },
            { field: "arch", value: "x64" },
            { field: "bunCompileTarget", value: "bun-darwin-x64" },
            { field: "targetTriple", value: "x86_64-apple-darwin" },
            { field: "binaryFormat", value: "Mach-O x86_64" },
            { field: "runner", value: "macos-13" },
        ];

        for (const { field, value } of mutations) {
            const targets = await mutableCopy();
            targets[0]![field] = value;
            expect(() => parseStandaloneTargets(targets)).toThrow(
                `Canonical ${field}`,
            );
        }
    });

    test("rejects duplicate target IDs and release assets", async () => {
        const duplicateId = await mutableCopy();
        duplicateId[1]!.id = duplicateId[0]!.id;
        expect(() => parseStandaloneTargets(duplicateId)).toThrow(
            "Target IDs must be unique",
        );

        const duplicateAsset = await mutableCopy();
        duplicateAsset[1]!.releaseAssetName =
            duplicateAsset[0]!.releaseAssetName;
        expect(() => parseStandaloneTargets(duplicateAsset)).toThrow(
            "Release asset names must be unique",
        );
    });

    test("rejects missing and extra targets", async () => {
        const missing = await mutableCopy();
        missing.pop();
        expect(() => parseStandaloneTargets(missing)).toThrow(
            "must be exactly",
        );

        const extra = await mutableCopy();
        extra.push({ ...extra[3]!, id: "windows-x64" });
        expect(() => parseStandaloneTargets(extra)).toThrow();
    });

    test("rejects malformed records", async () => {
        const missingField = await mutableCopy();
        delete missingField[0]!.bunCompileTarget;
        expect(() => parseStandaloneTargets(missingField)).toThrow();

        const unknownField = await mutableCopy();
        unknownField[0]!.unexpected = true;
        expect(() => parseStandaloneTargets(unknownField)).toThrow();
    });

    test("rejects incorrect Linux Docker mappings", async () => {
        const armMapping = await mutableCopy();
        armMapping[2]!.dockerPlatform = "linux/amd64";
        expect(() => parseStandaloneTargets(armMapping)).toThrow(
            "Docker platform",
        );

        const x64Mapping = await mutableCopy();
        x64Mapping[3]!.dockerPlatform = null;
        expect(() => parseStandaloneTargets(x64Mapping)).toThrow(
            "Docker platform",
        );
    });
});