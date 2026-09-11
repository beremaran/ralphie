const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const preview = (value: string, limit = 120): string =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** Extract plain text from a tool result, message part, or string value. */
export const contentText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        const parts = value.flatMap((part) => {
            if (
                typeof part === "object" &&
                part !== null &&
                typeof (part as { text?: unknown }).text === "string"
            ) {
                return [(part as { text: string }).text];
            }
            return [];
        });
        return parts.length === 0 ? undefined : parts.join("\n");
    }
    if (typeof value === "object" && value !== null) {
        const text = (value as { text?: unknown }).text;
        if (typeof text === "string") return text;
        const content = (value as { content?: unknown }).content;
        return content === undefined ? undefined : contentText(content);
    }
    return undefined;
};

const argumentsRecord = (args: unknown): Record<string, unknown> =>
    (args ?? {}) as Record<string, unknown>;

const argumentPath = (value: Record<string, unknown>): string | undefined => {
    if (typeof value.file_path === "string") return value.file_path;
    if (typeof value.path === "string") return value.path;
    return undefined;
};

const bashTarget = (command: string, timeout: unknown): string =>
    `$ ${preview(oneLine(command))}${
        typeof timeout === "number" ? ` · ${timeout}s` : ""
    }`;

const readTarget = (path: string, value: Record<string, unknown>): string => {
    const hasRange =
        typeof value.offset === "number" || typeof value.limit === "number";
    if (!hasRange) return `read ${path}`;
    const offset = typeof value.offset === "number" ? value.offset : 1;
    const limit = typeof value.limit === "number" ? value.limit : 0;
    const end = limit > 0 ? `-${offset + limit - 1}` : "";
    return `read ${path}:${offset}${end}`;
};

const fallbackTarget = (name: unknown, args: unknown): string => {
    if (args === undefined) return String(name ?? "tool");
    try {
        return `${String(name ?? "tool")} ${preview(JSON.stringify(args))}`;
    } catch {
        return String(name ?? "tool");
    }
};

/** Render a tool invocation as one human-readable target string. */
export const toolTarget = (name: unknown, args: unknown): string => {
    const value = argumentsRecord(args);
    if (name === "bash" && typeof value.command === "string") {
        return bashTarget(value.command, value.timeout);
    }
    const path = argumentPath(value);
    if (path === undefined) return fallbackTarget(name, args);
    if (name === "read") return readTarget(path, value);
    return `${String(name ?? "tool")} ${path}`;
};