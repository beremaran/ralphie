#!/usr/bin/env bun

import packageJson from "../package.json";
import { LOCAL_BUILD_COMMIT_SHA, type BuildInfo } from "../src/build-info.ts";

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

const build = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    const buildInfo: BuildInfo = {
        version: valueForOption(args, "--version") ?? packageJson.version,
        commitSha:
            valueForOption(args, "--commit-sha") ?? LOCAL_BUILD_COMMIT_SHA,
    };
    const result = await Bun.build({
        entrypoints: ["./index.ts"],
        target: "bun",
        outdir: "./dist",
        naming: { entry: "ralphie.js" },
        define: {
            RALPHIE_BUILD_INFO: JSON.stringify(buildInfo),
        },
    });

    if (result.success) return;
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed.");
};

await build();