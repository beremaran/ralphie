import type { AgentModel } from "../agent/model.ts";
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
/**
 * Interactive queue control, consulted between issues.
 *
 * `waitForQueue` resolves immediately while the queue runs and stays pending
 * while paused; resuming or stopping resolves it. `stopAfterCurrent` is only
 * read between issues, so the active issue always runs to completion before
 * the queue stops. Quitting the run remains the `AbortSignal`'s job.
 */
export type RunControlSelection = {
    readonly model: AgentModel;
    readonly variant?: string;
};

export type RunControl = {
    readonly waitForQueue: () => Promise<void>;
    readonly stopAfterCurrent: () => boolean;
    /**
     * Model and thinking level for issues started after the call; `undefined`
     * keeps the CLI selection. The workflow reads this once per issue, so a
     * pick never changes the session already in flight.
     */
    readonly issueSelection?: () => RunControlSelection | undefined;
};

/** Injectable wall clock; adapters use the system clock, tests a fixed one. */
export type Clock = {
    readonly now: () => Date;
};

/** Injectable unique-id generator for run ids and temporary names. */
export type IdGenerator = {
    readonly next: () => string;
};

/**
 * Filesystem layout for one run, resolved by the composition root.
 *
 * Core code passes these values around and never composes paths itself.
 */
export type RunLayout = {
    /** Expanded workspace root. */
    readonly workspaceRoot: string;
    /** `<workspaceRoot>/.ralphie/runs/<runId>` */
    readonly runRoot: string;
    readonly statePath: string;
    readonly eventLogPath: string;
    readonly issueArtifactsDirectory: (issueNumber: number) => string;
    readonly issueArtifactsPath: (issueNumber: number) => string;
    readonly diagnosticsDirectory: (issueNumber: number) => string;
    readonly diagnosticsPath: (issueNumber: number, name: string) => string;
};