#!/usr/bin/env bun
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the audit is a deterministic AST and graph traversal with explicit classification branches

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export const SOURCE_REACHABILITY_CLASSIFICATIONS = [
    "production-reachable",
    "production-type-only",
    "explicitly-build-only",
    "orphaned",
] as const;

export type SourceReachabilityClassification =
    (typeof SOURCE_REACHABILITY_CLASSIFICATIONS)[number];

type EdgeKind = "value" | "type";

type ImportEdge = {
    readonly from: string;
    readonly to: string;
    readonly kind: EdgeKind;
    readonly names: readonly string[];
    readonly reexport: boolean;
};

type ExportMapping = {
    readonly exportedName: string;
    readonly localName?: string;
    readonly target?: string;
    readonly targetName?: string;
    readonly kind: EdgeKind;
};

type ExportRecord = {
    readonly name: string;
    readonly kind: "value" | "type";
};

type ParsedModule = {
    readonly path: string;
    readonly exports: readonly ExportRecord[];
    readonly mappings: readonly ExportMapping[];
    readonly edges: readonly ImportEdge[];
};

type Reachability = {
    productionValue: boolean;
    productionType: boolean;
    build: boolean;
};

export type SourceReachabilityExport = {
    readonly name: string;
    readonly kind: "value" | "type";
    readonly classification: SourceReachabilityClassification;
};

export type SourceReachabilityModule = {
    readonly path: string;
    readonly classification: SourceReachabilityClassification;
    readonly productionValue: boolean;
    readonly productionType: boolean;
    readonly buildReachable: boolean;
    readonly exports: readonly SourceReachabilityExport[];
    readonly imports: readonly Omit<ImportEdge, "from">[];
};

export type SourceReachabilityReport = {
    readonly roots: {
        readonly production: string;
        readonly build: string;
    };
    readonly modules: readonly SourceReachabilityModule[];
    readonly unresolved: readonly string[];
    readonly orphanedModules: readonly string[];
    readonly orphanedExports: readonly string[];
};

const normalizePath = (path: string): string => path.split(sep).join("/");

const relativePath = (root: string, path: string): string =>
    normalizePath(relative(root, path));

const isRelativeSpecifier = (specifier: string): boolean =>
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../");

const resolveRelativeSource = (
    root: string,
    from: string,
    specifier: string,
): string | undefined => {
    if (!isRelativeSpecifier(specifier)) return undefined;
    const raw = resolve(dirname(from), specifier);
    const candidates = [
        raw,
        `${raw}.ts`,
        `${raw}.tsx`,
        `${raw}.d.ts`,
        resolve(raw, "index.ts"),
    ];
    for (const candidate of candidates) {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        const relativeCandidate = relativePath(root, candidate);
        if (relativeCandidate.startsWith("../")) return undefined;
        return candidate;
    }
    return undefined;
};

const stringLiteralValue = (value: ts.Expression): string | undefined =>
    ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? value.text
        : undefined;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
        (modifier) => modifier.kind === kind,
    ) ?? false;

const bindingNames = (name: ts.BindingName): readonly string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? bindingNames(element.name) : [],
    );
};

const declarationExport = (
    statement: ts.Statement,
): readonly ExportRecord[] => {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
    const kind: ExportRecord["kind"] =
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
            ? "type"
            : "value";
    if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.flatMap((declaration) =>
            bindingNames(declaration.name).map((name) => ({ name, kind })),
        );
    }
    if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
    ) {
        const name = statement.name?.getText() ?? "default";
        return [{ name, kind }];
    }
    return [];
};

const exportDeclarationNames = (
    declaration: ts.ExportDeclaration,
): readonly ExportMapping[] => {
    if (declaration.exportClause === undefined) {
        return [
            {
                exportedName: "*",
                targetName: "*",
                kind: declaration.isTypeOnly ? "type" : "value",
            },
        ];
    }
    if (ts.isNamespaceExport(declaration.exportClause)) {
        return [
            {
                exportedName: declaration.exportClause.name.text,
                targetName: "*",
                kind: declaration.isTypeOnly ? "type" : "value",
            },
        ];
    }
    return declaration.exportClause.elements.map((element) => ({
        exportedName: element.name.text,
        targetName: element.propertyName?.text ?? element.name.text,
        kind: declaration.isTypeOnly || element.isTypeOnly ? "type" : "value",
    }));
};

const importNames = (
    clause: ts.ImportClause,
): readonly { readonly name: string; readonly kind: EdgeKind }[] => {
    const names: { name: string; kind: EdgeKind }[] = [];
    const clauseKind: EdgeKind = clause.isTypeOnly ? "type" : "value";
    if (clause.name !== undefined) {
        names.push({ name: "default", kind: clauseKind });
    }
    if (clause.namedBindings === undefined) return names;
    if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push({ name: "*", kind: clauseKind });
        return names;
    }
    for (const element of clause.namedBindings.elements) {
        names.push({
            name: element.propertyName?.text ?? element.name.text,
            kind: clause.isTypeOnly || element.isTypeOnly ? "type" : "value",
        });
    }
    return names;
};

const addExport = (
    exports: Map<string, ExportRecord["kind"]>,
    record: ExportRecord,
): void => {
    const existing = exports.get(record.name);
    if (existing === undefined) {
        exports.set(record.name, record.kind);
        return;
    }
    if (existing === "value" || record.kind === existing) return;
    exports.set(record.name, "value");
};

const parseModule = (
    root: string,
    path: string,
    sourceText: string,
): {
    readonly parsed: ParsedModule;
    readonly unresolved: readonly string[];
} => {
    const sourceFile = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const exports = new Map<string, ExportRecord["kind"]>();
    const mappings: ExportMapping[] = [];
    const edges: ImportEdge[] = [];
    const unresolved: string[] = [];
    const edgeFor = (
        node: ts.Node,
        specifier: string,
        kind: EdgeKind,
        names: readonly string[],
        reexport: boolean,
    ): void => {
        const target = resolveRelativeSource(root, path, specifier);
        if (target === undefined) {
            if (isRelativeSpecifier(specifier)) {
                unresolved.push(
                    `${relativePath(root, path)} -> ${specifier} (${kind})`,
                );
            }
            return;
        }
        edges.push({
            from: relativePath(root, path),
            to: relativePath(root, target),
            kind,
            names: [...names].sort(),
            reexport,
        });
        void node;
    };

    for (const statement of sourceFile.statements) {
        for (const declaration of declarationExport(statement)) {
            addExport(exports, declaration);
        }
        if (ts.isImportDeclaration(statement)) {
            const specifier = stringLiteralValue(statement.moduleSpecifier);
            if (specifier === undefined) continue;
            if (statement.importClause === undefined) {
                edgeFor(statement, specifier, "value", [], false);
                continue;
            }
            const names = importNames(statement.importClause);
            for (const kind of ["value", "type"] as const) {
                const selected = names
                    .filter((entry) => entry.kind === kind)
                    .map((entry) => entry.name);
                if (selected.length > 0)
                    edgeFor(statement, specifier, kind, selected, false);
            }
            continue;
        }
        if (!ts.isExportDeclaration(statement)) continue;
        const specifier =
            statement.moduleSpecifier === undefined
                ? undefined
                : stringLiteralValue(statement.moduleSpecifier);
        const names = exportDeclarationNames(statement);
        if (specifier === undefined) {
            for (const mapping of names) {
                mappings.push({
                    ...mapping,
                    localName: mapping.targetName,
                });
                addExport(exports, {
                    name: mapping.exportedName,
                    kind: mapping.kind,
                });
            }
            continue;
        }
        for (const kind of ["value", "type"] as const) {
            const selected = names.filter((mapping) => mapping.kind === kind);
            if (selected.length === 0) continue;
            edgeFor(
                statement,
                specifier,
                kind,
                selected.map((mapping) => mapping.targetName ?? "*"),
                true,
            );
            for (const mapping of selected) {
                mappings.push({ ...mapping, target: specifier });
                addExport(exports, {
                    name: mapping.exportedName,
                    kind,
                });
            }
        }
    }

    for (const statement of sourceFile.statements) {
        if (!ts.isExportAssignment(statement)) continue;
        if (statement.isExportEquals) continue;
        addExport(exports, { name: "default", kind: "value" });
    }

    const visit = (node: ts.Node): void => {
        if (ts.isImportTypeNode(node)) {
            const argument = node.argument;
            const specifier =
                ts.isLiteralTypeNode(argument) &&
                ts.isStringLiteral(argument.literal)
                    ? argument.literal.text
                    : undefined;
            if (specifier !== undefined) {
                edgeFor(node, specifier, "type", [], false);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const parsed: ParsedModule = {
        path: relativePath(root, path),
        exports: [...exports.entries()]
            .map(([name, kind]) => ({ name, kind }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        mappings: mappings.sort((left, right) =>
            `${left.exportedName}:${left.target ?? ""}`.localeCompare(
                `${right.exportedName}:${right.target ?? ""}`,
            ),
        ),
        edges: edges.sort((left, right) =>
            `${left.to}:${left.kind}:${left.reexport}:${left.names.join(",")}`.localeCompare(
                `${right.to}:${right.kind}:${right.reexport}:${right.names.join(",")}`,
            ),
        ),
    };
    return { parsed, unresolved };
};

const modeForEdge = (
    reachability: Reachability,
    edge: ImportEdge,
): readonly ("production-value" | "production-type" | "build")[] => {
    const modes: ("production-value" | "production-type" | "build")[] = [];
    if (reachability.build) modes.push("build");
    if (reachability.productionValue) {
        modes.push(
            edge.kind === "value" ? "production-value" : "production-type",
        );
    } else if (reachability.productionType && edge.kind === "type") {
        modes.push("production-type");
    }
    return modes;
};

const classificationFor = (
    reachability: Reachability,
): SourceReachabilityClassification =>
    reachability.productionValue
        ? "production-reachable"
        : reachability.productionType
          ? "production-type-only"
          : reachability.build
            ? "explicitly-build-only"
            : "orphaned";

const addReachability = (
    reachability: Reachability,
    mode: "production-value" | "production-type" | "build",
): boolean => {
    const previous = { ...reachability };
    if (mode === "build") reachability.build = true;
    if (mode === "production-value") reachability.productionValue = true;
    if (mode === "production-type") reachability.productionType = true;
    return (
        previous.productionValue !== reachability.productionValue ||
        previous.productionType !== reachability.productionType ||
        previous.build !== reachability.build
    );
};

const sourceFiles = async (root: string): Promise<readonly string[]> => {
    const files: string[] = [];
    for await (const file of new Bun.Glob("src/**/*.ts").scan({
        cwd: root,
        absolute: true,
    })) {
        files.push(resolve(file));
    }
    return files.sort();
};

const usageClassification = (
    modes: ReadonlySet<"production-value" | "production-type" | "build">,
): SourceReachabilityClassification =>
    modes.has("production-value")
        ? "production-reachable"
        : modes.has("production-type")
          ? "production-type-only"
          : modes.has("build")
            ? "explicitly-build-only"
            : "orphaned";

/** Build the deterministic source/module/export reachability report. */
export const analyzeSourceReachability = async (
    repositoryRoot: string,
): Promise<SourceReachabilityReport> => {
    const root = resolve(repositoryRoot);
    const productionRoot = resolve(root, "index.ts");
    const buildRoot = resolve(root, "scripts/build.ts");
    const files = [productionRoot, buildRoot, ...(await sourceFiles(root))];
    const parsedByPath = new Map<string, ParsedModule>();
    const unresolved: string[] = [];
    for (const path of files) {
        const parsed = parseModule(root, path, readFileSync(path, "utf8"));
        parsedByPath.set(parsed.parsed.path, parsed.parsed);
        unresolved.push(...parsed.unresolved);
    }

    const reachability = new Map<string, Reachability>();
    for (const path of parsedByPath.keys()) {
        reachability.set(path, {
            productionValue: false,
            productionType: false,
            build: false,
        });
    }
    const productionRootPath = relativePath(root, productionRoot);
    const buildRootPath = relativePath(root, buildRoot);
    const queue: Array<{
        readonly path: string;
        readonly mode: "production-value" | "production-type" | "build";
    }> = [
        { path: productionRootPath, mode: "production-value" },
        { path: buildRootPath, mode: "build" },
    ];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) continue;
        const current = reachability.get(item.path);
        if (current === undefined || !addReachability(current, item.mode))
            continue;
        const module = parsedByPath.get(item.path);
        if (module === undefined) continue;
        for (const edge of module.edges) {
            const target = reachability.get(edge.to);
            if (target === undefined) continue;
            for (const mode of modeForEdge(current, edge)) {
                queue.push({
                    path: edge.to,
                    mode,
                });
            }
        }
    }

    const exportUsage = new Map<
        string,
        Map<string, Set<"production-value" | "production-type" | "build">>
    >();
    const demandQueue: Array<{
        readonly path: string;
        readonly name: string;
        readonly mode: "production-value" | "production-type" | "build";
    }> = [];
    const enqueueDemand = (
        path: string,
        name: string,
        mode: "production-value" | "production-type" | "build",
    ): void => {
        demandQueue.push({ path, name, mode });
    };

    for (const module of parsedByPath.values()) {
        const sourceReachability = reachability.get(module.path);
        if (sourceReachability === undefined) continue;
        for (const edge of module.edges) {
            if (edge.reexport) continue;
            for (const mode of modeForEdge(sourceReachability, edge)) {
                for (const name of edge.names)
                    enqueueDemand(edge.to, name, mode);
            }
        }
    }

    while (demandQueue.length > 0) {
        const demand = demandQueue.shift();
        if (demand === undefined) continue;
        const module = parsedByPath.get(demand.path);
        if (module === undefined) continue;
        let names =
            demand.name === "*"
                ? module.exports
                      .map((record) => record.name)
                      .filter((name) => name !== "*")
                : [demand.name];
        names = [...new Set(names)].sort();
        const usageByName = exportUsage.get(demand.path) ?? new Map();
        exportUsage.set(demand.path, usageByName);
        for (const name of names) {
            const modes = usageByName.get(name) ?? new Set();
            if (modes.has(demand.mode)) continue;
            modes.add(demand.mode);
            usageByName.set(name, modes);
            for (const mapping of module.mappings) {
                if (
                    mapping.exportedName !== name &&
                    mapping.exportedName !== "*"
                )
                    continue;
                if (mapping.target === undefined) continue;
                const target = resolveRelativeSource(
                    root,
                    resolve(root, module.path),
                    mapping.target,
                );
                if (target === undefined) continue;
                const targetPath = relativePath(root, target);
                const targetName = mapping.targetName ?? name;
                const targetMode =
                    mapping.kind === "type" &&
                    demand.mode === "production-value"
                        ? "production-type"
                        : demand.mode;
                enqueueDemand(
                    targetPath,
                    targetName === "*" ? "*" : targetName,
                    targetMode,
                );
            }
        }
    }

    const modules = [...parsedByPath.entries()]
        .filter(([path]) => path.startsWith("src/"))
        .map(([path, module]) => {
            const state = reachability.get(path) as Reachability;
            const usageByName = exportUsage.get(path) ?? new Map();
            const exports = module.exports.map((record) => ({
                name: record.name,
                kind: record.kind,
                classification: usageClassification(
                    usageByName.get(record.name) ?? new Set(),
                ),
            }));
            return {
                path,
                classification: classificationFor(state),
                productionValue: state.productionValue,
                productionType: state.productionType,
                buildReachable: state.build,
                exports: exports.sort((left, right) =>
                    left.name.localeCompare(right.name),
                ),
                imports: module.edges.map(({ from: _from, ...edge }) => edge),
            } satisfies SourceReachabilityModule;
        })
        .sort((left, right) => left.path.localeCompare(right.path));

    const orphanedModules = modules
        .filter((module) => module.classification === "orphaned")
        .map((module) => module.path);
    const orphanedExports = modules.flatMap((module) =>
        module.exports
            .filter((record) => record.classification === "orphaned")
            .map((record) => `${module.path}#${record.name}`),
    );
    const sortedUnresolved = [...new Set(unresolved)].sort();
    return {
        roots: {
            production: productionRootPath,
            build: buildRootPath,
        },
        modules,
        unresolved: sortedUnresolved,
        orphanedModules,
        orphanedExports,
    };
};

const main = async (): Promise<void> => {
    const report = await analyzeSourceReachability(
        resolve(import.meta.dir, ".."),
    );
    if (process.argv.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        for (const module of report.modules) {
            console.log(`${module.classification}\t${module.path}`);
            for (const record of module.exports) {
                console.log(
                    `  export\t${record.classification}\t${record.kind}\t${record.name}`,
                );
            }
        }
        if (report.unresolved.length > 0) {
            console.error("Unresolved relative imports:");
            for (const item of report.unresolved) console.error(`  ${item}`);
        }
    }
    if (report.unresolved.length > 0) {
        throw new Error(
            `Source reachability audit found ${report.unresolved.length} unresolved relative import(s).`,
        );
    }
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}