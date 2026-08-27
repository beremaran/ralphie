import type {
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
} from "../pi/client.ts";
import {
    createDisplayState,
    reducePiSessionEvent,
    reduceProgressUpdate,
    type DisplayState,
} from "./display-state.ts";
import {
    makePiTranscriptRenderer,
    type PiTranscriptRenderer,
} from "./transcript.ts";
import {
    makeProgressOutput,
    makeProgressReporter,
    type ProgressOutput,
    type ProgressReporterService,
    type ProgressRenderMode,
    type ProgressRendererOptions,
    type ProgressUpdate,
} from "./progress.ts";

/** Options for the shared progress/Pi output coordinator. */
export type ProgressCoordinatorOptions = Omit<
    ProgressRendererOptions,
    "output"
>;

/**
 * The shared presentation boundary for one workflow run.
 *
 * The coordinator is the only owner of the output sink. Both event sources
 * update display state synchronously before their renderer is called, so a
 * writer observing an event always sees the state that describes that event.
 */
export type ProgressCoordinator = {
    readonly progress: ProgressReporterService;
    /** Listener to pass to the Pi service. */
    readonly piListener: PiEventListener;
    /** Compatibility alias for callers that use the generic listener name. */
    readonly listener: PiEventListener;
    /** Explicit event-listener alias for dependency wiring. */
    readonly piEventListener: PiEventListener;
    readonly getDisplayState: () => DisplayState;
    readonly dispose: () => Promise<void>;
};

const transcriptFor = (
    options: ProgressCoordinatorOptions,
    output: ProgressOutput,
): PiTranscriptRenderer | undefined => {
    if (options.mode === "quiet") return undefined;
    return makePiTranscriptRenderer({
        write: output.writeTranscript,
        colors: options.colors,
        json: options.mode === "json",
        verbose: options.verbose,
        width: options.width,
    });
};

/** Construct the ordered progress and Pi presentation services for a run. */
export const makeProgressCoordinator = (
    options: ProgressCoordinatorOptions,
): ProgressCoordinator => {
    const output = makeProgressOutput({
        mode: options.mode,
        write: options.write,
    });
    const progressRenderer = makeProgressReporter({
        ...options,
        output,
    });
    const transcript = transcriptFor(options, output);
    const now = options.now ?? (() => new Date());
    let state = createDisplayState();
    let disposed = false;

    const piListener: PiEventListener = (event, context) => {
        if (disposed) return;
        state = reducePiSessionEvent(state, event, context, now);
        transcript?.(event, context);
    };

    const progress: ProgressReporterService = {
        emit: async (update: ProgressUpdate) => {
            if (disposed) return;
            state = reduceProgressUpdate(state, update, now);
            transcript?.interruptLine();
            await progressRenderer.emit(update);
        },
        stopPersisting: progressRenderer.stopPersisting,
    };

    return {
        progress,
        piListener,
        listener: piListener,
        piEventListener: piListener,
        getDisplayState: () => state,
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            transcript?.interruptLine();
            output.dispose();
        },
    };
};

/** Explicit alias for callers that name the service by its display role. */
export const makeDisplayCoordinator = makeProgressCoordinator;

export type { PiEventContext, PiSessionEvent };
export type { ProgressRenderMode };