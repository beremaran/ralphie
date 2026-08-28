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
});