#!/usr/bin/env bun

import packageJson from "../package.json";
import { LOCAL_BUILD_COMMIT_SHA, type BuildInfo } from "../src/build-info.ts";

type BuildTarget = "native" | "package";

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

const resolveCommitSha = (args: ReadonlyArray<string>): string =>
    valueForOption(args, "--commit-sha") ?? LOCAL_BUILD_COMMIT_SHA;

const buildConfigFor = (
    target: BuildTarget,
    buildInfo: BuildInfo,
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
              compile: { outfile: "./dist/cli" },
          };
};

const build = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    const buildInfo: BuildInfo = {
        version: packageJson.version,
        commitSha: resolveCommitSha(args),
    };
    const result = await Bun.build(
        buildConfigFor(resolveTarget(args), buildInfo),
    );

    if (result.success) return;
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed.");
};

await build();