import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "src");

const ROOT_MODULES = new Set([
    "build-info.ts",
    "cli.ts",
    "command.ts",
    "options.ts",
    "runtime.ts",
]);

const sourceFiles = async (): Promise<readonly string[]> => {
    const entries = await readdir(SRC, { recursive: true });
    return entries
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => join(SRC, entry))
        .sort();
};

const importSpecifiers = async (file: string): Promise<readonly string[]> => {
    const source = await readFile(file, "utf8");
    return [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].flatMap(
        (match) => (match[1] === undefined ? [] : [match[1]]),
    );
};

type ImportEdge = {
    readonly specifier: string;
    readonly target: string;
};

/** Import edges of one file, resolved relative to `src/`. */
const importEdges = async (file: string): Promise<readonly ImportEdge[]> => {
    const edges: ImportEdge[] = [];
    for (const specifier of await importSpecifiers(file)) {
        edges.push({
            specifier,
            target: specifier.startsWith(".")
                ? relative(SRC, resolve(dirname(file), specifier))
                : specifier,
        });
    }
    return edges;
};

const relativePath = (file: string): string => relative(SRC, file);

const isAdapterPath = (target: string): boolean =>
    target.startsWith("adapters/") || target.includes("/adapters/");

const offenders = async (
    predicate: (file: string) => boolean,
    forbidden: (edge: ImportEdge, file: string) => boolean,
): Promise<readonly string[]> => {
    const found: string[] = [];
    for (const file of await sourceFiles()) {
        if (!predicate(file)) continue;
        for (const edge of await importEdges(file)) {
            if (forbidden(edge, file)) {
                found.push(`${relativePath(file)} -> ${edge.specifier}`);
            }
        }
    }
    return found;
};

const IO_MODULES = new Set([
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "bun",
    "proper-lockfile",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
]);

describe("hexagonal boundaries", () => {
    test("adapters are imported only by the composition root or their own context", async () => {
        expect(
            await offenders(
                () => true,
                ({ target }, file) => {
                    if (!isAdapterPath(target)) return false;
                    const importer = relativePath(file);
                    if (
                        importer === "runtime.ts" ||
                        importer === "command.ts"
                    ) {
                        return false;
                    }
                    const adapterContext = target.split("/")[0] ?? target;
                    return !importer.startsWith(`${adapterContext}/adapters/`);
                },
            ),
        ).toEqual([]);
    });

    test("non-adapter code does not import I/O or vendor SDKs", async () => {
        expect(
            await offenders(
                (file) => !relativePath(file).includes("/adapters/"),
                ({ target }) => IO_MODULES.has(target),
            ),
        ).toEqual([]);
    });

    test("the GitHub SDK stays confined to the GitHub context", async () => {
        expect(
            await offenders(
                (file) => {
                    const path = relativePath(file);
                    return (
                        path !== "github/ports.ts" &&
                        !path.startsWith("github/adapters/")
                    );
                },
                ({ target }) => target === "octokit",
            ),
        ).toEqual([]);
    });

    test("ports and domain modules never import adapters", async () => {
        expect(
            await offenders(
                (file) => {
                    const path = relativePath(file);
                    return (
                        path.endsWith("ports.ts") || path.includes("/domain/")
                    );
                },
                ({ target }) => isAdapterPath(target),
            ),
        ).toEqual([]);
    });

    test("contexts do not import the composition root", async () => {
        expect(
            await offenders(
                (file) => !ROOT_MODULES.has(relativePath(file)),
                ({ target }) =>
                    target.startsWith(".") && ROOT_MODULES.has(target),
            ),
        ).toEqual([]);
    });

    test("the progress adapter is imported only by the composition root", async () => {
        expect(
            await offenders(
                () => true,
                ({ target }, file) => {
                    if (!target.startsWith("progress/adapters/")) return false;
                    const importer = relativePath(file);
                    return (
                        !importer.startsWith("progress/adapters/") &&
                        importer !== "command.ts" &&
                        importer !== "runtime.ts"
                    );
                },
            ),
        ).toEqual([]);
    });

    test("only inbound adapters and the progress adapter write to process streams", async () => {
        const allowed = (path: string): boolean =>
            path === "cli.ts" ||
            path === "command.ts" ||
            path.startsWith("progress/adapters/");
        const found: string[] = [];
        for (const file of await sourceFiles()) {
            const path = relativePath(file);
            if (allowed(path)) continue;
            const source = await readFile(file, "utf8");
            if (/process\.(?:stdout|stderr)|console\./.test(source)) {
                found.push(path);
            }
        }
        expect(found).toEqual([]);
    });
});