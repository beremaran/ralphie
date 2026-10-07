import { RalphieError, errorMessage } from "../shared/error.ts";

export type ConfigMapping = Readonly<Record<string, unknown>>;

/** One parsed `--set path=value` override. */
export type SetOverride = {
    readonly text: string;
    readonly path: ReadonlyArray<string>;
    readonly value: unknown;
};

export const isMapping = (value: unknown): value is ConfigMapping =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Render a config path the way `--set` accepts it, quoting keys that need it. */
export const formatConfigPath = (path: ReadonlyArray<PropertyKey>): string => {
    if (path.length === 0) return "(top level)";
    return path
        .map((segment, index) => {
            if (typeof segment === "number") return `[${segment}]`;
            const text = String(segment);
            const key = /^[A-Za-z0-9_-]+$/.test(text)
                ? text
                : JSON.stringify(text);
            return index === 0 ? key : `.${key}`;
        })
        .join("");
};

const invalidSet = (text: string, reason: string): RalphieError =>
    new RalphieError({ message: `Invalid --set ${text}: ${reason}.` });

/** Split at the first `=` outside a quoted key. */
const splitAssignment = (
    text: string,
): { readonly path: string; readonly value: string } => {
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"') quoted = !quoted;
        if (character === "=" && !quoted) {
            return { path: text.slice(0, index), value: text.slice(index + 1) };
        }
    }
    throw invalidSet(text, "expected path=value");
};

/** Dotted keys; a double-quoted key may contain dots and slashes. */
const parsePath = (path: string, text: string): ReadonlyArray<string> => {
    const segment = /"([^"]+)"|([^."]+)/y;
    const segments: string[] = [];
    let index = 0;
    for (;;) {
        segment.lastIndex = index;
        const match = segment.exec(path);
        const key = match?.[1] ?? match?.[2];
        if (key === undefined) {
            throw invalidSet(
                text,
                `cannot read a key at "${path.slice(index)}"`,
            );
        }
        segments.push(key);
        index = segment.lastIndex;
        if (index === path.length) return segments;
        if (path[index] !== ".") {
            throw invalidSet(text, `expected "." after ${key}`);
        }
        index += 1;
    }
};

/** Parse a raw `--set` argument, reading the value as YAML. */
export const parseSetOverride = (
    text: string,
    parseValue: (value: string) => unknown,
): SetOverride => {
    const assignment = splitAssignment(text);
    const path = parsePath(assignment.path.trim(), text);
    let value: unknown;
    try {
        value = parseValue(assignment.value);
    } catch (cause) {
        const reason = errorMessage(cause);
        throw invalidSet(text, `the value is not valid YAML (${reason})`);
    }
    return { text, path, value };
};

const assign = (
    node: unknown,
    path: ReadonlyArray<string>,
    reached: ReadonlyArray<string>,
    override: SetOverride,
): ConfigMapping => {
    if (node !== undefined && node !== null && !isMapping(node)) {
        throw invalidSet(
            override.text,
            `${formatConfigPath(reached)} is not a mapping`,
        );
    }
    const mapping: ConfigMapping = isMapping(node) ? node : {};
    const [key, ...rest] = path;
    if (key === undefined) return mapping;
    return {
        ...mapping,
        [key]:
            rest.length === 0
                ? override.value
                : assign(mapping[key], rest, [...reached, key], override),
    };
};

/** Write each override into a copy of `document` at its path, in order. */
export const applyOverrides = (
    document: ConfigMapping,
    overrides: ReadonlyArray<SetOverride>,
): ConfigMapping =>
    overrides.reduce(
        (current, override) => assign(current, override.path, [], override),
        document,
    );

/** Deep-merge mappings; lists and scalars in `override` replace `base`. */
export const mergeMappings = (
    base: ConfigMapping,
    override: ConfigMapping,
): ConfigMapping => {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = merged[key];
        merged[key] =
            isMapping(current) && isMapping(value)
                ? mergeMappings(current, value)
                : value;
    }
    return merged;
};