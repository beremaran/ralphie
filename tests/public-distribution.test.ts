import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import packageJson from "../package.json";
import {
    parseTopology,
    REQUIRED_BINARY_ASSETS,
} from "../scripts/verify-public-distribution.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

const readRepositoryFile = (path: string): Promise<string> =>
    readFile(join(repositoryRoot, path), "utf8");

describe("public distribution verification contract", () => {
    test("derives one canonical endpoint set from the topology document", async () => {
        const topology = parseTopology(
            await readRepositoryFile("docs/public-distribution.md"),
        );

        expect(topology.slug).toBe("beremaran/ralphie");
        expect(topology.repositoryUrl).toBe(
            "https://github.com/beremaran/ralphie",
        );
        expect(topology.releasesUrl).toBe(
            "https://github.com/beremaran/ralphie/releases",
        );
        expect(topology.rawInstallerUrl).toBe(
            "https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh",
        );
        expect(topology.formulaUrl).toBe(
            "https://raw.githubusercontent.com/beremaran/ralphie/main/Formula/ralphie.rb",
        );
        expect(topology.image).toBe("ghcr.io/beremaran/ralphie");
        expect(topology.description).toBe(
            "Turn a GitHub issue queue into reviewed commits with Pi.",
        );
        expect(topology.homepage).toBe(
            "https://github.com/beremaran/ralphie#readme",
        );
        expect(topology.topics).toContain("cli");
    });

    test("publishes the check as an explicit package command", () => {
        expect(packageJson.scripts["verify:public-distribution"]).toBe(
            "bun run scripts/verify-public-distribution.ts",
        );
        expect(REQUIRED_BINARY_ASSETS).toEqual([
            "ralphie-darwin-arm64",
            "ralphie-darwin-x64",
            "ralphie-linux-arm64",
            "ralphie-linux-x64",
        ]);
    });

    test("runs the check with checkout credentials disabled", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/public-distribution.yml",
        );

        expect(workflow).toContain("persist-credentials: false");
        expect(workflow).toContain('GH_TOKEN: ""');
        expect(workflow).toContain('GITHUB_TOKEN: ""');
        expect(workflow).toContain(
            "env -u GH_TOKEN -u GITHUB_TOKEN bun run verify:public-distribution",
        );
    });
});