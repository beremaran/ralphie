#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { STANDALONE_TARGET_IDS } from "../src/targets/standalone-targets.ts";

export type NativeReleaseTarget = (typeof STANDALONE_TARGET_IDS)[number];
export type NativeBinaryFormat = "Mach-O" | "ELF";
export type NativeBinaryArchitecture = "arm64" | "x64";

export type NativeBinaryInspection = {
    readonly format: NativeBinaryFormat;
    readonly architecture: NativeBinaryArchitecture;
};

type Endianness = "LE" | "BE";

const isTarget = (value: string): value is NativeReleaseTarget =>
    (STANDALONE_TARGET_IDS as ReadonlyArray<string>).includes(value);

const viewFor = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const inspectMachO = (
    bytes: Uint8Array,
): NativeBinaryInspection | undefined => {
    if (bytes.length < 4) return undefined;
    const view = viewFor(bytes);
    const littleMagic = view.getUint32(0, true);
    const bigMagic = view.getUint32(0, false);
    const endianness: Endianness | undefined =
        littleMagic === 0xfeedfacf
            ? "LE"
            : bigMagic === 0xfeedfacf
              ? "BE"
              : undefined;
    if (endianness === undefined) return undefined;
    if (bytes.length < 8) {
        throw new Error("Mach-O header is truncated.");
    }
    const cpuType = view.getUint32(4, endianness === "LE");
    const architecture =
        cpuType === 0x0100000c
            ? "arm64"
            : cpuType === 0x01000007
              ? "x64"
              : undefined;
    if (architecture === undefined) {
        throw new Error(
            `Mach-O CPU type 0x${cpuType.toString(16)} is unsupported.`,
        );
    }
    return { format: "Mach-O", architecture };
};

const inspectElf = (bytes: Uint8Array): NativeBinaryInspection | undefined => {
    if (
        bytes.length < 4 ||
        bytes[0] !== 0x7f ||
        bytes[1] !== 0x45 ||
        bytes[2] !== 0x4c ||
        bytes[3] !== 0x46
    ) {
        return undefined;
    }
    if (bytes.length < 20) throw new Error("ELF header is truncated.");
    if (bytes[4] !== 2) throw new Error("ELF binary is not 64-bit.");
    if (bytes[5] !== 1) throw new Error("ELF binary is not little-endian.");
    const machine = viewFor(bytes).getUint16(18, true);
    const architecture =
        machine === 183 ? "arm64" : machine === 62 ? "x64" : undefined;
    if (architecture === undefined) {
        throw new Error(`ELF machine ${machine} is unsupported.`);
    }
    return { format: "ELF", architecture };
};

export const inspectNativeBinary = (
    bytes: Uint8Array,
): NativeBinaryInspection => {
    const inspection = inspectMachO(bytes) ?? inspectElf(bytes);
    if (inspection === undefined) {
        throw new Error("Unsupported native executable header.");
    }
    return inspection;
};

const expectedInspectionFor = (
    target: NativeReleaseTarget,
): NativeBinaryInspection => ({
    format: target.startsWith("darwin") ? "Mach-O" : "ELF",
    architecture: target.endsWith("arm64") ? "arm64" : "x64",
});

export type ValidatedNativeArtifact = NativeBinaryInspection & {
    readonly path: string;
    readonly sha256: string;
};

export const validateNativeArtifact = async (
    path: string,
    target: NativeReleaseTarget,
): Promise<ValidatedNativeArtifact> => {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
        fileStat = await stat(path);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            throw new Error(`Native artifact '${path}' is missing.`);
        }
        throw error;
    }
    if (!fileStat.isFile()) {
        throw new Error(`Native artifact '${path}' is not a regular file.`);
    }
    const expectedName = `ralphie-${target}`;
    if (basename(path) !== expectedName) {
        throw new Error(
            `Native artifact '${path}' does not have expected target name '${expectedName}'.`,
        );
    }
    if ((fileStat.mode & 0o111) === 0) {
        throw new Error(`Native artifact '${path}' is not executable.`);
    }

    const bytes = await readFile(path);
    const inspection = inspectNativeBinary(bytes);
    const expected = expectedInspectionFor(target);
    if (
        inspection.format !== expected.format ||
        inspection.architecture !== expected.architecture
    ) {
        throw new Error(
            `Native artifact '${path}' is ${inspection.format}/${inspection.architecture}, expected ${expected.format}/${expected.architecture} for ${target}.`,
        );
    }
    return {
        ...inspection,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
};

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 4) {
        throw new Error(
            "Usage: verify-native-artifact.ts --target <target> --path <executable>",
        );
    }
    const target = optionValue(args, "--target");
    if (!isTarget(target)) {
        throw new Error(
            `Unsupported native target '${target}'; expected ${STANDALONE_TARGET_IDS.join(", ")}.`,
        );
    }
    const path = optionValue(args, "--path");
    const artifact = await validateNativeArtifact(path, target);
    console.log(`${artifact.sha256}  ${basename(path)}`);
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}