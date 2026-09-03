/**
 * Deterministic standalone release target catalog and GitHub Actions matrix
 * serializers.
 *
 * Built on the canonical manifest at `targets/standalone-targets.json`
 * through the query API in `standalone-target-query.ts`: both entry points
 * take unknown input, parse and exact-target-validate it through the
 * canonical API (`createStandaloneTargetQueryClient`) *before* rendering
 * anything, and only then emit the complete document as one finished string.
 * Malformed or non-canonical manifests throw before any output string is
 * constructed, and the whole document is built in memory before it is
 * returned, so a caller can never observe or write partial output. A
 * previously validated catalog is also accepted and passed through the same
 * validation first.
 *
 * Documented shapes:
 * - Catalog JSON is a sorted array of complete target records. Every
 *   validated field (`id`, `releaseAssetName`, `os`, `arch`,
 *   `bunCompileTarget`, `targetTriple`, `binaryFormat`, `runner`,
 *   `bunVersion`, `dockerPlatform`) is preserved exactly — including a `null`
 *   `dockerPlatform` — and nothing is inferred, normalized, omitted, or
 *   added.
 * - Matrix JSON is an object with a single `include` array containing those
 *   same complete records, in the same order.
 *
 * Ordering: records are sorted lexicographically by stable `id`, and object
 * keys are sorted lexicographically at every depth of the document.
 *
 * Encoding contract (identical for both documents): UTF-8 without a BOM, LF
 * line endings only, two-space JSON indentation, and exactly one final
 * newline (`\n`, U+000A) at the end of the document. Consumer mappings
 * (POSIX installer target, Homebrew rows, documentation catalog) and the
 * standalone targets command share the same contract through
 * `serializeStandaloneJsonDocument`.
 */
import { createStandaloneTargetQueryClient } from "./standalone-target-query.ts";
import type {
    StandaloneTarget,
    StandaloneTargets,
} from "./standalone-targets.ts";

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

/** Validate unknown input through the canonical query API and return the catalog. */
const validatedCatalogOf = (value: unknown): StandaloneTargets =>
    createStandaloneTargetQueryClient(value).list();

/** Compare two target records by stable `id`, lexicographically. */
const compareStableIds = (
    left: StandaloneTarget,
    right: StandaloneTarget,
): number => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
};

/** Return the catalog with records sorted lexicographically by stable `id`. */
const sortCatalogById = (
    catalog: ReadonlyArray<StandaloneTarget>,
): StandaloneTarget[] => [...catalog].sort(compareStableIds);

/**
 * Return a deep copy of the value with object keys sorted lexicographically
 * at every depth (arrays keep their order).
 */
const sortKeysDeep = (value: unknown): JsonValue => {
    if (Array.isArray(value)) {
        return value.map((entry) => sortKeysDeep(entry));
    }
    if (value !== null && typeof value === "object") {
        const record = value as Readonly<Record<string, unknown>>;
        const sorted: Record<string, JsonValue> = {};
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortKeysDeep(record[key]);
        }
        return sorted;
    }
    return value as JsonPrimitive;
};

/**
 * Render the complete document: two-space JSON indentation, LF line endings,
 * and exactly one final newline. No BOM character is ever emitted.
 */
const renderJsonDocument = (value: unknown): string =>
    `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;

/**
 * Serialize the validated catalog as catalog JSON: a sorted array of complete
 * target records. Throws before producing any output if the input is
 * malformed or non-canonical.
 */
export const serializeStandaloneTargets = (value: unknown): string =>
    renderJsonDocument(sortCatalogById(validatedCatalogOf(value)));

/**
 * Serialize the validated catalog as GitHub Actions matrix JSON: an object
 * with an `include` array containing the same complete records. Throws before
 * producing any output if the input is malformed or non-canonical.
 */
export const serializeStandaloneTargetMatrix = (value: unknown): string =>
    renderJsonDocument({ include: sortCatalogById(validatedCatalogOf(value)) });

/**
 * Serialize any rendered value as one deterministic JSON document following
 * the same encoding contract as the catalog and matrix serializers:
 * two-space JSON indentation, object keys sorted lexicographically at every
 * depth, UTF-8 without a BOM, LF line endings only, and exactly one final
 * newline. Consumer-renderer outputs (`posix-installer-target`,
 * `homebrew-target-rows`, `target-documentation-catalog`) and the standalone
 * targets command render through this helper so every document variant
 * shares a single byte contract.
 */
export const serializeStandaloneJsonDocument = (value: unknown): string =>
    renderJsonDocument(sortKeysDeep(value));