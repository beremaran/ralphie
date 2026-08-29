import type { MaintainIssuesRalphieConfig } from "./options.ts";
import type { RalphieRuntime } from "./runtime.ts";
import { RalphieError } from "./shared/error.ts";

/** Inputs reserved for the mode-specific maintenance workflow. */
export type MaintainIssuesOptions = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
};

/** Typed dispatch seam for maintenance runs. */
export type MaintainIssuesEntryPoint = (
    options: MaintainIssuesOptions,
    runtime: RalphieRuntime,
) => Promise<void>;

/**
 * Maintenance is intentionally not wired to the implementation workflow yet.
 * Keeping this entry point separate makes that absence fail closed.
 */
export const maintainIssues: MaintainIssuesEntryPoint = async (
    _options,
    _runtime,
): Promise<void> => {
    throw new RalphieError({
        message: "The maintain-issues execution mode is not implemented yet.",
    });
};