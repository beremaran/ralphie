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

describe("layer boundaries", () => {
    test("presentation imports only the composition root and adapters", async () => {
        const importers = (await sourceFiles(SRC)).filter((file) => {
            const path = relative(SRC, file);
            return (
                path !== "command.ts" &&
                path !== "runtime.ts" &&
                !path.startsWith("adapters/progress/") &&
                !path.startsWith("core/ports/")
            );
        });
        expect(
            await offendersFor(importers, (target) =>
                target.startsWith("adapters/progress/"),
            ),
        ).toEqual([]);
    });

    test("the presentation adapter does not import execution code", async () => {
        expect(
            await offendersFor(
                await filesIn("adapters/progress"),
                (target) =>
                    target.startsWith("core/") &&
                    !target.startsWith("core/ports/"),
            ),
        ).toEqual([]);
    });

    test("ports stay dependency-free leaf contracts", async () => {
        expect(
            await offendersFor(await filesIn("core/ports"), (target) => {
                if (target.startsWith("core/ports/")) return false;
                if (target.startsWith("core/domain/")) return false;
                if (target === "shared" || target.startsWith("shared/")) {
                    return false;
                }
                return true;
            }),
        ).toEqual([]);
    });

    test("only inbound adapters and the composition root write to process streams", async () => {
        const offenders: string[] = [];
        for (const file of await sourceFiles(SRC)) {
            const path = relative(SRC, file);
            if (path === "command.ts" || path === "cli.ts") continue;
            if (path.startsWith("adapters/progress/")) continue;
            const source = await readFile(file, "utf8");
            if (/process\.(?:stdout|stderr)|console\./.test(source)) {
                offenders.push(path);
            }
        }
        expect(offenders).toEqual([]);
    });
});