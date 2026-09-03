/**
 * Read-only standalone release target query API.
 *
 * Built on the canonical manifest at `targets/standalone-targets.json` through
 * `standalone-targets.ts`: every entry point parses and exact-target-validates
 * the entire manifest before exposing anything, and successful results are the
 * validated manifest records with every field preserved (`id`,
 * `releaseAssetName`, `os`, `arch`, `bunCompileTarget`, `targetTriple`,
 * `binaryFormat`, `runner`, `bunVersion`, `dockerPlatform`).
 *
 * A client exposes two operations:
 * - `list()` — the fully validated manifest as a readonly catalog.
 * - `query(selector)` — resolve either a stable `id` or a complete `os` +
 *   `arch` pair, normalizing case, surrounding whitespace, and common uname
 *   spellings (`Darwin`/`macOS` -> `darwin`, `Linux` -> `linux`,
 *   `x86_64`/`amd64` -> `x64`, `aarch64`/`arm64` -> `arm64`).
 *
 * Selectors that are unsupported, incomplete, ambiguous (an id mixed with a
 * partial os/arch pair), or mismatched (an id and a complete os/arch pair
 * resolving to different targets) are rejected with typed errors. An id
 * combined with the complete pair of the same target is accepted as a
 * cross-check and returns that target.
 */
import { RalphieError } from "../shared/error.ts";
import {
    loadStandaloneTargets,
    parseStandaloneTargets,
    type StandaloneTarget,
    type StandaloneTargets,
} from "./standalone-targets.ts";

/**
 * A target lookup: either a stable manifest `id` or a complete `os` + `arch`
 * pair, e.g. from `process.platform`/`process.arch` or uname output.
 */
export type StandaloneTargetSelector =
    | { readonly id: string }
    | { readonly os: string; readonly arch: string };

/** Read-only catalog and query surface over a validated standalone manifest. */
export type StandaloneTargetQueryClient = {
    /** The fully validated manifest in canonical order; never modified. */
    readonly list: () => readonly StandaloneTarget[];
    /** Resolve a target by stable id or complete os/arch pair. */
    readonly query: (selector: StandaloneTargetSelector) => StandaloneTarget;
};

/** A selector names an id, os, or arch value the manifest does not support. */
export class UnsupportedTargetSelectorError extends RalphieError {
    override readonly _tag = "UnsupportedTargetSelectorError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "UnsupportedTargetSelectorError";
    }
}

/** A selector provides neither an `id` nor a complete `os`/`arch` pair. */
export class IncompleteTargetSelectorError extends RalphieError {
    override readonly _tag = "IncompleteTargetSelectorError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "IncompleteTargetSelectorError";
    }
}

/** A selector mixes an `id` with a partial `os`/`arch` pair. */
export class AmbiguousTargetSelectorError extends RalphieError {
    override readonly _tag = "AmbiguousTargetSelectorError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "AmbiguousTargetSelectorError";
    }
}

/** An `id` and a complete `os`/`arch` pair in one selector disagree. */
export class MismatchedTargetSelectorError extends RalphieError {
    override readonly _tag = "MismatchedTargetSelectorError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "MismatchedTargetSelectorError";
    }
}

/**
 * Well-known os spellings that normalize to a canonical manifest `os`. The
 * canonical `os` values themselves are always accepted identity aliases; these
 * are the extra spellings (e.g. `uname -s` output) that must also resolve.
 */
export const OS_ALIASES = {
    macos: "darwin",
} as const;

/**
 * Well-known arch spellings that normalize to a canonical manifest `arch`. The
 * canonical `arch` values themselves are always accepted identity aliases;
 * these are the extra spellings (e.g. `uname -m` output) that must also
 * resolve.
 */
export const ARCH_ALIASES = {
    aarch64: "arm64",
    x86_64: "x64",
    amd64: "x64",
} as const;

/** Case-fold and trim a selector value before alias resolution. */
const normalizeSelectorValue = (value: string): string =>
    value.trim().toLowerCase();

/** Map canonical manifest values and their accepted aliases to canonicals. */
const buildAliases = (
    targets: StandaloneTargets,
    field: "os" | "arch",
    aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> => {
    const map = new Map<string, string>();
    for (const target of targets) map.set(target[field], target[field]);
    for (const [alias, canonical] of Object.entries(aliases)) {
        map.set(alias, canonical);
    }
    return map;
};

/** Human-readable list of supported values with their aliases, e.g. `arm64 (aarch64)`. */
const describeSupported = (aliases: ReadonlyMap<string, string>): string =>
    [...new Set(aliases.values())]
        .map((canonical) => {
            const synonyms = [...aliases.entries()]
                .filter(
                    ([alias, mapped]) =>
                        mapped === canonical && alias !== canonical,
                )
                .map(([alias]) => alias)
                .sort();
            return synonyms.length === 0
                ? canonical
                : `${canonical} (${synonyms.join(", ")})`;
        })
        .join(", ");

const describeValue = (value: unknown): string => {
    if (typeof value === "string") return JSON.stringify(value);
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
};

type SelectorParts = {
    readonly id: string | undefined;
    readonly os: string | undefined;
    readonly arch: string | undefined;
};

const stringPartOf = (
    record: Readonly<Record<string, unknown>>,
    key: "id" | "os" | "arch",
): string | undefined => {
    if (!(key in record)) return undefined;
    const value = record[key];
    if (typeof value !== "string") {
        throw new UnsupportedTargetSelectorError({
            message: `Target selector '${key}' must be a string; received ${describeValue(value)}.`,
        });
    }
    return value;
};

const selectorPartsOf = (selector: unknown): SelectorParts => {
    if (
        typeof selector !== "object" ||
        selector === null ||
        Array.isArray(selector)
    ) {
        throw new IncompleteTargetSelectorError({
            message: `Target selector must be an object providing an 'id' or both 'os' and 'arch'; received ${describeValue(selector)}.`,
        });
    }
    const record = selector as Readonly<Record<string, unknown>>;
    if (!("id" in record) && !("os" in record) && !("arch" in record)) {
        throw new IncompleteTargetSelectorError({
            message:
                "Target selector must provide either an 'id' or both 'os' and 'arch'; none were provided.",
        });
    }
    return {
        id: stringPartOf(record, "id"),
        os: stringPartOf(record, "os"),
        arch: stringPartOf(record, "arch"),
    };
};

const resolveById = (
    targets: StandaloneTargets,
    id: string,
): StandaloneTarget => {
    const normalized = normalizeSelectorValue(id);
    const target = targets.find((candidate) => candidate.id === normalized);
    if (target === undefined) {
        throw new UnsupportedTargetSelectorError({
            message: `Unsupported target id ${describeValue(id)}; supported ids are ${targets
                .map((candidate) => candidate.id)
                .join(", ")}.`,
        });
    }
    return target;
};

const resolveByPlatform = (
    targets: StandaloneTargets,
    osAliases: ReadonlyMap<string, string>,
    archAliases: ReadonlyMap<string, string>,
    os: string,
    arch: string,
): StandaloneTarget => {
    const canonicalOs = osAliases.get(normalizeSelectorValue(os));
    if (canonicalOs === undefined) {
        throw new UnsupportedTargetSelectorError({
            message: `Unsupported target os ${describeValue(os)}; supported values are ${describeSupported(osAliases)}.`,
        });
    }
    const canonicalArch = archAliases.get(normalizeSelectorValue(arch));
    if (canonicalArch === undefined) {
        throw new UnsupportedTargetSelectorError({
            message: `Unsupported target arch ${describeValue(arch)}; supported values are ${describeSupported(archAliases)}.`,
        });
    }
    const target = targets.find(
        (candidate) =>
            candidate.os === canonicalOs && candidate.arch === canonicalArch,
    );
    // Manifest validation guarantees every canonical os/arch pair appears
    // exactly once, so this is defensive only.
    if (target === undefined) {
        throw new MismatchedTargetSelectorError({
            message: `No standalone target matches os/arch '${canonicalOs}'/'${canonicalArch}'.`,
        });
    }
    return target;
};

const resolvePlatformFor = (
    targets: StandaloneTargets,
    osAliases: ReadonlyMap<string, string>,
    archAliases: ReadonlyMap<string, string>,
    parts: Pick<SelectorParts, "os" | "arch">,
): StandaloneTarget =>
    resolveByPlatform(
        targets,
        osAliases,
        archAliases,
        parts.os as string,
        parts.arch as string,
    );

const queryById = (
    targets: StandaloneTargets,
    osAliases: ReadonlyMap<string, string>,
    archAliases: ReadonlyMap<string, string>,
    id: string,
    parts: Pick<SelectorParts, "os" | "arch">,
): StandaloneTarget => {
    if (parts.os !== undefined || parts.arch !== undefined) {
        if (parts.os === undefined || parts.arch === undefined) {
            throw new AmbiguousTargetSelectorError({
                message: `Target selector mixes id ${describeValue(id)} with a partial 'os'/'arch' pair; provide either the id or the complete pair.`,
            });
        }
        const byId = resolveById(targets, id);
        const byPlatform = resolvePlatformFor(
            targets,
            osAliases,
            archAliases,
            parts,
        );
        if (byId.id !== byPlatform.id) {
            throw new MismatchedTargetSelectorError({
                message: `Target selector components disagree: id ${describeValue(id)} resolves to '${byId.id}' but os/arch '${parts.os}'/'${parts.arch}' resolves to '${byPlatform.id}'.`,
            });
        }
        return byId;
    }
    return resolveById(targets, id);
};

const fromValidatedTargets = (
    targets: StandaloneTargets,
): StandaloneTargetQueryClient => {
    for (const target of targets) Object.freeze(target);
    Object.freeze(targets);

    const osAliases = buildAliases(targets, "os", OS_ALIASES);
    const archAliases = buildAliases(targets, "arch", ARCH_ALIASES);

    const query = (selector: StandaloneTargetSelector): StandaloneTarget => {
        const parts = selectorPartsOf(selector);

        if (parts.id !== undefined) {
            return queryById(targets, osAliases, archAliases, parts.id, parts);
        }
        if (parts.os === undefined || parts.arch === undefined) {
            throw new IncompleteTargetSelectorError({
                message: `Target selector must provide both 'os' and 'arch'; missing '${parts.os === undefined ? "os" : "arch"}'.`,
            });
        }
        return resolvePlatformFor(targets, osAliases, archAliases, parts);
    };

    return { list: () => targets, query };
};

/**
 * Parse and exact-target-validate the given manifest value, then return a
 * read-only query client over it. Malformed records, non-canonical fields,
 * duplicate/lost ids, and ordering violations throw here before any list or
 * query can run. The value may come from `loadStandaloneTargets` or from a
 * test fixture.
 */
export const createStandaloneTargetQueryClient = (
    value: unknown,
): StandaloneTargetQueryClient =>
    fromValidatedTargets(parseStandaloneTargets(value));

/**
 * Load, parse, and exact-target-validate the manifest from `path` (defaults to
 * the canonical `targets/standalone-targets.json`), then return a read-only
 * query client over it.
 */
export const loadStandaloneTargetQueryClient = async (
    path?: string,
): Promise<StandaloneTargetQueryClient> =>
    fromValidatedTargets(await loadStandaloneTargets(path));