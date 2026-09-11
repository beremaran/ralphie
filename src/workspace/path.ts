import { homedir } from "node:os";
import { resolve } from "node:path";

import { RalphieError } from "../shared/error.ts";

/** Expand a user-supplied workspace path without touching the filesystem. */
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