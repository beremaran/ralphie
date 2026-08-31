import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const canonicalCommand = "bunx @beremaran/ralphie";
const unscopedCommand = /\bbunx\s+ralphie\b/;

function trackedMarkdownFiles(): string[] {
    const output = execFileSync("git", ["ls-files", "--", "*.md"], {
        cwd: repositoryRoot,
        encoding: "utf8",
    });

    return output.split("\n").filter((path) => path.length > 0);
}

describe("documentation command examples", () => {
    test("tracked Markdown does not invoke the unscoped package", async () => {
        const violations: string[] = [];

        for (const path of trackedMarkdownFiles()) {
            const contents = await Bun.file(
                resolve(repositoryRoot, path),
            ).text();
            if (unscopedCommand.test(contents)) {
                violations.push(path);
            }
        }

        expect(violations).toEqual([]);
    });

    test("README documents the canonical scoped package command", async () => {
        const readme = await Bun.file(
            resolve(repositoryRoot, "README.md"),
        ).text();

        expect(readme).toContain(canonicalCommand);
    });

    test("README documents the standalone, Docker, and target-runtime contract", async () => {
        const readme = await Bun.file(
            resolve(repositoryRoot, "README.md"),
        ).text();

        expect(readme).toContain("Verified standalone binary");
        expect(readme).toContain("does not require\n  [Bun]");
        expect(readme).toContain("Bun is required to run");
        expect(readme).toContain("build Ralphie from\n  source");
        expect(readme).toContain("Docker image");
        expect(readme).toContain("does not\n  include Bun at runtime");
        expect(readme).toContain("gh auth login");
        expect(readme).toContain("gh auth status");
        expect(readme).toContain("git --version");
        expect(readme).toContain("gh --version");
        expect(readme).toContain(
            "docker run --rm ghcr.io/beremaran/ralphie:latest --version",
        );
        expect(readme).toContain("--env GH_TOKEN");
        expect(readme).toContain("RALPHIE_MODEL_BASE_URL");
        expect(readme).toContain("/home/nonroot/.ralphie");
        expect(readme).toContain("target repository's verification command");
        expect(readme).toContain("--verify-command");
    });

    test("operator documentation never instructs token retrieval or printing", async () => {
        for (const path of trackedMarkdownFiles()) {
            const contents = await Bun.file(
                resolve(repositoryRoot, path),
            ).text();
            expect(contents).not.toContain("gh auth token");
            expect(contents).not.toContain("gh auth-token");
        }
    });
});