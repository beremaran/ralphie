import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";

import { RalphieError } from "../../shared/error.ts";
import { resolveWorkspacePath } from "../../core/domain/workspace-path.ts";

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

import type { WorkspaceService } from "../../core/ports/workspace.ts";

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