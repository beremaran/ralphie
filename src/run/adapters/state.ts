import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RunStateStoreService } from "../ports.ts";
import { runStateSchema, type RunState } from "../state.ts";
import { RalphieError } from "../../shared/error.ts";

const persistRunStateAtomically = async (
    path: string,
    state: RunState,
): Promise<void> => {
    const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
            flag: "wx",
        });
        await rename(temporaryPath, path);
    } catch (cause) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new RalphieError({
            message: `Failed to persist run state at ${path}.`,
            cause,
        });
    }
};

export const RunStateStoreLive: RunStateStoreService = {
    save: async (path, state) => {
        try {
            const validated = runStateSchema.parse(state);
            await persistRunStateAtomically(path, validated);
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to persist run state at ${path}.`,
                cause,
            });
        }
    },
};