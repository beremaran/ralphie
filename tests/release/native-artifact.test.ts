import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    inspectNativeBinary,
    validateNativeArtifact,
} from "../../scripts/verify-native-artifact.ts";
import { STANDALONE_TARGET_IDS } from "../../src/targets/standalone-targets.ts";

type NativeTarget = (typeof STANDALONE_TARGET_IDS)[number];

const nativeFixture = (target: NativeTarget): Uint8Array => {
    const bytes = new Uint8Array(64);
    if (target.startsWith("darwin")) {
        bytes.set([0xcf, 0xfa, 0xed, 0xfe]);
        new DataView(bytes.buffer).setUint32(
            4,
            target.endsWith("arm64") ? 0x0100000c : 0x01000007,
            true,
        );
    } else {
        bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
        new DataView(bytes.buffer).setUint16(
            18,
            target.endsWith("arm64") ? 183 : 62,
            true,
        );
    }
    return bytes;
};

const createFixture = async (
    target: NativeTarget,
    mode = 0o755,
    bytes = nativeFixture(target),
): Promise<{ root: string; path: string }> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-native-artifact-test-"));
    const path = join(root, `ralphie-${target}`);
    await writeFile(path, bytes);
    await chmod(path, mode);
    return { root, path };
};

describe("native release artifact validation", () => {
    test("recognizes every canonical target header and emits its digest", async () => {
        for (const target of STANDALONE_TARGET_IDS) {
            const fixture = await createFixture(target);
            try {
                const artifact = await validateNativeArtifact(
                    fixture.path,
                    target,
                );
                expect(artifact.format).toBe(
                    target.startsWith("darwin") ? "Mach-O" : "ELF",
                );
                expect(artifact.architecture).toBe(
                    target.endsWith("arm64") ? "arm64" : "x64",
                );
                expect(artifact.sha256).toBe(
                    createHash("sha256")
                        .update(nativeFixture(target))
                        .digest("hex"),
                );
            } finally {
                await rm(fixture.root, { recursive: true, force: true });
            }
        }
    });

    test("rejects missing, mislabeled, non-executable, and wrong-header fixtures", async () => {
        const missing = await mkdtemp(
            join(tmpdir(), "ralphie-native-artifact-missing-"),
        );
        try {
            await expect(
                validateNativeArtifact(
                    join(missing, "ralphie-linux-x64"),
                    "linux-x64",
                ),
            ).rejects.toThrow("is missing");
        } finally {
            await rm(missing, { recursive: true, force: true });
        }

        const mislabeled = await createFixture("linux-x64");
        try {
            await expect(
                validateNativeArtifact(mislabeled.path, "linux-arm64"),
            ).rejects.toThrow("expected target name 'ralphie-linux-arm64'");
        } finally {
            await rm(mislabeled.root, { recursive: true, force: true });
        }

        const wrongArchitecture = await createFixture(
            "linux-x64",
            0o755,
            nativeFixture("linux-arm64"),
        );
        try {
            await expect(
                validateNativeArtifact(wrongArchitecture.path, "linux-x64"),
            ).rejects.toThrow("expected ELF/x64");
        } finally {
            await rm(wrongArchitecture.root, {
                recursive: true,
                force: true,
            });
        }

        const nonExecutable = await createFixture("darwin-arm64", 0o644);
        try {
            await expect(
                validateNativeArtifact(nonExecutable.path, "darwin-arm64"),
            ).rejects.toThrow("not executable");
        } finally {
            await rm(nonExecutable.root, { recursive: true, force: true });
        }

        const wrongHeader = await createFixture(
            "linux-x64",
            0o755,
            new TextEncoder().encode("not a native executable"),
        );
        try {
            await expect(
                validateNativeArtifact(wrongHeader.path, "linux-x64"),
            ).rejects.toThrow("Unsupported native executable header");
        } finally {
            await rm(wrongHeader.root, { recursive: true, force: true });
        }
    });

    test("rejects a non-native or truncated header before architecture matching", () => {
        expect(() => inspectNativeBinary(new Uint8Array([0x7f, 0x45]))).toThrow(
            "Unsupported native executable header",
        );
        expect(() =>
            inspectNativeBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1])),
        ).toThrow("ELF header is truncated");
    });
});