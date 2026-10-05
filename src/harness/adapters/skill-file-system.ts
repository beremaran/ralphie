import {
    cp,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";

import type { SkillFileSystem } from "../app/skill-injection.ts";

const isMissing = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";

/** Node file-system adapter for skill injection. */
export const nodeSkillFileSystem: SkillFileSystem = {
    exists: async (path) => {
        try {
            await stat(path);
            return true;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    },
    listDirectories: async (path) => {
        try {
            const entries = await readdir(path, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch (error) {
            if (isMissing(error)) return [];
            throw error;
        }
    },
    copyTree: async (from, to) => {
        await cp(from, to, { recursive: true });
    },
    move: async (from, to) => {
        await rename(from, to);
    },
    remove: async (path) => {
        await rm(path, { recursive: true, force: true });
    },
    makeDirectory: async (path) => {
        await mkdir(path, { recursive: true });
    },
    writeText: async (path, contents) => {
        await writeFile(path, contents, "utf8");
    },
    readText: async (path) => {
        try {
            return await readFile(path, "utf8");
        } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
        }
    },
};