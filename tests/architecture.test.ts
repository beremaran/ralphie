import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "src");

const sourceFiles = async (root: string): Promise<readonly string[]> => {
    const entries = await readdir(root, { recursive: true });
    return entries
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => join(root, entry))
        .sort();
};

const importSpecifiers = (source: string): readonly string[] => {
    const specifiers: string[] = [];
    const pattern = /(?:from|import)\s*\(?\s*"([^"]+)"/g;
    for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier !== undefined && specifier.startsWith(".")) {
            specifiers.push(specifier);
        }
    }
    return specifiers;
};

/** Import edges of one file, resolved relative to `src/`. */
const importEdges = async (
    file: string,
): Promise<
    ReadonlyArray<{ readonly specifier: string; readonly target: string }>
> => {
    const source = await readFile(file, "utf8");
    return importSpecifiers(source).map((specifier) => ({
        specifier,
        target: relative(SRC, resolve(dirname(file), specifier)),
    }));
};

const offendersFor = async (
    files: ReadonlyArray<string>,
    forbidden: (target: string) => boolean,
): Promise<readonly string[]> => {
    const offenders: string[] = [];
    for (const file of files) {
        const path = relative(SRC, file);
        for (const { specifier, target } of await importEdges(file)) {
            if (forbidden(target)) offenders.push(`${path} -> ${specifier}`);
        }
    }
    return offenders;
};

const filesIn = async (category: string): Promise<readonly string[]> =>
    (await sourceFiles(SRC)).filter((file) =>
        relative(SRC, file).startsWith(`${category}/`),
    );

const EXECUTION_PREFIXES = [
    "issues",
    "git",
    "github",
    "workflow.ts",
    "command.ts",
    "runtime.ts",
] as const;

const isExecutionTarget = (target: string): boolean =>
    EXECUTION_PREFIXES.some(
        (prefix) => target === prefix || target.startsWith(`${prefix}/`),
    );

describe("layer boundaries", () => {
    test("only the composition root and the renderer import the presentation layer", async () => {
        const importers = (await sourceFiles(SRC)).filter((file) => {
            const path = relative(SRC, file);
            return path !== "command.ts" && !path.startsWith("progress/");
        });
        expect(
            await offendersFor(importers, (target) =>
                target.startsWith("progress/"),
            ),
        ).toEqual([]);
    });

    test("the renderer imports only contracts, shared utilities, and the agent event surface", async () => {
        expect(
            await offendersFor(await filesIn("progress"), isExecutionTarget),
        ).toEqual([]);
    });

    test("ports stay dependency-free leaf contracts", async () => {
        expect(
            await offendersFor(
                await filesIn("ports"),
                (target) => !target.startsWith("ports/"),
            ),
        ).toEqual([]);
    });

    test("execution code never writes to process streams", async () => {
        const offenders: string[] = [];
        for (const file of await sourceFiles(SRC)) {
            const path = relative(SRC, file);
            if (path === "command.ts" || path === "cli.ts") continue;
            if (path.startsWith("progress/")) continue;
            const source = await readFile(file, "utf8");
            if (/process\.(?:stdout|stderr)|console\./.test(source)) {
                offenders.push(path);
            }
        }
        expect(offenders).toEqual([]);
    });
});