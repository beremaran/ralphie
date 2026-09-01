import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const STANDALONE_TARGET_IDS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
] as const;

const STANDALONE_OSES = ["darwin", "linux"] as const;
const STANDALONE_ARCHITECTURES = ["arm64", "x64"] as const;
const BUN_COMPILE_TARGETS = [
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-arm64",
    "bun-linux-x64",
] as const;
const TARGET_TRIPLES = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
] as const;
const BINARY_FORMATS = [
    "Mach-O arm64",
    "Mach-O x86_64",
    "ELF aarch64",
    "ELF x86_64",
] as const;
const RUNNERS = [
    "macos-14",
    "macos-15-intel",
    "ubuntu-24.04-arm",
    "ubuntu-24.04",
] as const;
const DOCKER_PLATFORMS = ["linux/arm64", "linux/amd64"] as const;
const BUN_VERSION = "1.3.14" as const;

const CANONICAL_TARGET_FIELDS = [
    "releaseAssetName",
    "os",
    "arch",
    "bunCompileTarget",
    "targetTriple",
    "binaryFormat",
    "runner",
] as const;

type CanonicalTargetFields = {
    readonly releaseAssetName: string;
    readonly os: (typeof STANDALONE_OSES)[number];
    readonly arch: (typeof STANDALONE_ARCHITECTURES)[number];
    readonly bunCompileTarget: (typeof BUN_COMPILE_TARGETS)[number];
    readonly targetTriple: (typeof TARGET_TRIPLES)[number];
    readonly binaryFormat: (typeof BINARY_FORMATS)[number];
    readonly runner: (typeof RUNNERS)[number];
};

const CANONICAL_TARGETS = {
    "darwin-arm64": {
        releaseAssetName: "ralphie-darwin-arm64",
        os: "darwin",
        arch: "arm64",
        bunCompileTarget: "bun-darwin-arm64",
        targetTriple: "aarch64-apple-darwin",
        binaryFormat: "Mach-O arm64",
        runner: "macos-14",
    },
    "darwin-x64": {
        releaseAssetName: "ralphie-darwin-x64",
        os: "darwin",
        arch: "x64",
        bunCompileTarget: "bun-darwin-x64",
        targetTriple: "x86_64-apple-darwin",
        binaryFormat: "Mach-O x86_64",
        runner: "macos-15-intel",
    },
    "linux-arm64": {
        releaseAssetName: "ralphie-linux-arm64",
        os: "linux",
        arch: "arm64",
        bunCompileTarget: "bun-linux-arm64",
        targetTriple: "aarch64-unknown-linux-gnu",
        binaryFormat: "ELF aarch64",
        runner: "ubuntu-24.04-arm",
    },
    "linux-x64": {
        releaseAssetName: "ralphie-linux-x64",
        os: "linux",
        arch: "x64",
        bunCompileTarget: "bun-linux-x64",
        targetTriple: "x86_64-unknown-linux-gnu",
        binaryFormat: "ELF x86_64",
        runner: "ubuntu-24.04",
    },
} as const satisfies Record<
    (typeof STANDALONE_TARGET_IDS)[number],
    CanonicalTargetFields
>;

export const standaloneTargetSchema = z
    .object({
        id: z.enum(STANDALONE_TARGET_IDS),
        releaseAssetName: z.string().min(1),
        os: z.enum(STANDALONE_OSES),
        arch: z.enum(STANDALONE_ARCHITECTURES),
        bunCompileTarget: z.enum(BUN_COMPILE_TARGETS),
        targetTriple: z.enum(TARGET_TRIPLES),
        binaryFormat: z.enum(BINARY_FORMATS),
        runner: z.enum(RUNNERS),
        bunVersion: z.literal(BUN_VERSION),
        dockerPlatform: z.enum(DOCKER_PLATFORMS).nullable(),
    })
    .strict();

export type StandaloneTarget = z.infer<typeof standaloneTargetSchema>;

const duplicateValue = (values: ReadonlyArray<string>): string | undefined => {
    const seen = new Set<string>();
    return values.find((value) => {
        if (seen.has(value)) return true;
        seen.add(value);
        return false;
    });
};

const expectedDockerPlatformFor = (
    target: StandaloneTarget,
): StandaloneTarget["dockerPlatform"] => {
    if (target.id === "linux-arm64") return "linux/arm64";
    if (target.id === "linux-x64") return "linux/amd64";
    return null;
};

const validateCanonicalTarget = (
    target: StandaloneTarget,
    index: number,
    context: z.RefinementCtx,
): void => {
    const expected = CANONICAL_TARGETS[target.id];

    CANONICAL_TARGET_FIELDS.forEach((field) => {
        if (target[field] !== expected[field]) {
            context.addIssue({
                code: "custom",
                message: `Canonical ${field} for ${target.id} must be '${expected[field]}'.`,
                path: [index, field],
            });
        }
    });
};

const validateTargetCatalog = (
    targets: ReadonlyArray<StandaloneTarget>,
    context: z.RefinementCtx,
): void => {
    const ids = targets.map((target) => target.id);
    const assets = targets.map((target) => target.releaseAssetName);
    const duplicateId = duplicateValue(ids);
    const duplicateAsset = duplicateValue(assets);

    if (duplicateId !== undefined) {
        context.addIssue({
            code: "custom",
            message: `Target IDs must be unique; '${duplicateId}' is duplicated.`,
            path: ["id"],
        });
    }
    if (duplicateAsset !== undefined) {
        context.addIssue({
            code: "custom",
            message: `Release asset names must be unique; '${duplicateAsset}' is duplicated.`,
            path: ["releaseAssetName"],
        });
    }

    if (
        targets.length !== STANDALONE_TARGET_IDS.length ||
        STANDALONE_TARGET_IDS.some((id, index) => ids[index] !== id)
    ) {
        context.addIssue({
            code: "custom",
            message: `Standalone targets must be exactly ${STANDALONE_TARGET_IDS.join(", ")} in that order.`,
            path: [],
        });
    }

    targets.forEach((target, index) => {
        validateCanonicalTarget(target, index, context);

        if (target.dockerPlatform !== expectedDockerPlatformFor(target)) {
            context.addIssue({
                code: "custom",
                message: `Docker platform for ${target.id} must match its Linux architecture.`,
                path: [index, "dockerPlatform"],
            });
        }
    });
};

export const standaloneTargetsSchema = z
    .array(standaloneTargetSchema)
    .superRefine(validateTargetCatalog)
    .readonly();

export type StandaloneTargets = z.infer<typeof standaloneTargetsSchema>;

export const STANDALONE_TARGETS_PATH = resolve(
    import.meta.dir,
    "../../targets/standalone-targets.json",
);

export const parseStandaloneTargets = (value: unknown): StandaloneTargets =>
    standaloneTargetsSchema.parse(value);

export const loadStandaloneTargets = async (
    path = STANDALONE_TARGETS_PATH,
): Promise<StandaloneTargets> => {
    const content = await readFile(path, "utf8");
    const value: unknown = JSON.parse(content);
    return parseStandaloneTargets(value);
};