import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScratchDirectoryProvider } from "../ports.ts";

/** A fresh empty directory under the system temporary directory per call. */
export const makeTemporaryScratchDirectories =
    (): ScratchDirectoryProvider => ({
        create: async () => {
            const path = await mkdtemp(join(tmpdir(), "ralphie-session-"));
            return {
                path,
                remove: () => rm(path, { recursive: true, force: true }),
            };
        },
    });