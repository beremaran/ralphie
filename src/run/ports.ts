import type { ProgressEvent } from "../progress/ports.ts";
import type { RunState } from "./state.ts";

/** Outbound port for durable run-state persistence. */
export type RunStateStoreService = {
    readonly save: (path: string, state: RunState) => Promise<void>;
};

/**
 * Append-only audit of run progress events (`events.jsonl`).
 *
 * The run that owns the workspace also owns this sink: it closes the log
 * before deleting the workspace so post-cleanup events cannot recreate it.
 */
export type RunEventLog = {
    /** Append one event; a no-op after {@link RunEventLog.close}. */
    readonly append: (event: ProgressEvent) => void;
    /** Stop persisting; later appends are ignored. */
    readonly close: () => void;
};