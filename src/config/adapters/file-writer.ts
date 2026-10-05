import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { RalphieError } from "../../shared/error.ts";
import type { ConfigDocumentWriter } from "../ports.ts";

const hasCode = (error: unknown, code: string): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;

/** Creates the file exclusively, so an existing one is never overwritten. */
export const fileConfigDocumentWriter: ConfigDocumentWriter = {
    createIfAbsent: async (path, content) => {
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, { flag: "wx" });
            return true;
        } catch (cause) {
            if (hasCode(cause, "EEXIST")) return false;
            throw new RalphieError({
                message: `Could not write configuration file ${path}: ${
                    cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
            });
        }
    },
};