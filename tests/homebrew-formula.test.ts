import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    HOMEBREW_TARGETS,
    parseHomebrewFormula,
    validateHomebrewFormulaText,
} from "../scripts/validate-homebrew-formula.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const version = "0.1.1";

const readFormula = (): Promise<string> =>
    readFile(resolve(repositoryRoot, "Formula/ralphie.rb"), "utf8");

const manifestFor = (formula: string): string => {
    const mappings = parseHomebrewFormula(formula, version);
    return `${HOMEBREW_TARGETS.map((target) => {
        const assetName = `ralphie-${target}`;
        return `${mappings.get(assetName)?.sha256}  ${assetName}`;
    }).join("\n")}\n`;
};

describe("Homebrew formula checksum validation", () => {
    test("matches the four per-platform formula values to the manifest", async () => {
        const formula = await readFormula();
        const mappings = parseHomebrewFormula(formula, version);

        expect(mappings.size).toBe(4);
        expect(
            new Set([...mappings.values()].map((mapping) => mapping.sha256))
                .size,
        ).toBe(4);
        expect(() =>
            validateHomebrewFormulaText(formula, manifestFor(formula), version),
        ).not.toThrow();
    });

    test("rejects a checksum copied from another platform", async () => {
        const formula = await readFormula();
        const mappings = parseHomebrewFormula(formula, version);
        const checksums = HOMEBREW_TARGETS.map((target) => {
            const assetName = `ralphie-${target}`;
            return mappings.get(assetName)?.sha256 as string;
        });
        const manifest = `${HOMEBREW_TARGETS.map((target, index) => {
            const assetName = `ralphie-${target}`;
            return `${checksums[(index + 1) % checksums.length]}  ${assetName}`;
        }).join("\n")}\n`;

        expect(() =>
            validateHomebrewFormulaText(formula, manifest, version),
        ).toThrow("Checksum mismatch");
    });

    test("rejects a formula for a different release version", async () => {
        const formula = await readFormula();

        expect(() =>
            validateHomebrewFormulaText(formula, manifestFor(formula), "0.2.0"),
        ).toThrow("Formula version must be 0.2.0");
    });
});