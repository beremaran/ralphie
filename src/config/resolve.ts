import type { z } from "zod";

import {
    parseRepositorySlug,
    type RepositorySlug,
} from "../github/repository.ts";
import { RalphieError } from "../shared/error.ts";
import {
    applyDefaults,
    ralphieConfigSchema,
    type RalphieConfigDocument,
    type RepositoryOverrides,
    type ResolvedSettings,
} from "./domain.ts";
import type { ConfigFile } from "./ports.ts";

type Mapping = Record<string, unknown>;

/** One `--set path=value` override with its dotted path already split. */
export type SetOverride = {
    readonly path: ReadonlyArray<string>;
    readonly value: unknown;
    readonly raw: string;
};

const isMapping = (value: unknown): value is Mapping =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Render a path the way `--set` accepts it, quoting keys that need it. */
export const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
    path
        .map((segment) => String(segment))
        .map((segment, index) =>
            /^[A-Za-z0-9_-]+$/.test(segment)
                ? `${index === 0 ? "" : "."}${segment}`
                : `${index === 0 ? "" : "."}"${segment}"`,
        )
        .join("");

const splitPath = (
    raw: string,
): { readonly path: string[]; readonly rest: string } => {
    const path: string[] = [];
    let segment = "";
    let quoted = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index] as string;
        if (char === '"') {
            quoted = !quoted;
        } else if (!quoted && char === ".") {
            path.push(segment);
            segment = "";
        } else if (!quoted && char === "=") {
            path.push(segment);
            return { path, rest: raw.slice(index + 1) };
        } else {
            segment += char;
        }
    }
    throw new RalphieError({
        message: `Invalid --set value ${JSON.stringify(raw)}: expected path=value${quoted ? " (unterminated quote)" : ""}.`,
    });
};

const parseValue = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

/**
 * Parse `--set path=value`. The path uses the file's dotted keys and may
 * quote a segment (`repos."owner/repo".branch=main`). The value is JSON when
 * it parses as JSON and the literal text otherwise.
 */
export const parseSetOverride = (raw: string): SetOverride => {
    const { path, rest } = splitPath(raw);
    if (path.some((segment) => segment === "")) {
        throw new RalphieError({
            message: `Invalid --set value ${JSON.stringify(raw)}: the path must not contain empty segments.`,
        });
    }
    return { path, value: parseValue(rest), raw };
};

const setIn = (
    target: Mapping,
    path: ReadonlyArray<string>,
    value: unknown,
    raw: string,
): void => {
    let cursor = target;
    path.slice(0, -1).forEach((segment, index) => {
        const next = cursor[segment];
        if (next === undefined) {
            cursor[segment] = {};
        } else if (!isMapping(next)) {
            throw new RalphieError({
                message: `Cannot apply --set ${raw}: ${formatPath(path.slice(0, index + 1))} is not a mapping.`,
            });
        }
        cursor = cursor[segment] as Mapping;
    });
    cursor[path[path.length - 1] as string] = value;
};

const clone = <T>(value: T): T => structuredClone(value);

const mergeInto = (target: Mapping, source: Mapping): Mapping => {
    for (const [key, value] of Object.entries(source)) {
        const existing = target[key];
        target[key] =
            isMapping(value) && isMapping(existing)
                ? mergeInto({ ...existing }, value)
                : clone(value);
    }
    return target;
};

const issueMessages = (error: z.ZodError): string[] =>
    error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
            return issue.keys.map(
                (key) => `${formatPath([...issue.path, key])}: unknown key`,
            );
        }
        const where = formatPath(issue.path);
        return [`${where === "" ? "(top level)" : where}: ${issue.message}`];
    });

const validate = (document: unknown, source: string): RalphieConfigDocument => {
    const parsed = ralphieConfigSchema.safeParse(document);
    if (parsed.success) return parsed.data;
    throw new RalphieError({
        message: `Invalid configuration (${source}):\n${issueMessages(
            parsed.error,
        )
            .map((line) => `  ${line}`)
            .join("\n")}`,
    });
};

const sameRepository = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const repositoryEntry = (
    document: RalphieConfigDocument,
    slug: string,
): RepositoryOverrides => {
    const match = Object.entries(document.repos ?? {}).find(([key]) =>
        sameRepository(key, slug),
    );
    return match?.[1] ?? {};
};

const fileLayer = (document: RalphieConfigDocument): Mapping => {
    const { defaultOwner: _owner, repos: _repos, ...settings } = document;
    return settings as Mapping;
};

/** The `--set` overrides that apply to `slug`, with repository prefixes removed. */
const overrideLayer = (
    overrides: ReadonlyArray<SetOverride>,
    slug: string,
): Mapping => {
    const layer: Mapping = {};
    for (const override of overrides) {
        const [head, repository, ...rest] = override.path;
        if (head === "defaultOwner") continue;
        if (head !== "repos") {
            setIn(layer, override.path, clone(override.value), override.raw);
            continue;
        }
        if (repository === undefined || !sameRepository(repository, slug)) {
            continue;
        }
        if (rest.length > 0) {
            setIn(layer, rest, clone(override.value), override.raw);
        } else if (isMapping(override.value)) {
            mergeInto(layer, override.value);
        }
    }
    return layer;
};

const applyOverrides = (
    document: unknown,
    overrides: ReadonlyArray<SetOverride>,
): unknown => {
    const next = clone(document);
    if (overrides.length > 0 && !isMapping(next)) {
        throw new RalphieError({
            message: "Cannot apply --set: the configuration is not a mapping.",
        });
    }
    for (const override of overrides) {
        setIn(
            next as Mapping,
            override.path,
            clone(override.value),
            override.raw,
        );
    }
    return next;
};

export type ValidatedConfiguration = {
    readonly document: RalphieConfigDocument;
    readonly path: string;
};

/**
 * Validate the file with every `--set` override applied, so a typo in either
 * names its exact path before anything runs.
 */
export const validateConfiguration = (
    file: ConfigFile,
    overrides: ReadonlyArray<SetOverride>,
): ValidatedConfiguration => ({
    path: file.path,
    document: validate(
        applyOverrides(file.document, overrides),
        overrides.length === 0
            ? file.path
            : `${file.path} with --set overrides`,
    ),
});

const BARE_NAME = /^[a-zA-Z0-9_.-]+$/;

/**
 * Resolve the repository argument. `owner/repo` and clone URLs are taken as
 * given; a bare `repo` gets `defaultOwner`, else the authenticated login.
 * Nothing is inferred from the current directory.
 */
export const resolveRepository = async (
    argument: string | undefined,
    defaultOwner: string | undefined,
    login: () => Promise<string>,
): Promise<RepositorySlug> => {
    if (argument === undefined) {
        throw new RalphieError({
            message:
                "Missing repository: provide an owner/repository or repository argument.",
        });
    }
    const value = argument.trim();
    if (BARE_NAME.test(value) && value !== "." && value !== "..") {
        return parseRepositorySlug(
            `${defaultOwner ?? (await login())}/${value}`,
        );
    }
    return parseRepositorySlug(value);
};

/**
 * Precedence, lowest to highest: built-in defaults, the top-level file, the
 * matching `repos:` entry, then `--set` overrides.
 */
export const resolveSettings = (
    file: ConfigFile,
    overrides: ReadonlyArray<SetOverride>,
    slug: string,
): ResolvedSettings => {
    const original = validate(file.document, file.path);
    const layered = mergeInto(
        mergeInto(
            mergeInto({}, fileLayer(original)),
            repositoryEntry(original, slug) as Mapping,
        ),
        overrideLayer(overrides, slug),
    );
    return applyDefaults(layered as RepositoryOverrides);
};