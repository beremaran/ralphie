import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { analyzeSourceReachability } from "../scripts/source-reachability.ts";

const repositoryRoot = join(import.meta.dir, "..");

const moduleFor = (
    report: Awaited<ReturnType<typeof analyzeSourceReachability>>,
    path: string,
) => {
    const module = report.modules.find((candidate) => candidate.path === path);
    if (module === undefined)
        throw new Error(`Missing audited module: ${path}`);
    return module;
};

describe("source reachability audit", () => {
    test("is deterministic and has no unresolved or orphaned source modules", async () => {
        const first = await analyzeSourceReachability(repositoryRoot);
        const second = await analyzeSourceReachability(repositoryRoot);

        expect(second).toEqual(first);
        expect(first.unresolved).toEqual([]);
        expect(first.orphanedModules).toEqual([]);
        expect(first.roots).toEqual({
            production: "index.ts",
            build: "scripts/build.ts",
        });
    });

    test("distinguishes production value, type-only, and build-only reachability", async () => {
        const report = await analyzeSourceReachability(repositoryRoot);
        const buildInfo = moduleFor(report, "src/build-info.ts");
        const buildInfoExport = (name: string) => {
            const record = buildInfo.exports.find(
                (candidate) => candidate.name === name,
            );
            if (record === undefined)
                throw new Error(`Missing audited export: ${name}`);
            return record;
        };

        expect(buildInfo.productionValue).toBe(true);
        expect(buildInfo.buildReachable).toBe(true);
        expect(buildInfoExport("BUILD_INFO")).toMatchObject({
            classification: "production-reachable",
            kind: "value",
        });
        expect(buildInfoExport("BuildInfo")).toMatchObject({
            classification: "explicitly-build-only",
            kind: "type",
        });
        expect(buildInfoExport("LOCAL_BUILD_COMMIT_SHA")).toMatchObject({
            classification: "explicitly-build-only",
            kind: "value",
        });

        const command = moduleFor(report, "src/command.ts");
        expect(command.imports).toContainEqual({
            to: "src/get-pipelines-green.ts",
            kind: "type",
            names: ["GetPipelinesGreenOptions"],
            reexport: false,
        });
        expect(command.imports).toContainEqual({
            to: "src/get-pipelines-green.ts",
            kind: "value",
            names: ["getPipelinesGreen"],
            reexport: false,
        });
        expect(
            command.exports.find(
                (candidate) => candidate.name === "parseCliArgs",
            ),
        ).toMatchObject({ classification: "orphaned" });
    });
});