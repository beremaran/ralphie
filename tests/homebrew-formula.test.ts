import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    HOMEBREW_TARGETS,
    parseHomebrewFormula,
    validateHomebrewFormulaText,
} from "../scripts/validate-homebrew-formula.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const version = "0.1.2";
const checksums = {
    "darwin-arm64":
        "30be72de92306adb5609a6e8bc2ddb9e9cc29d671e8e0dd87c1921f11aaaf5c5",
    "darwin-x64":
        "c08317b2f19011970d7a1579422d9c634cb756eaefafb147704ef8bbf1605ac8",
    "linux-arm64":
        "c23f670a69c60c8770bb4958e91ae3007804bab889b55ee8807f2fffd04295f5",
    "linux-x64":
        "c0d8b5ff1b24e554121bf879fb68380038ca7fbe27a63fd5857d6a1b27d2b300",
} as const;

type Target = keyof typeof checksums;

const readFormula = (): Promise<string> =>
    readFile(resolve(repositoryRoot, "Formula/ralphie.rb"), "utf8");

const manifestFor = (
    replacements: Partial<Record<Target, string>> = {},
): string =>
    `${HOMEBREW_TARGETS.map((target) => {
        const assetName = `ralphie-${target}`;
        const checksum = replacements[target] ?? checksums[target];
        return `${checksum}  ${assetName}`;
    }).join("\n")}\n`;

const mappingBlock = (target: Target): string => {
    const assetName = `ralphie-${target}`;
    return `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${assetName}"\n      sha256 "${checksums[target]}"`;
};

const swapText = (value: string, first: string, second: string): string => {
    const placeholder = "RALPHIE_FORMULA_SWAP_PLACEHOLDER";
    return value
        .replace(first, placeholder)
        .replace(second, first)
        .replace(placeholder, second);
};

describe("Homebrew formula checksum validation", () => {
    test("matches all four target URLs and checksums independently", async () => {
        const formula = await readFormula();
        const mappings = parseHomebrewFormula(formula, version);

        expect(mappings.size).toBe(4);
        expect(formula).toContain(
            'bin.install Dir["ralphie-*"].first => "ralphie"',
        );
        for (const target of HOMEBREW_TARGETS) {
            const assetName = `ralphie-${target}`;
            expect(mappings.get(assetName)).toEqual({
                assetName,
                url: `https://github.com/beremaran/ralphie/releases/download/v${version}/${assetName}`,
                sha256: checksums[target],
            });
        }
        expect(() =>
            validateHomebrewFormulaText(formula, manifestFor(), version),
        ).not.toThrow();
    });

    test("rejects missing and duplicate target mappings", async () => {
        const formula = await readFormula();
        const missing = formula.replace(`\n${mappingBlock("linux-x64")}`, "");
        expect(() =>
            validateHomebrewFormulaText(missing, manifestFor(), version),
        ).toThrow("exactly 4 URLs");

        const duplicate = formula.replace(
            mappingBlock("linux-x64"),
            mappingBlock("darwin-arm64"),
        );
        expect(() =>
            validateHomebrewFormulaText(duplicate, manifestFor(), version),
        ).toThrow("distinct SHA-256");

        expect(() =>
            validateHomebrewFormulaText(
                formula,
                `${manifestFor()}${checksums["darwin-arm64"]}  ralphie-darwin-arm64\n`,
                version,
            ),
        ).toThrow("duplicate entry");
    });

    test("rejects zero and malformed checksums", async () => {
        const formula = await readFormula();
        const zero = formula.replace(checksums["linux-x64"], "0".repeat(64));
        expect(() =>
            validateHomebrewFormulaText(zero, manifestFor(), version),
        ).toThrow("Invalid SHA-256");

        const malformedFormula = formula.replace(
            checksums["linux-x64"],
            "z".repeat(64),
        );
        expect(() =>
            validateHomebrewFormulaText(
                malformedFormula,
                manifestFor(),
                version,
            ),
        ).toThrow("Invalid SHA-256");

        const malformedManifest = manifestFor().replace(
            checksums["linux-x64"],
            "z".repeat(64),
        );
        expect(() =>
            validateHomebrewFormulaText(formula, malformedManifest, version),
        ).toThrow("Invalid SHA256SUMS line");

        expect(() =>
            validateHomebrewFormulaText(
                formula,
                manifestFor({ "linux-x64": "0".repeat(64) }),
                version,
            ),
        ).toThrow("placeholder checksum");
    });

    test("rejects stale and cross-target checksums", async () => {
        const formula = await readFormula();
        const stale = formula.replace(checksums["linux-x64"], "a".repeat(64));
        expect(() =>
            validateHomebrewFormulaText(stale, manifestFor(), version),
        ).toThrow("Checksum mismatch");

        const crossTargetFormula = HOMEBREW_TARGETS.reduce(
            (current, target, index) => {
                const source = HOMEBREW_TARGETS[
                    (index + 1) % HOMEBREW_TARGETS.length
                ] as Target;
                return current.replace(
                    mappingBlock(target),
                    mappingBlock(target).replace(
                        checksums[target],
                        checksums[source],
                    ),
                );
            },
            formula,
        );
        expect(() =>
            validateHomebrewFormulaText(
                crossTargetFormula,
                manifestFor(),
                version,
            ),
        ).toThrow("Checksum mismatch");
    });

    test("rejects mappings under the wrong OS or CPU branch", async () => {
        const formula = await readFormula();
        const swappedOs = swapText(
            swapText(
                formula,
                mappingBlock("darwin-arm64"),
                mappingBlock("linux-arm64"),
            ),
            mappingBlock("darwin-x64"),
            mappingBlock("linux-x64"),
        );
        expect(() =>
            validateHomebrewFormulaText(swappedOs, manifestFor(), version),
        ).toThrow("on_macos");

        const swappedMacosCpu = swapText(
            formula,
            mappingBlock("darwin-arm64"),
            mappingBlock("darwin-x64"),
        );
        expect(() =>
            validateHomebrewFormulaText(
                swappedMacosCpu,
                manifestFor(),
                version,
            ),
        ).toThrow("on_macos");

        const swappedLinuxCpu = swapText(
            formula,
            mappingBlock("linux-arm64"),
            mappingBlock("linux-x64"),
        );
        expect(() =>
            validateHomebrewFormulaText(
                swappedLinuxCpu,
                manifestFor(),
                version,
            ),
        ).toThrow("on_linux");
    });

    test("rejects a formula for a different release version", async () => {
        const formula = await readFormula();

        expect(() =>
            validateHomebrewFormulaText(formula, manifestFor(), "0.2.0"),
        ).toThrow("Formula version must be 0.2.0");
    });
});