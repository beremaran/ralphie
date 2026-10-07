import { readFile } from "node:fs/promises";

import {
    errorMessage,
    hasErrorCode,
    RalphieError,
} from "../../shared/error.ts";
import type { ConfigDocument, ConfigDocumentReader } from "../ports.ts";

const readText = async (path: string): Promise<string | undefined> => {
    try {
        return await readFile(path, "utf8");
    } catch (cause) {
        if (hasErrorCode(cause, "ENOENT")) return undefined;
        throw new RalphieError({
            message: `Could not read configuration file ${path}: ${errorMessage(cause)}`,
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
                message: `Configuration file ${path} is not valid YAML: ${errorMessage(cause)}`,
                cause,
            });
        }
    },
    parseValue: (text) => Bun.YAML.parse(text),
};