import type {
    AgentEventListener,
    AgentEventContext,
} from "../../agent/ports.ts";
import type { ProgressOutput, ProgressRenderMode } from "./progress.ts";
import type { ProgressReporterService, ProgressUpdate } from "../ports.ts";
import type { RunControl } from "../../run/ports.ts";
import type { CliRenderer } from "@opentui/core";

import {
    makeProgressOutput,
    makeProgressReporter,
    type ProgressRendererOptions,
} from "./progress.ts";
import { makePlainTranscript } from "./plain-transcript.ts";
import { makeTuiProgressCoordinator } from "./tui.ts";

/**
 * The presentation boundary for one workflow run.
 *
 * `mode` selects the adapter: `interactive` renders an OpenTUI application,
 * `plain` writes append-only lines, and `json` writes JSON Lines. The
 * workflow only ever sees `progress.emit`; agent events arrive through the
 * listener handed to the pi service.
 */
export type ProgressCoordinator = {
    readonly progress: ProgressReporterService;
    readonly piListener: AgentEventListener;
    /** Interactive queue control; only the interactive adapter provides one. */
    readonly control?: RunControl;
    /** Resolves after the presentation adapter is ready to render. */
    readonly ready: Promise<void>;
    readonly dispose: () => Promise<void>;
};

/** Options for the shared progress/agent output coordinator. */
export type ProgressCoordinatorOptions = Omit<
    ProgressRendererOptions,
    "output"
> & {
    /** Shared output sink, primarily useful for deterministic tests. */
    readonly output?: ProgressOutput;
    /** Test seam for the interactive renderer. */
    readonly createRenderer?: () => Promise<CliRenderer>;
    /** Test seam: replace the signal raised by quit. */
    readonly quit?: () => void;
};

const makePlainCoordinator = (
    options: ProgressCoordinatorOptions,
): ProgressCoordinator => {
    const output =
        options.output ??
        makeProgressOutput({
            mode: options.mode,
            write: options.write,
        });
    const reporter = makeProgressReporter({
        ...options,
        output,
    });
    const transcript = makePlainTranscript({
        mode: options.mode === "json" ? "json" : "plain",
        output,
        now: options.now,
    });

    const progress: ProgressReporterService = {
        emit: async (update: ProgressUpdate) => {
            await reporter.emit(update);
        },
    };

    const piListener = (event: unknown, context: AgentEventContext): void => {
        transcript(event, context);
    };

    return {
        progress,
        piListener,
        ready: Promise.resolve(),
        dispose: async () => {
            output.dispose();
        },
    };
};

/** Construct the ordered progress and agent presentation services for a run. */
export const makeProgressCoordinator = (
    options: ProgressCoordinatorOptions,
): ProgressCoordinator =>
    options.mode === "interactive"
        ? makeTuiProgressCoordinator(options)
        : makePlainCoordinator(options);

export type { ProgressRenderMode };