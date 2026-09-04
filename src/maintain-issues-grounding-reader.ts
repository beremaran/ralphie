/**
 * Read-only local grounding for the prepared maintenance checkout.
 *
 * This module produces the immutable grounding value and the bounded guidance
 * bundle that the maintenance snapshot assembler pins its work to. It is the
 * maintenance-mode counterpart of the agent grounding path in
 * `issues/grounding.ts`, but it asks no model anything and never touches a
 * network: it reads only the prepared local repository.
 *
 * Grounding phase - three read-only git commands, in order, all forwarded to
 * the injected command runner with the abort signal:
 *
 *   1. `git symbolic-ref --short HEAD`   the symbolic branch. Unlike
 *      `rev-parse --abbrev-ref HEAD` this succeeds on an unborn branch, so a
 *      missing HEAD stays a distinct, typed condition instead of collapsing
 *      into the unreadable-repository case.
 *   2. `git rev-parse HEAD`              the selected branch HEAD commit
 *   3. `git status --porcelain=v1`       the working-tree cleanliness
 *
 * A branch mismatch, dirty checkout, missing HEAD, or unreadable repository is
 * returned as a typed `GroundingSkip` with a diagnostic detail - never
 * repaired. This module never runs checkout, reset, clean, fetch, commit, or
 * any other Git mutation, and it does not call the destructive repository
 * preparation service.
 *
 * Guidance phase - bounded, allowlisted files from the grounded checkout:
 * `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the
 * explicitly recognized legacy template `.github/ISSUE_TEMPLATE.md`, and files
 * directly under `.github/ISSUE_TEMPLATE/` with a recognized issue-template or
 * issue-form extension (`.md`, `.yml`, `.yaml`). Candidate paths are sorted
 * deterministically (UTF-16 code-unit order), per-file and aggregate byte
 * limits are enforced, omitted/truncated files are marked explicitly (the
 * metadata marker survives even a zero budget), absent optional files are
 * metadata entries rather than errors, path traversal and symlink escapes are
 * rejected, and nothing is ingested recursively and no external link is
 * followed. Every file read is bounded to `limit + 1` bytes and every result
 * is frozen before it leaves this module; no mutable filesystem handle or
 * buffer is retained.
 *
 * This module performs no network work and no Git, filesystem, or API writes.
 */
import { open, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { runGit } from "./git/run-git.ts";
import {
    createUnknownValue,
    type MaintainableUnknownValue,
} from "./maintain-issues-snapshot.ts";
import {
    CommandAbortedError,
    CommandRunnerLive,
    type CommandRunnerService,
} from "./process/command-runner.ts";
import { RalphieError } from "./shared/error.ts";

/** Stable truncation marker appended to retained content when a file is cut. */
export const GROUNDING_TRUNCATION_MARKER = "[truncated]";

/** Stable omission marker carried in metadata when content is omitted. */
export const GROUNDING_OMISSION_MARKER = "[omitted]";

const GROUNDING_TRUNCATION_MARKER_BYTES = Buffer.byteLength(
    GROUNDING_TRUNCATION_MARKER,
    "utf-8",
);
const GROUNDING_OMISSION_MARKER_BYTES = Buffer.byteLength(
    GROUNDING_OMISSION_MARKER,
    "utf-8",
);

/** Root-level guidance files recognized from the selected checkout. */
export const GUIDANCE_ROOT_FILES: ReadonlyArray<string> = Object.freeze([
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
]);

/** Explicitly recognized legacy single-file issue template location. */
export const GUIDANCE_EXPLICIT_TEMPLATE_FILE = ".github/ISSUE_TEMPLATE.md";

/** Recognized issue-template/form directory location. */
export const GUIDANCE_ISSUE_TEMPLATE_DIRECTORY = ".github/ISSUE_TEMPLATE";

/** Recognized issue-template/form file extensions under the template directory. */
export const GUIDANCE_ISSUE_TEMPLATE_EXTENSIONS: ReadonlyArray<string> =
    Object.freeze([".md", ".yml", ".yaml"]);

/** Default per-guidance-file byte limit. */
export const DEFAULT_GUIDANCE_PER_FILE_BYTE_LIMIT = 16 * 1024;

/** Default aggregate byte limit across all retained guidance content. */
export const DEFAULT_GUIDANCE_AGGREGATE_BYTE_LIMIT = 64 * 1024;

const VALID_GIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Validate one public guidance limit as a finite non-negative integer. Throws
 * a RangeError for NaN, infinities, negatives, and fractional values before
 * any byte budget is calculated. Zero is accepted and produces the
 * deterministic minimal forms defined by the projector.
 */
export const validateGuidanceLimit = (name: string, value: number): number => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new RangeError(
            `${name} must be a finite non-negative integer; received ${String(value)}.`,
        );
    }
    return value;
};

/** The immutable grounding value for a prepared checkout. */
export type RepositoryGrounding = {
    /** The selected branch, verified against the symbolic branch read. */
    readonly branch: string;
    /** The selected branch HEAD commit as reported by git. */
    readonly head: string;
    /** Invariant: a dirty checkout is always skipped, never grounded. */
    readonly clean: true;
    /** Invariant: grounding is captured without any checkout mutation. */
    readonly readOnly: true;
};

export type GroundingSkipReason =
    | "branch-mismatch"
    | "dirty-checkout"
    | "missing-head"
    | "unreadable-repository"
    | MaintainableUnknownValue;

/** Typed safe-skip outcome with a diagnostic reason. */
export type GroundingSkip = {
    readonly reason: GroundingSkipReason;
    readonly detail: string;
};

export type GroundingReadOutcome =
    | {
          readonly status: "grounded";
          readonly grounding: RepositoryGrounding;
          readonly guidance: GuidanceBundle;
      }
    | {
          readonly status: "skipped";
          readonly skip: GroundingSkip;
      };

/**
 * Normalize a grounding skip reason, keeping unknown future values explicit
 * instead of throwing, mirroring the snapshot contract's skip vocabulary.
 */
export const normalizeGroundingSkipReason = (
    value: unknown,
): GroundingSkipReason => {
    if (
        value === "branch-mismatch" ||
        value === "dirty-checkout" ||
        value === "missing-head" ||
        value === "unreadable-repository"
    ) {
        return value;
    }
    return createUnknownValue(value) as GroundingSkipReason;
};

/** Availability of one guidance file in the bounded bundle. */
export type GuidanceFileState =
    | "available"
    | "absent"
    | "omitted"
    | "unavailable";

/** One bounded guidance file projection. */
export type GuidanceFile = {
    /** Repository-relative path, always posix-separated. */
    readonly path: string;
    readonly state: GuidanceFileState;
    /** Bounded projection; empty for absent, omitted, and unavailable files. */
    readonly content: string;
    /** Retained content bytes (UTF-8); always contributes to the aggregate. */
    readonly byteLength: number;
    /** True when the retained content was cut by the per-file byte limit. */
    readonly truncated: boolean;
    /** True when content existed but was not retained. */
    readonly omitted: boolean;
    /** Stable metadata marker; null when nothing was cut or dropped. */
    readonly marker: string | null;
    /** Diagnostic detail for omitted/unavailable files; otherwise null. */
    readonly detail: string | null;
    /**
     * Original file bytes when the file fit the bounded read, and null when
     * the file was truncated (the exact size is not retained).
     */
    readonly originalByteLength: number | null;
    /** The per-file byte limit applied to this entry. */
    readonly limit: number;
};

/** The deterministic, bounded guidance bundle. */
export type GuidanceBundle = {
    /** Every allowlisted candidate, sorted deterministically. */
    readonly files: ReadonlyArray<GuidanceFile>;
    /** Retained content bytes across all entries. */
    readonly totalByteLength: number;
    /** True when any entry was truncated. */
    readonly truncated: boolean;
    /** True when any entry was omitted. */
    readonly omitted: boolean;
    readonly perFileByteLimit: number;
    readonly aggregateByteLimit: number;
};

export type GroundingReaderInput = {
    readonly repositoryPath: string;
    /** The prepared branch the grounding must match. */
    readonly branch: string;
    readonly signal?: AbortSignal;
};

export type GuidanceReadOptions = {
    readonly perFileByteLimit?: number;
    readonly aggregateByteLimit?: number;
};

/** The caller cancelled a grounding read. */
export class GroundingReadAbortedError extends RalphieError {
    override readonly _tag = "GroundingReadAbortedError" as const;

    constructor(input: { readonly cause?: unknown }) {
        super({
            message: "Grounding read was aborted.",
            ...(input.cause === undefined ? {} : { cause: input.cause }),
        });
        this.name = "GroundingReadAbortedError";
    }
}

/** Read-only filesystem surface used by the grounding reader. */
export type GroundingFileSystemService = {
    readonly realpath: (path: string) => Promise<string>;
    readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
    /** Read at most `maxBytes` bytes from the start of `path`. */
    readonly readFileBounded: (
        path: string,
        maxBytes: number,
    ) => Promise<Buffer>;
};

const readBounded = async (path: string, maxBytes: number): Promise<Buffer> => {
    const handle = await open(path, "r");
    try {
        const target = new Uint8Array(maxBytes);
        const { bytesRead } = await handle.read(target, 0, maxBytes, 0);
        return Buffer.from(target.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
};

export const GroundingFileSystemLive: GroundingFileSystemService = {
    realpath: (path) => realpath(path),
    readdir: async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        return Object.freeze(
            entries
                .filter((entry) => entry.isFile() || entry.isSymbolicLink())
                .map((entry) => entry.name),
        );
    },
    readFileBounded: readBounded,
};

export type GroundingReaderService = {
    readonly read: (
        input: GroundingReaderInput,
        options?: GuidanceReadOptions,
    ) => Promise<GroundingReadOutcome>;
};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const isAbort = (error: unknown): boolean =>
    error instanceof CommandAbortedError ||
    error instanceof GroundingReadAbortedError;

const assertNotAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) {
        throw new GroundingReadAbortedError({ cause: signal.reason });
    }
};

const skipOf = (
    reason: GroundingSkipReason,
    detail: string,
): GroundingReadOutcome =>
    Object.freeze({
        status: "skipped",
        skip: Object.freeze({ reason, detail }),
    });

/** Internal typed condition mapped to a safe skip by the reader. */
class GroundingConditionError extends RalphieError {
    readonly reason: GroundingSkipReason;

    constructor(input: {
        readonly reason: GroundingSkipReason;
        readonly detail: string;
    }) {
        super({ message: input.detail });
        this.name = "GroundingConditionError";
        this.reason = input.reason;
    }
}

const readGitOnly = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    args: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
    trimStdout = true,
): Promise<
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly detail: string }
> => {
    try {
        const value = await runGit(
            runner,
            repositoryPath,
            args,
            `Failed to run read-only git ${args[0] ?? "command"}`,
            trimStdout,
            signal,
        );
        return { ok: true, value };
    } catch (error) {
        if (error instanceof CommandAbortedError) throw error;
        return { ok: false, detail: messageOf(error) };
    }
};

const captureGrounding = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    branch: string,
    signal: AbortSignal | undefined,
): Promise<RepositoryGrounding> => {
    const symbolicBranch = await readGitOnly(
        runner,
        repositoryPath,
        ["symbolic-ref", "--short", "HEAD"],
        signal,
    );
    if (!symbolicBranch.ok) {
        throw new GroundingConditionError({
            reason: "unreadable-repository",
            detail: `Could not read the symbolic repository branch: ${symbolicBranch.detail}`,
        });
    }
    if (symbolicBranch.value === "") {
        throw new GroundingConditionError({
            reason: "unreadable-repository",
            detail: "Git returned an empty symbolic repository branch.",
        });
    }
    if (symbolicBranch.value !== branch) {
        throw new GroundingConditionError({
            reason: "branch-mismatch",
            detail: `Selected branch is ${branch}, but the checkout is on ${symbolicBranch.value}.`,
        });
    }
    const head = await readGitOnly(
        runner,
        repositoryPath,
        ["rev-parse", "HEAD"],
        signal,
    );
    if (!head.ok) {
        throw new GroundingConditionError({
            reason: "missing-head",
            detail: `Could not read the repository HEAD: ${head.detail}`,
        });
    }
    if (!VALID_GIT_SHA.test(head.value)) {
        throw new GroundingConditionError({
            reason: "unreadable-repository",
            detail: `Git returned an invalid repository HEAD: ${head.value}`,
        });
    }
    const status = await readGitOnly(
        runner,
        repositoryPath,
        ["status", "--porcelain=v1"],
        signal,
        false,
    );
    if (!status.ok) {
        throw new GroundingConditionError({
            reason: "unreadable-repository",
            detail: `Could not inspect the repository status: ${status.detail}`,
        });
    }
    if (status.value.length > 0) {
        throw new GroundingConditionError({
            reason: "dirty-checkout",
            detail: "Checkout has uncommitted changes; refusing to ground a dirty repository.",
        });
    }
    return Object.freeze({
        branch,
        head: head.value,
        clean: true,
        readOnly: true,
    });
};

const errorCode = (error: unknown): string | undefined => {
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
};

const isNotFound = (error: unknown): boolean => errorCode(error) === "ENOENT";

const isWithinRoot = (root: string, path: string): boolean =>
    path === root || path.startsWith(`${root}${sep}`);

const isRecognizedTemplateName = (name: string): boolean => {
    for (const extension of GUIDANCE_ISSUE_TEMPLATE_EXTENSIONS) {
        if (name.endsWith(extension)) return true;
    }
    return false;
};

const collectCandidates = async (
    fileSystem: GroundingFileSystemService,
    repositoryPath: string,
    signal: AbortSignal | undefined,
): Promise<ReadonlyArray<string>> => {
    const paths: string[] = [
        ...GUIDANCE_ROOT_FILES,
        GUIDANCE_EXPLICIT_TEMPLATE_FILE,
    ];
    let entries: ReadonlyArray<string>;
    try {
        entries = await fileSystem.readdir(
            join(repositoryPath, GUIDANCE_ISSUE_TEMPLATE_DIRECTORY),
        );
    } catch (error) {
        if (isNotFound(error)) {
            // The optional template directory is metadata, not an error.
            entries = Object.freeze([]);
        } else {
            throw new RalphieError({
                message: `Could not inspect the guidance template directory: ${messageOf(error)}`,
            });
        }
    }
    assertNotAborted(signal);
    for (const name of entries) {
        if (isRecognizedTemplateName(name)) {
            paths.push(`${GUIDANCE_ISSUE_TEMPLATE_DIRECTORY}/${name}`);
        }
    }
    return Object.freeze([...paths].sort());
};

/**
 * Cut a byte prefix on a complete UTF-8 code-point boundary. Only the final
 * (possibly partial) multi-byte sequence is trimmed; everything before it is
 * kept, so a valid input file always yields a valid content prefix.
 */
const trimPartialUtf8Tail = (bytes: Buffer): Buffer => {
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1000_0000) {
        end--;
    }
    if (end === 0) return bytes;
    const start = bytes[end - 1]!;
    const needed = start < 0x80 ? 1 : start < 0xe0 ? 2 : start < 0xf0 ? 3 : 4;
    return end - 1 + needed <= bytes.length
        ? bytes
        : bytes.subarray(0, end - 1);
};

type ContentProjection = {
    readonly state: "available" | "omitted";
    readonly content: string;
    readonly truncated: boolean;
    readonly omitted: boolean;
    readonly marker: string | null;
    readonly originalByteLength: number | null;
};

/** Bound one file's bytes to the per-file byte limit. */
const projectContent = (bytes: Buffer, limit: number): ContentProjection => {
    if (bytes.length <= limit) {
        return {
            state: "available",
            content: bytes.toString("utf-8"),
            truncated: false,
            omitted: false,
            marker: null,
            originalByteLength: bytes.length,
        };
    }
    const keep = limit - GROUNDING_TRUNCATION_MARKER_BYTES;
    if (keep > 0) {
        // Retain a strictly positive head, then append the marker. The `> 0`
        // guard prevents a zero-byte head from appending the whole tail.
        const head = trimPartialUtf8Tail(bytes.subarray(0, keep)).toString(
            "utf-8",
        );
        return {
            state: "available",
            content: `${head}${GROUNDING_TRUNCATION_MARKER}`,
            truncated: true,
            omitted: false,
            marker: GROUNDING_TRUNCATION_MARKER,
            originalByteLength: null,
        };
    }
    if (limit >= GROUNDING_TRUNCATION_MARKER_BYTES) {
        // Exactly the truncation marker fits: zero body bytes are retained
        // but the cut stays observable.
        return {
            state: "available",
            content: GROUNDING_TRUNCATION_MARKER,
            truncated: true,
            omitted: false,
            marker: GROUNDING_TRUNCATION_MARKER,
            originalByteLength: null,
        };
    }
    if (limit >= GROUNDING_OMISSION_MARKER_BYTES) {
        return {
            state: "omitted",
            content: GROUNDING_OMISSION_MARKER,
            truncated: false,
            omitted: true,
            marker: GROUNDING_OMISSION_MARKER,
            originalByteLength: bytes.length,
        };
    }
    return {
        state: "omitted",
        content: "",
        truncated: false,
        omitted: true,
        marker: GROUNDING_OMISSION_MARKER,
        originalByteLength: bytes.length,
    };
};

const absentFile = (path: string, limit: number): GuidanceFile =>
    Object.freeze({
        path,
        state: "absent",
        content: "",
        byteLength: 0,
        truncated: false,
        omitted: false,
        marker: null,
        detail: null,
        originalByteLength: null,
        limit,
    });

const unavailableFile = (
    path: string,
    detail: string,
    limit: number,
): GuidanceFile =>
    Object.freeze({
        path,
        state: "unavailable",
        content: "",
        byteLength: 0,
        truncated: false,
        omitted: false,
        marker: null,
        detail,
        originalByteLength: null,
        limit,
    });

const omittedFile = (
    path: string,
    detail: string,
    originalByteLength: number | null,
    limit: number,
): GuidanceFile =>
    Object.freeze({
        path,
        state: "omitted",
        content: "",
        byteLength: 0,
        truncated: false,
        omitted: true,
        marker: GROUNDING_OMISSION_MARKER,
        detail,
        originalByteLength,
        limit,
    });

const fileFromProjection = (
    path: string,
    projection: ContentProjection,
    detail: string | null,
    limit: number,
): GuidanceFile =>
    Object.freeze({
        path,
        state: projection.state,
        content: projection.content,
        byteLength: Buffer.byteLength(projection.content, "utf-8"),
        truncated: projection.truncated,
        omitted: projection.omitted,
        marker: projection.marker,
        detail,
        originalByteLength: projection.originalByteLength,
        limit,
    });

const resolveReal = async (
    fileSystem: GroundingFileSystemService,
    resolved: string,
): Promise<
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly missing: boolean; readonly detail: string }
> => {
    try {
        return { ok: true, path: await fileSystem.realpath(resolved) };
    } catch (error) {
        if (isNotFound(error)) {
            return { ok: false, missing: true, detail: messageOf(error) };
        }
        return { ok: false, missing: false, detail: messageOf(error) };
    }
};

const readGuidanceBytes = async (
    fileSystem: GroundingFileSystemService,
    path: string,
    limit: number,
): Promise<
    | { readonly ok: true; readonly bytes: Buffer }
    | { readonly ok: false; readonly missing: boolean; readonly detail: string }
> => {
    try {
        return {
            ok: true,
            bytes: await fileSystem.readFileBounded(path, limit + 1),
        };
    } catch (error) {
        if (isNotFound(error)) {
            return { ok: false, missing: true, detail: messageOf(error) };
        }
        return { ok: false, missing: false, detail: messageOf(error) };
    }
};

const projectCandidate = async (
    fileSystem: GroundingFileSystemService,
    root: string,
    relativePath: string,
    limit: number,
    aggregateLimit: number,
    usedBytes: number,
): Promise<{ readonly file: GuidanceFile; readonly usedBytes: number }> => {
    const resolved = resolve(root, relativePath);
    if (!isWithinRoot(root, resolved)) {
        return {
            file: unavailableFile(
                relativePath,
                "guidance path escapes the repository root",
                limit,
            ),
            usedBytes,
        };
    }
    const real = await resolveReal(fileSystem, resolved);
    if (!real.ok) {
        if (real.missing) {
            return { file: absentFile(relativePath, limit), usedBytes };
        }
        return {
            file: unavailableFile(
                relativePath,
                `could not resolve the guidance path: ${real.detail}`,
                limit,
            ),
            usedBytes,
        };
    }
    if (!isWithinRoot(root, real.path)) {
        return {
            file: unavailableFile(
                relativePath,
                "guidance symlink resolves outside the repository root",
                limit,
            ),
            usedBytes,
        };
    }
    if (usedBytes >= aggregateLimit) {
        return {
            file: omittedFile(
                relativePath,
                "aggregate guidance byte limit is exhausted",
                null,
                limit,
            ),
            usedBytes,
        };
    }
    const read = await readGuidanceBytes(fileSystem, real.path, limit);
    if (!read.ok) {
        if (read.missing) {
            return { file: absentFile(relativePath, limit), usedBytes };
        }
        return {
            file: unavailableFile(
                relativePath,
                `could not read the guidance file: ${read.detail}`,
                limit,
            ),
            usedBytes,
        };
    }
    const projection = projectContent(read.bytes, limit);
    const contentBytes = Buffer.byteLength(projection.content, "utf-8");
    if (usedBytes + contentBytes > aggregateLimit) {
        return {
            file: omittedFile(
                relativePath,
                "aggregate guidance byte limit is exhausted",
                projection.originalByteLength,
                limit,
            ),
            usedBytes,
        };
    }
    return {
        file: fileFromProjection(
            relativePath,
            projection,
            projection.state === "omitted"
                ? "per-file guidance byte limit is exhausted"
                : null,
            limit,
        ),
        usedBytes: usedBytes + contentBytes,
    };
};

const readGuidanceBundle = async (
    fileSystem: GroundingFileSystemService,
    repositoryPath: string,
    perFileByteLimit: number,
    aggregateByteLimit: number,
    signal: AbortSignal | undefined,
): Promise<GuidanceBundle> => {
    const root = await fileSystem.realpath(repositoryPath);
    const candidates = await collectCandidates(
        fileSystem,
        repositoryPath,
        signal,
    );
    const files: GuidanceFile[] = [];
    let usedBytes = 0;
    for (const path of candidates) {
        assertNotAborted(signal);
        const projected = await projectCandidate(
            fileSystem,
            root,
            path,
            perFileByteLimit,
            aggregateByteLimit,
            usedBytes,
        );
        files.push(projected.file);
        usedBytes = projected.usedBytes;
    }
    return Object.freeze({
        files: Object.freeze(files),
        totalByteLength: usedBytes,
        truncated: files.some((file) => file.truncated),
        omitted: files.some((file) => file.omitted),
        perFileByteLimit,
        aggregateByteLimit,
    });
};

export const makeMaintainIssuesGroundingReader = (
    runner: CommandRunnerService = CommandRunnerLive,
    fileSystem: GroundingFileSystemService = GroundingFileSystemLive,
): GroundingReaderService => ({
    read: async (input, options) => {
        assertNotAborted(input.signal);
        const perFileByteLimit = validateGuidanceLimit(
            "per-file guidance byte limit",
            options?.perFileByteLimit ?? DEFAULT_GUIDANCE_PER_FILE_BYTE_LIMIT,
        );
        const aggregateByteLimit = validateGuidanceLimit(
            "aggregate guidance byte limit",
            options?.aggregateByteLimit ??
                DEFAULT_GUIDANCE_AGGREGATE_BYTE_LIMIT,
        );
        try {
            const grounding = await captureGrounding(
                runner,
                input.repositoryPath,
                input.branch,
                input.signal,
            );
            const guidance = await readGuidanceBundle(
                fileSystem,
                input.repositoryPath,
                perFileByteLimit,
                aggregateByteLimit,
                input.signal,
            );
            return Object.freeze({
                status: "grounded",
                grounding,
                guidance,
            });
        } catch (error) {
            if (isAbort(error)) throw error;
            if (error instanceof GroundingConditionError) {
                return skipOf(error.reason, error.message);
            }
            return skipOf(
                "unreadable-repository",
                `Could not read the repository grounding: ${messageOf(error)}`,
            );
        }
    },
});

export const MaintainIssuesGroundingReaderLive =
    makeMaintainIssuesGroundingReader();