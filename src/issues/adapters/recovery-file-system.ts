import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { RecoveryFileSystem } from "../app/recovery.ts";

/** Node file-system adapter for review and needs-attention diagnostics. */
export const nodeRecoveryFileSystem: RecoveryFileSystem = {
    mkdir: async (directory, options) => {
        await mkdir(directory, options);
    },
    readFile: async (filePath, encoding) =>
        await readFile(filePath, { encoding }),
    writeFile: async (filePath, contents, options) => {
        await writeFile(filePath, contents, options);
    },
    rename: async (temporaryPath, filePath) => {
        await rename(temporaryPath, filePath);
    },
    rm: async (filePath, options) => {
        await rm(filePath, options);
    },
};