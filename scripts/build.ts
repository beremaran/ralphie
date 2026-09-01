#!/usr/bin/env bun

import packageJson from "../package.json";
import { LOCAL_BUILD_COMMIT_SHA, type BuildInfo } from "../src/build-info.ts";
import { STANDALONE_TARGET_IDS } from "../src/targets/standalone-targets.ts";

type BuildTarget = "native" | "package";
type NativeReleaseTarget = (typeof STANDALONE_TARGET_IDS)[number];

const BUN_COMPILE_TARGETS: Readonly<
    Record<NativeReleaseTarget, Bun.Build.CompileTarget>
> = {
    "darwin-arm64": "bun-darwin-arm64",
    "darwin-x64": "bun-darwin-x64",
    "linux-arm64": "bun-linux-arm64",
    "linux-x64": "bun-linux-x64",
};

const valueForOption = (
    args: ReadonlyArray<string>,
    option: string,
): string | undefined => {
    const index = args.indexOf(option);
    if (index === -1) return undefined;

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const resolveTarget = (args: ReadonlyArray<string>): BuildTarget =>
    args.includes("--package") ? "package" : "native";

const resolveVersion = (args: ReadonlyArray<string>): string =>
    valueForOption(args, "--version") ?? packageJson.version;

const resolveCommitSha = (args: ReadonlyArray<string>): string =>
    valueForOption(args, "--commit-sha") ?? LOCAL_BUILD_COMMIT_SHA;

const resolveNativeReleaseTarget = (
    args: ReadonlyArray<string>,
): NativeReleaseTarget | undefined => {
    const value = valueForOption(args, "--target");
    if (value === undefined) return undefined;
    if (!(STANDALONE_TARGET_IDS as ReadonlyArray<string>).includes(value)) {
        throw new Error(
            `Unsupported native target '${value}'; expected ${STANDALONE_TARGET_IDS.join(", ")}.`,
        );
    }
    return value as NativeReleaseTarget;
};

const buildConfigFor = (
    target: BuildTarget,
    buildInfo: BuildInfo,
    nativeTarget: NativeReleaseTarget | undefined,
): Bun.BuildConfig => {
    const shared = {
        entrypoints: ["./index.ts"],
        define: {
            RALPHIE_BUILD_INFO: JSON.stringify(buildInfo),
        },
    } satisfies Bun.BuildConfig;

    return target === "package"
        ? {
              ...shared,
              target: "bun",
              outdir: "./dist",
              naming: { entry: "ralphie.js" },
          }
        : {
              ...shared,
              compile: {
                  outfile:
                      nativeTarget === undefined
                          ? "./dist/cli"
                          : `./dist/ralphie-${nativeTarget}`,
                  ...(nativeTarget === undefined
                      ? {}
                      : { target: BUN_COMPILE_TARGETS[nativeTarget] }),
              },
          };
};

const build = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    const buildTarget = resolveTarget(args);
    const nativeTarget = resolveNativeReleaseTarget(args);
    if (buildTarget === "package" && nativeTarget !== undefined) {
        throw new Error("--target is only supported for native builds.");
    }
    const buildInfo: BuildInfo = {
        version: resolveVersion(args),
        commitSha: resolveCommitSha(args),
    };
    const result = await Bun.build(
        buildConfigFor(buildTarget, buildInfo, nativeTarget),
    );

    if (result.success) return;
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed.");
};

await build();