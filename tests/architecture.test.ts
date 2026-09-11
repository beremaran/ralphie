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
        if (specifier !== undefined) specifiers.push(specifier);
    }
    return specifiers;
};

type ImportEdge = {
    readonly specifier: string;
    readonly target: string;
};

/** Relative import edges of one file, resolved relative to `src/`. */
const importEdges = async (file: string): Promise<readonly ImportEdge[]> => {
    const source = await readFile(file, "utf8");
    return importSpecifiers(source)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => ({
            specifier,
            target: relative(SRC, resolve(dirname(file), specifier)),
        }));
};

const externalImports = async (file: string): Promise<readonly string[]> => {
    const source = await readFile(file, "utf8");
    return importSpecifiers(source).filter(
        (specifier) => !specifier.startsWith("."),
    );
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

const isWithin = (target: string, category: string): boolean =>
    target === category || target.startsWith(`${category}/`);

const ADAPTER_CATEGORIES = [
    "adapters/git",
    "adapters/github",
    "adapters/issues",
    "adapters/pi",
    "adapters/process",
    "adapters/progress",
    "adapters/run",
    "adapters/workspace",
] as const;

const isAdapter = (target: string): boolean =>
    ADAPTER_CATEGORIES.some((category) => isWithin(target, category));

describe("hexagonal boundaries", () => {
    test("core never imports adapters or the composition root", async () => {
        const importers = [
            ...(await filesIn("core/app")),
            ...(await filesIn("core/domain")),
            ...(await filesIn("core/ports")),
        ];
        expect(
            await offendersFor(
                importers,
                (target) =>
                    isAdapter(target) ||
                    target === "command.ts" ||
                    target === "cli.ts" ||
                    target === "runtime.ts" ||
                    target === "options.ts",
            ),
        ).toEqual([]);
    });

    test("core does not import I/O or vendor SDKs", async () => {
        const forbidden = new Set([
            "node:fs",
            "node:fs/promises",
            "node:child_process",
            "bun",
            "proper-lockfile",
            "@earendil-works/pi-agent-core",
            "@earendil-works/pi-ai",
        ]);
        const offenders: string[] = [];
        for (const file of [
            ...(await filesIn("core/app")),
            ...(await filesIn("core/domain")),
            ...(await filesIn("core/ports")),
        ]) {
            for (const specifier of await externalImports(file)) {
                if (forbidden.has(specifier)) {
                    offenders.push(`${relative(SRC, file)} -> ${specifier}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("the GitHub SDK handle is the only vendor type allowed in core/ports", async () => {
        const allowedVendorTypes = new Set(["octokit"]);
        const offenders: string[] = [];
        for (const file of await filesIn("core/ports")) {
            for (const specifier of await externalImports(file)) {
                const allowed =
                    specifier.startsWith("node:") ||
                    allowedVendorTypes.has(specifier);
                if (!allowed) {
                    offenders.push(`${relative(SRC, file)} -> ${specifier}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("ports depend only on core contracts, the domain, and shared utilities", async () => {
        expect(
            await offendersFor(
                await filesIn("core/ports"),
                (target) =>
                    !isWithin(target, "core/ports") &&
                    !isWithin(target, "core/domain") &&
                    !isWithin(target, "shared") &&
                    !isWithin(target, "core/app"),
            ),
        ).toEqual([]);
    });

    test("presentation imports only the composition root and core contracts", async () => {
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
                isWithin(target, "adapters/progress"),
            ),
        ).toEqual([]);
    });

    test("the presentation adapter does not import execution code", async () => {
        expect(
            await offendersFor(
                await filesIn("adapters/progress"),
                (target) =>
                    !isWithin(target, "adapters/progress") &&
                    !isWithin(target, "core/ports") &&
                    !isWithin(target, "core/domain") &&
                    !isWithin(target, "shared"),
            ),
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