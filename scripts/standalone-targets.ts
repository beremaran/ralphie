#!/usr/bin/env bun

/**
 * Standalone Bun-invokable release target command (`bun run targets`).
 *
 * A side-effect-free query/generate/check surface over the canonical
 * standalone target manifest (`targets/standalone-targets.json`, overridable
 * with `--manifest <path>` for isolated tests) built exclusively on the
 * read-only query API and the deterministic serializers/renderers in
 * `src/targets/`. It requires no credentials and never touches Git or GitHub.
 *
 * Modes (as invoked through the package script):
 *
 * - `bun run targets -- query --id <stable-id>` — print one complete target
 *   record, or
 * - `bun run targets -- query --os <os> --arch <arch>` — resolve the
 *   OS/architecture pair through the query API (aliases accepted) and print
 *   the matching complete record.
 * - `bun run targets -- generate --format <format> [options] --output <file>`
 *   where `<format>` is `json`, `github-matrix`, `posix`, `homebrew`, or
 *   `documentation`.
 * - `bun run targets -- check --format <format> [options] --file <file>` —
 *   byte-exact comparison against the rendered document; the checked file is
 *   never rewritten.
 *
 * Every document uses one deterministic byte contract: UTF-8 without a BOM,
 * LF line endings only, two-space JSON indentation, object keys sorted
 * lexicographically at every depth, and exactly one final newline. `check`
 * compares those exact bytes (including key order, line endings, and the
 * final newline) and succeeds only on an exact match.
 *
 * The whole manifest is loaded, validated, and rendered in memory before any
 * stdout is written or any output file is touched. `generate` writes through
 * a temporary file in the destination directory and renames only after the
 * complete document has been written, so schema or exact-target validation
 * errors leave no partial output and preserve an existing destination.
 * Invalid arguments and validation errors go to stderr with a nonzero exit
 * status and no generated stdout.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { RalphieError } from "../src/shared/error.ts";
import {
    loadStandaloneTargetQueryClient,
    type StandaloneTargetSelector,
} from "../src/targets/standalone-target-query.ts";
import {
    renderDocumentationTargets,
    renderHomebrewTargetRows,
    renderPosixInstallerMapping,
    renderPosixInstallerTarget,
} from "../src/targets/standalone-target-renderers.ts";
import {
    serializeStandaloneJsonDocument,
    serializeStandaloneTargetMatrix,
    serializeStandaloneTargets,
} from "../src/targets/standalone-target-serializer.ts";
import type { StandaloneTargets } from "../src/targets/standalone-targets.ts";

/** The six document formats the targets command can generate and check. */
export const STANDALONE_TARGETS_FORMATS = [
    "json",
    "github-matrix",
    "posix",
    "posix-mapping",
    "homebrew",
    "documentation",
] as const;

export type StandaloneTargetsDocumentFormat =
    (typeof STANDALONE_TARGETS_FORMATS)[number];

/** A request to render one complete target document in memory. */
export type StandaloneTargetsDocumentRequest = {
    readonly format: StandaloneTargetsDocumentFormat;
    /** Plain `<major>.<minor>.<patch>`; required only for `homebrew`. */
    readonly version?: string;
    /** Complete `os`/`arch` pair; required only for `posix`. */
    readonly selector?: StandaloneTargetSelector;
    /** Manifest override for isolated tests; defaults to the canonical one. */
    readonly manifestPath?: string;
};

/** A request to render one complete target record (query mode). */
export type StandaloneTargetsQueryRequest = {
    readonly selector: StandaloneTargetSelector;
    readonly manifestPath?: string;
};

export type StandaloneTargetsGenerateRequest =
    StandaloneTargetsDocumentRequest & {
        readonly outputPath: string;
    };

export type StandaloneTargetsCheckRequest = StandaloneTargetsDocumentRequest & {
    readonly filePath: string;
};

/** A parsed invocation of the targets command line. */
export type StandaloneTargetsInvocation =
    | {
          readonly mode: "query";
          readonly request: StandaloneTargetsQueryRequest;
      }
    | {
          readonly mode: "generate";
          readonly request: StandaloneTargetsGenerateRequest;
      }
    | {
          readonly mode: "check";
          readonly request: StandaloneTargetsCheckRequest;
      }
    | { readonly mode: "help" };

/** The byte-exact file comparison result of a `check` request. */
export type StandaloneTargetsCheckOutcome =
    | { readonly status: "match" }
    | { readonly status: "mismatch"; readonly reason: string };

/** Any argument, request, or execution failure surfaced by the targets command. */
export class StandaloneTargetsCommandError extends RalphieError {
    override readonly _tag = "StandaloneTargetsCommandError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "StandaloneTargetsCommandError";
    }
}

const requireNoVersion = (
    format: StandaloneTargetsDocumentFormat,
    version: string | undefined,
): void => {
    if (version !== undefined) {
        throw new StandaloneTargetsCommandError({
            message: `Format '${format}' does not take a version; only 'homebrew' does.`,
        });
    }
};

const requireNoSelector = (
    format: StandaloneTargetsDocumentFormat,
    selector: StandaloneTargetSelector | undefined,
): void => {
    if (selector !== undefined) {
        throw new StandaloneTargetsCommandError({
            message: `Format '${format}' does not take a target selector; only 'posix' selects by OS/architecture.`,
        });
    }
};

const requireHomebrewVersion = (
    request: StandaloneTargetsDocumentRequest,
): string => {
    requireNoSelector(request.format, request.selector);
    const version = request.version;
    if (version === undefined) {
        throw new StandaloneTargetsCommandError({
            message: "Format 'homebrew' requires a version like 0.1.2.",
        });
    }
    return version;
};

const requirePosixSelector = (
    request: StandaloneTargetsDocumentRequest,
): { readonly os: string; readonly arch: string } => {
    requireNoVersion(request.format, request.version);
    const selector = request.selector;
    if (
        selector === undefined ||
        !("os" in selector) ||
        !("arch" in selector)
    ) {
        throw new StandaloneTargetsCommandError({
            message: "Format 'posix' requires an os and arch selector.",
        });
    }
    return { os: selector.os, arch: selector.arch };
};

const assertDocumentRequest = (
    request: StandaloneTargetsDocumentRequest,
): void => {
    if (request.format === "homebrew") {
        requireHomebrewVersion(request);
        return;
    }
    if (request.format === "posix") {
        requirePosixSelector(request);
        return;
    }
    requireNoVersion(request.format, request.version);
    requireNoSelector(request.format, request.selector);
};

const renderDocument = (
    request: StandaloneTargetsDocumentRequest,
    catalog: StandaloneTargets,
): string => {
    switch (request.format) {
        case "json":
            return serializeStandaloneTargets(catalog);
        case "github-matrix":
            return serializeStandaloneTargetMatrix(catalog);
        case "documentation":
            return serializeStandaloneJsonDocument(
                renderDocumentationTargets(catalog),
            );
        case "homebrew":
            return serializeStandaloneJsonDocument(
                renderHomebrewTargetRows(
                    catalog,
                    requireHomebrewVersion(request),
                ),
            );
        case "posix": {
            const selector = requirePosixSelector(request);
            return serializeStandaloneJsonDocument(
                renderPosixInstallerTarget(catalog, selector.os, selector.arch),
            );
        }
        case "posix-mapping":
            return serializeStandaloneJsonDocument(
                renderPosixInstallerMapping(catalog),
            );
    }
};

/**
 * Load, validate, and render the requested document entirely in memory.
 * Throws before any output exists for invalid requests, malformed or
 * non-canonical manifests, unsupported selectors, or invalid versions.
 * Never writes to stdout or any file.
 */
export const renderStandaloneTargetsDocument = async (
    request: StandaloneTargetsDocumentRequest,
): Promise<string> => {
    assertDocumentRequest(request);
    const client = await loadStandaloneTargetQueryClient(request.manifestPath);
    return renderDocument(request, client.list());
};

/**
 * Resolve one target record by stable `id` or complete `os`/`arch` pair and
 * render it as a deterministic JSON document. Never writes to stdout or any
 * file.
 */
export const renderStandaloneTargetQueryDocument = async (
    request: StandaloneTargetsQueryRequest,
): Promise<string> => {
    const client = await loadStandaloneTargetQueryClient(request.manifestPath);
    return serializeStandaloneJsonDocument(client.query(request.selector));
};

/**
 * Render the requested document and write it to `outputPath` atomically:
 * the temporary file is written and renamed only after the entire document
 * succeeded, so validation errors never leave partial output and always
 * preserve an existing destination. Returns the rendered document.
 */
export const generateStandaloneTargetsDocument = async (
    request: StandaloneTargetsGenerateRequest,
): Promise<string> => {
    const document = await renderStandaloneTargetsDocument(request);
    const outputPath = request.outputPath;
    const directory = dirname(outputPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
        directory,
        `.${basename(outputPath)}.${randomUUID()}.tmp`,
    );
    try {
        await writeFile(temporaryPath, document, {
            encoding: "utf8",
            flag: "wx",
        });
        await rename(temporaryPath, outputPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
    return document;
};

const byteDifferenceOffset = (
    expected: Uint8Array,
    actual: Uint8Array,
): number => {
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
        if (expected[index] !== actual[index]) return index;
    }
    return length;
};

const byteArraysEqual = (expected: Uint8Array, actual: Uint8Array): boolean => {
    if (expected.length !== actual.length) return false;
    return byteDifferenceOffset(expected, actual) === expected.length;
};

const hexByte = (bytes: Uint8Array, offset: number): string => {
    const byte = bytes[offset];
    return byte === undefined
        ? "<out of range>"
        : `0x${byte.toString(16).padStart(2, "0")}`;
};

const describeCheckMismatch = (
    expected: Uint8Array,
    actual: Uint8Array,
): string => {
    const offset = byteDifferenceOffset(expected, actual);
    if (expected.length !== actual.length) {
        return `expected ${expected.length} bytes, found ${actual.length}; first difference at byte ${offset} (expected ${hexByte(expected, offset)}, found ${hexByte(actual, offset)})`;
    }
    return `bytes differ at offset ${offset}: expected ${hexByte(expected, offset)}, found ${hexByte(actual, offset)}`;
};

/**
 * Render the requested document, read `filePath`, and compare exact bytes
 * (key order, LF line endings, and the final newline included). Succeeds only
 * on an exact match and never writes to or rewrites the checked file.
 */
export const checkStandaloneTargetsFile = async (
    request: StandaloneTargetsCheckRequest,
): Promise<StandaloneTargetsCheckOutcome> => {
    const document = await renderStandaloneTargetsDocument(request);
    const expected = new TextEncoder().encode(document);
    let actual: Uint8Array;
    try {
        actual = await readFile(request.filePath);
    } catch {
        return {
            status: "mismatch",
            reason: `file '${request.filePath}' cannot be read`,
        };
    }
    if (!byteArraysEqual(expected, actual)) {
        return {
            status: "mismatch",
            reason: describeCheckMismatch(expected, actual),
        };
    }
    return { status: "match" };
};

const USAGE = [
    "Usage:",
    "  bun run targets -- query --id <stable-id> [--manifest <path>]",
    "  bun run targets -- query --os <os> --arch <arch> [--manifest <path>]",
    "  bun run targets -- generate --format <json|github-matrix|posix|posix-mapping|homebrew|documentation>",
    "      [--version <version>] [--os <os> --arch <arch>] --output <file> [--manifest <path>]",
    "  bun run targets -- check --format <json|github-matrix|posix|posix-mapping|homebrew|documentation>",
    "      [--version <version>] [--os <os> --arch <arch>] --file <file> [--manifest <path>]",
    "",
    "Modes:",
    "  query      Print one complete target record as deterministic JSON.",
    "  generate   Render a complete document and write it atomically to --output.",
    "  check      Byte-compare a document against --file; never rewrites it.",
    "",
    "Formats:",
    "  json           Complete catalog array (default manifest; no selector).",
    "  github-matrix  GitHub Actions matrix object with an include array.",
    "  posix          The single record selected by --os/--arch (installer mapping).",
    "  posix-mapping  The POSIX installer mapping doc (alias tables + all records);",
    "                 checked in at targets/posix-installer-targets.json.",
    "  homebrew       Homebrew rows sorted by id; requires --version.",
    "  documentation  Complete catalog sorted by id for documentation consumers.",
    "",
    "Every document: UTF-8 without BOM, LF endings, two-space indentation,",
    "keys sorted lexicographically, exactly one final newline.",
].join("\n");

const printUsage = (): void => {
    console.log(USAGE);
};

type FlagMap = ReadonlyMap<string, string | true>;

type ParsedArguments = {
    readonly flags: FlagMap;
    readonly positionals: readonly string[];
};

const parseArguments = (argv: readonly string[]): ParsedArguments => {
    const flags = new Map<string, string | true>();
    const positionals: string[] = [];
    let index = 0;
    while (index < argv.length) {
        const argument = argv[index] as string;
        if (!argument.startsWith("--")) {
            positionals.push(argument);
            index += 1;
            continue;
        }
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith("--")) {
            flags.set(argument, value);
            index += 2;
        } else {
            flags.set(argument, true);
            index += 1;
        }
    }
    return { flags, positionals };
};

const flagValue = (flags: FlagMap, flag: string, command: string): string => {
    const value = flags.get(flag);
    if (value === undefined || value === true) {
        throw new StandaloneTargetsCommandError({
            message: `Option '${flag}' requires a value for '${command}'.`,
        });
    }
    return value;
};

const optionalFlagValue = (
    flags: FlagMap,
    flag: string,
    command: string,
): string | undefined => {
    if (!flags.has(flag)) return undefined;
    return flagValue(flags, flag, command);
};

const assertOnlyKnownFlags = (
    flags: FlagMap,
    known: readonly string[],
    command: string,
): void => {
    for (const flag of flags.keys()) {
        if (!known.includes(flag)) {
            throw new StandaloneTargetsCommandError({
                message: `Unknown option '${flag}' for '${command}'; run 'bun run targets -- --help' for usage.`,
            });
        }
    }
};

const QUERY_FLAGS = ["--id", "--os", "--arch", "--manifest"] as const;
const DOCUMENT_FLAGS = [
    "--format",
    "--version",
    "--os",
    "--arch",
    "--manifest",
] as const;
const GENERATE_FLAGS = [...DOCUMENT_FLAGS, "--output"] as const;
const CHECK_FLAGS = [...DOCUMENT_FLAGS, "--file"] as const;

const isDocumentFormat = (
    value: string,
): value is StandaloneTargetsDocumentFormat =>
    STANDALONE_TARGETS_FORMATS.some((format) => format === value);

const parseQuery = (flags: FlagMap): StandaloneTargetsInvocation => {
    assertOnlyKnownFlags(flags, QUERY_FLAGS, "query");
    const manifestPath = optionalFlagValue(flags, "--manifest", "query");
    const hasId = flags.has("--id");
    const hasOs = flags.has("--os");
    const hasArch = flags.has("--arch");

    if (hasOs !== hasArch) {
        throw new StandaloneTargetsCommandError({
            message:
                "Options '--os' and '--arch' must be provided together for 'query'.",
        });
    }
    if (hasId) {
        if (hasOs) {
            throw new StandaloneTargetsCommandError({
                message:
                    "Query resolves by either '--id' or '--os'/'--arch', not both.",
            });
        }
        return {
            mode: "query",
            request: {
                selector: { id: flagValue(flags, "--id", "query") },
                manifestPath,
            },
        };
    }
    if (!hasOs) {
        throw new StandaloneTargetsCommandError({
            message:
                "Query requires '--id <stable-id>' or '--os <os> --arch <arch>'.",
        });
    }
    return {
        mode: "query",
        request: {
            selector: {
                os: flagValue(flags, "--os", "query"),
                arch: flagValue(flags, "--arch", "query"),
            },
            manifestPath,
        },
    };
};

const parseDocumentCommand = (
    flags: FlagMap,
    command: "generate" | "check",
): StandaloneTargetsDocumentRequest => {
    const formatValue = flagValue(flags, "--format", command);
    if (!isDocumentFormat(formatValue)) {
        throw new StandaloneTargetsCommandError({
            message: `Unsupported format '${formatValue}' for '${command}'; expected ${STANDALONE_TARGETS_FORMATS.join("|")}.`,
        });
    }
    const version = optionalFlagValue(flags, "--version", command);
    const hasOs = flags.has("--os");
    const hasArch = flags.has("--arch");
    if (hasOs !== hasArch) {
        throw new StandaloneTargetsCommandError({
            message: `Options '--os' and '--arch' must be provided together for '${command}'.`,
        });
    }
    if (formatValue !== "posix") {
        if (hasOs) {
            throw new StandaloneTargetsCommandError({
                message: `Format '${formatValue}' does not take '--os'/'--arch'; only 'posix' selects by OS/architecture.`,
            });
        }
        if (formatValue !== "homebrew" && version !== undefined) {
            throw new StandaloneTargetsCommandError({
                message: `Format '${formatValue}' does not take '--version'; only 'homebrew' does.`,
            });
        }
    } else if (version !== undefined) {
        throw new StandaloneTargetsCommandError({
            message: "Format 'posix' does not take '--version'.",
        });
    }
    return {
        format: formatValue,
        version,
        selector:
            formatValue === "posix"
                ? {
                      os: flagValue(flags, "--os", command),
                      arch: flagValue(flags, "--arch", command),
                  }
                : undefined,
        manifestPath: optionalFlagValue(flags, "--manifest", command),
    };
};

const parseGenerate = (flags: FlagMap): StandaloneTargetsInvocation => {
    const command = "generate";
    assertOnlyKnownFlags(flags, GENERATE_FLAGS, command);
    const options = parseDocumentCommand(flags, command);
    return {
        mode: "generate",
        request: {
            ...options,
            outputPath: flagValue(flags, "--output", command),
        },
    };
};

const parseCheck = (flags: FlagMap): StandaloneTargetsInvocation => {
    const command = "check";
    assertOnlyKnownFlags(flags, CHECK_FLAGS, command);
    const options = parseDocumentCommand(flags, command);
    return {
        mode: "check",
        request: {
            ...options,
            filePath: flagValue(flags, "--file", command),
        },
    };
};

/**
 * Parse the targets command line (`query`, `generate`, `check`, or help).
 * Throws `StandaloneTargetsCommandError` for unknown commands, unknown or
 * missing options, and argument combinations a format cannot consume.
 */
export const parseStandaloneTargetsArgs = (
    argv: readonly string[],
): StandaloneTargetsInvocation => {
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
        return { mode: "help" };
    }
    const command = argv[0] as string;
    const { flags, positionals } = parseArguments(argv.slice(1));
    if (positionals.length > 0) {
        throw new StandaloneTargetsCommandError({
            message: `Unexpected positional argument '${positionals[0]}'; run 'bun run targets -- --help' for usage.`,
        });
    }
    switch (command) {
        case "query":
            return parseQuery(flags);
        case "generate":
            return parseGenerate(flags);
        case "check":
            return parseCheck(flags);
        default:
            throw new StandaloneTargetsCommandError({
                message: `Unknown command '${command}'; expected 'query', 'generate', or 'check'.`,
            });
    }
};

/**
 * Execute a parsed invocation and return the process exit code. Documents are
 * rendered in full (and generate writes are renamed) before any stdout is
 * written; argument, validation, selector, and check-mismatch failures go to
 * stderr with a nonzero exit code and no generated stdout.
 */
export const runStandaloneTargets = async (
    invocation: StandaloneTargetsInvocation,
): Promise<number> => {
    switch (invocation.mode) {
        case "help":
            printUsage();
            return 0;
        case "query": {
            const document = await renderStandaloneTargetQueryDocument(
                invocation.request,
            );
            process.stdout.write(document);
            return 0;
        }
        case "generate": {
            await generateStandaloneTargetsDocument(invocation.request);
            console.log(
                `Generated ${invocation.request.format} targets document: ${invocation.request.outputPath}`,
            );
            return 0;
        }
        case "check": {
            const outcome = await checkStandaloneTargetsFile(
                invocation.request,
            );
            if (outcome.status === "match") {
                console.log(
                    `Target document matches ${invocation.request.filePath}.`,
                );
                return 0;
            }
            console.error(
                `Target document does not match ${invocation.request.filePath}: ${outcome.reason}`,
            );
            return 1;
        }
    }
};

if (import.meta.main) {
    try {
        const invocation = parseStandaloneTargetsArgs(Bun.argv.slice(2));
        process.exitCode = await runStandaloneTargets(invocation);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}