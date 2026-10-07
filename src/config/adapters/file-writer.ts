import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    errorMessage,
    hasErrorCode,
    RalphieError,
} from "../../shared/error.ts";
import type { ConfigDocumentWriter } from "../ports.ts";

/** Creates the file exclusively, so an existing one is never overwritten. */
export const fileConfigDocumentWriter: ConfigDocumentWriter = {
    createIfAbsent: async (path, content) => {
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, { flag: "wx" });
            return true;
        } catch (cause) {
            if (hasErrorCode(cause, "EEXIST")) return false;
            throw new RalphieError({
                message: `Could not write configuration file ${path}: ${errorMessage(
                    cause,
                )}`,
                cause,
            });
        }
    },
};