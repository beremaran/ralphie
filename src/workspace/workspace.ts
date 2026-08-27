import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";

import { RalphieError } from "../shared/error.ts";

export const resolveWorkspacePath = (workspace: string): string => {
    if (workspace === "~") return homedir();
    if (workspace.startsWith("~/")) {
        return resolve(homedir(), workspace.slice(2));
    }
    if (workspace.startsWith("~")) {
        throw new RalphieError({
            message: `Unsupported workspace path: ${workspace}`,
        });
    }
    return resolve(workspace);
};

const assertSafeCleanupTarget = (workspace: string): string => {
    const target = resolveWorkspacePath(workspace);
    const currentDirectory = resolve(process.cwd());
    const protectedPaths = new Set([
        parse(target).root,
        resolve(homedir()),
        currentDirectory,
    ]);

    const containsCurrentDirectory = currentDirectory.startsWith(
        `${target}${sep}`,
    );
    if (protectedPaths.has(target) || containsCurrentDirectory) {
        throw new RalphieError({
            message: `Refusing to clean up protected workspace path: ${target}`,
        });
    }

    return target;
};

export type WorkspaceService = {
    readonly prepare: (workspace: string) => Promise<void>;
    readonly remove: (workspace: string) => Promise<void>;
};

export const WorkspaceLive: WorkspaceService = {
    prepare: async (workspace) => {
        try {
            await mkdir(resolveWorkspacePath(workspace), { recursive: true });
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to initialize workspace: ${workspace}`,
                cause,
            });
        }
    },

    remove: async (workspace) => {
        try {
            await rm(assertSafeCleanupTarget(workspace), {
                recursive: true,
                force: true,
            });
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to clean up workspace: ${workspace}`,
                cause,
            });
        }
    },
};