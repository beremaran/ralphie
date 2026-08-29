import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");
const readRepositoryFile = (path: string): Promise<string> =>
    Bun.file(resolve(repositoryRoot, path)).text();

describe("distribution license contract", () => {
    test("uses the approved MIT identifier in every distribution channel", async () => {
        const [license, dockerfile, formula] = await Promise.all([
            readRepositoryFile("LICENSE"),
            readRepositoryFile("Dockerfile"),
            readRepositoryFile("Formula/ralphie.rb"),
        ]);

        expect(license).toStartWith(
            "MIT License\n\nCopyright (c) 2026 Beremaran\n",
        );
        expect(packageJson.license).toBe("MIT");
        expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
        expect(formula).toContain('  license "MIT"');
    });

    test("documents the project, dependency, and privacy boundaries", async () => {
        const topology = await readRepositoryFile(
            "docs/public-distribution.md",
        );

        expect(topology).toContain(
            "maintainer-approved project license is MIT",
        );
        expect(topology).toContain(
            "Third-party dependencies remain under their respective licenses",
        );
        expect(topology).toContain(
            "No Ralphie source or distribution component is intentionally private",
        );
    });
});