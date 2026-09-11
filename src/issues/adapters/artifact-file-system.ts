import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { IssueArtifactFileSystem } from "../app/artifacts.ts";

/** Node file-system adapter for the durable issue artifact store. */
export const nodeIssueArtifactFileSystem: IssueArtifactFileSystem = {
    readFile: async (filePath, encoding) =>
        await readFile(filePath, { encoding }),
    mkdir: async (directory, options) => {
        await mkdir(directory, options);
    },
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