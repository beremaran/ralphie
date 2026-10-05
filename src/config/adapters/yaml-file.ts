import { readFile } from "node:fs/promises";

import { RalphieError } from "../../shared/error.ts";
import type { ConfigDocument, ConfigDocumentReader } from "../ports.ts";

const isMissingFile = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const readText = async (path: string): Promise<string | undefined> => {
    try {
        return await readFile(path, "utf8");
    } catch (cause) {
        if (isMissingFile(cause)) return undefined;
        throw new RalphieError({
            message: `Could not read configuration file ${path}: ${messageOf(cause)}`,
            cause,
        });
    }
};

/** Reads configuration files from disk and parses them with Bun's YAML parser. */
export const yamlConfigDocumentReader: ConfigDocumentReader = {
    read: async (path): Promise<ConfigDocument> => {
        const text = await readText(path);
        if (text === undefined) return { found: false };
        try {
            return { found: true, content: Bun.YAML.parse(text) };
        } catch (cause) {
            throw new RalphieError({
                message: `Configuration file ${path} is not valid YAML: ${messageOf(cause)}`,
                cause,
            });
        }
    },
    parseValue: (text) => Bun.YAML.parse(text),
};