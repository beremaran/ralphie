import type {
    CodexEventContext,
    CodexEventListener,
    CodexSessionEvent,
} from "../codex/client.ts";
import {
    arbitrateBreadcrumbCandidates,
    breadcrumbCandidateFor,
    makeBreadcrumbPolicy,
    type BreadcrumbArbitrationCandidate,
    type BreadcrumbPolicy,
} from "./breadcrumb.ts";
import {
    prepareBreadcrumbCandidate,
    type BreadcrumbLabelCandidate,
    type SanitizedBreadcrumb,
} from "./breadcrumb-label.ts";
import {
    createDisplayState,
    reduceCodexSessionEvent,
    reduceProgressUpdate,
    type DisplayState,
} from "./display-state.ts";
import {
    makeCodexTranscriptRenderer,
    type CodexTranscriptRenderer,
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
import { dim } from "./colors.ts";
import { renderFooter } from "./footer.ts";
import {
    makeTerminalOutputController,
    type TerminalFooterOptions,
    type TerminalOutputStrategy,
    type TerminalResizeListener,
    type TerminalResizeSubscription,
} from "./terminal-controller.ts";

/** Options for the shared progress/Codex output coordinator. */
export type ProgressCoordinatorOptions = Omit<
    ProgressRendererOptions,
    "output"
> & {
    /** Visible transcript rows required between breadcrumb opportunities. */
    readonly breadcrumbThreshold?: number;
    /** Alias for callers that use a generic cadence threshold. */
    readonly threshold?: number;
    /** Visible rendered rows required by the coordinator's breadcrumb policy. */
    readonly renderedLineThreshold?: number;
    /** Shared output sink, primarily useful for deterministic tests. */
    readonly output?: ProgressOutput;
    /** Injectable sticky-footer scheduler and view settings. */
    readonly footer?: Omit<TerminalFooterOptions, "footerLine">;
    /** Injectable terminal surface, useful for deterministic coordinator tests. */
    readonly strategy?: TerminalOutputStrategy;
    /** Injectable resize source; the default listens to stderr in interactive mode. */
    readonly resize?: TerminalResizeSubscription | TerminalResizeListener;
    /** Compatibility aliases for resize-source injection. */
    readonly onResize?: TerminalResizeListener;
    readonly subscribeResize?: TerminalResizeListener;
};

/**
 * The shared presentation boundary for one workflow run.
 *
 * The coordinator is the only owner of the output sink. Both event sources
 * update display state synchronously before their renderer is called, so a
 * writer observing an event always sees the state that describes that event.
 */
export type ProgressCoordinator = {
    readonly progress: ProgressReporterService;
    /** Listener to pass to the Codex service. */
    readonly codexListener?: CodexEventListener;
    /** Compatibility alias for callers that use the generic listener name. */
    readonly listener: CodexEventListener;
    /** Explicit event-listener alias for dependency wiring. */
    readonly codexEventListener?: CodexEventListener;
    /** Insert an approved breadcrumb through the transcript boundary. */
    readonly insertBreadcrumb?: (
        candidate: BreadcrumbLabelCandidate,
    ) => SanitizedBreadcrumb;
    readonly getDisplayState: () => DisplayState;
    readonly dispose: () => Promise<void>;
};

const transcriptFor = (
    options: ProgressCoordinatorOptions,
    output: ProgressOutput,
    getDisplayState: () => DisplayState,
    onSessionStart: () => void,
): CodexTranscriptRenderer | undefined => {
    if (options.mode === "quiet") return undefined;
    return makeCodexTranscriptRenderer({
        write: output.writeTranscript,
        colors: options.colors,
        json: options.mode === "json",
        verbose: options.verbose,
        width: options.width,
        getDisplayState,
        onSessionStart,
    });
};

const lifecycleBreadcrumbEvent = (event: CodexSessionEvent): boolean => {
    switch (event.type) {
        case "tool_execution_end":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
            return true;
        case "agent_end":
            return event.willRetry;
        default:
            return false;
    }
};

const closesTranscriptSession = (event: CodexSessionEvent): boolean =>
    event.type === "agent_end" || event.type === "agent_settled";

const policyCandidateFor = (
    candidate: BreadcrumbLabelCandidate,
    visibleLinePosition: number,
): BreadcrumbArbitrationCandidate["candidate"] => ({
    visibleLinePosition,
    key: candidate.canonicalKey,
});

const considerBreadcrumbEvent = (input: {
    readonly policy: BreadcrumbPolicy;
    readonly transcript: CodexTranscriptRenderer;
    /** Candidate describing the state after the lifecycle event. */
    readonly candidate: BreadcrumbLabelCandidate;
    /** Candidate pending from the state before the lifecycle event. */
    readonly periodicCandidate: BreadcrumbLabelCandidate;
    readonly visibleLinePosition: number;
    readonly lifecycle: boolean;
}): void => {
    const lifecycleCandidate = policyCandidateFor(
        input.candidate,
        input.visibleLinePosition,
    );
    const periodicCandidate = policyCandidateFor(
        input.periodicCandidate,
        input.visibleLinePosition,
    );
    const candidates: BreadcrumbArbitrationCandidate[] = [
        ...(input.lifecycle
            ? [{ kind: "lifecycle" as const, candidate: lifecycleCandidate }]
            : []),
        { kind: "periodic", candidate: periodicCandidate },
    ];
    const result = arbitrateBreadcrumbCandidates(input.policy, candidates);
    if (result.emitted === undefined) return;
    const emittedCandidate =
        result.emitted.kind === "lifecycle"
            ? input.candidate
            : input.periodicCandidate;
    input.transcript.insertBreadcrumb(emittedCandidate);
    input.policy.rebase(input.transcript.getVisibleLineCount());
};

const considerClosingBreadcrumb = (input: {
    readonly policy: BreadcrumbPolicy;
    readonly transcript: CodexTranscriptRenderer | undefined;
    readonly candidate: BreadcrumbLabelCandidate | undefined;
    readonly periodicCandidate: BreadcrumbLabelCandidate | undefined;
    readonly before: number;
    readonly closesSession: boolean;
    readonly lifecycle: boolean;
}): void => {
    if (
        input.transcript === undefined ||
        input.candidate === undefined ||
        input.periodicCandidate === undefined ||
        !input.closesSession ||
        !input.lifecycle
    ) {
        return;
    }
    considerBreadcrumbEvent({
        policy: input.policy,
        transcript: input.transcript,
        candidate: input.candidate,
        periodicCandidate: input.periodicCandidate,
        visibleLinePosition: input.before,
        lifecycle: input.lifecycle,
    });
};

const considerRenderedBreadcrumb = (input: {
    readonly policy: BreadcrumbPolicy;
    readonly transcript: CodexTranscriptRenderer | undefined;
    readonly candidate: BreadcrumbLabelCandidate | undefined;
    readonly periodicCandidate: BreadcrumbLabelCandidate | undefined;
    readonly eventOutputBaseline: number;
    readonly closesSession: boolean;
    readonly lifecycle: boolean;
}): void => {
    if (
        input.transcript === undefined ||
        input.candidate === undefined ||
        input.periodicCandidate === undefined ||
        input.closesSession
    ) {
        return;
    }
    const after = input.transcript.getVisibleLineCount();
    if (after <= input.eventOutputBaseline) return;
    considerBreadcrumbEvent({
        policy: input.policy,
        transcript: input.transcript,
        candidate: input.candidate,
        periodicCandidate: input.periodicCandidate,
        visibleLinePosition: after,
        lifecycle: input.lifecycle,
    });
};

/** Construct the ordered progress and Codex presentation services for a run. */
export const makeProgressCoordinator = (
    options: ProgressCoordinatorOptions,
) => {
    const now = options.now ?? (() => new Date());
    let state = createDisplayState();
    const footerWidth = options.footer?.width ?? options.width;
    const controller =
        options.mode === "interactive"
            ? makeTerminalOutputController({
                  mode: options.mode,
                  write: options.write,
                  strategy: options.strategy,
                  width: footerWidth,
                  resize: options.resize,
                  onResize: options.onResize,
                  subscribeResize: options.subscribeResize,
                  footer: {
                      ...options.footer,
                      footerLine: () =>
                          renderFooter(state, {
                              now,
                              width: footerWidth,
                              color: options.colors ? dim : undefined,
                          }),
                  },
              })
            : undefined;
    const output: ProgressOutput =
        controller ??
        options.output ??
        makeProgressOutput({
            mode: options.mode,
            write: options.write,
        });
    const progressRenderer = makeProgressReporter({
        ...options,
        output,
    });
    const breadcrumbPolicy = makeBreadcrumbPolicy({
        ...(options.breadcrumbThreshold === undefined
            ? {}
            : { breadcrumbThreshold: options.breadcrumbThreshold }),
        ...(options.threshold === undefined
            ? {}
            : { threshold: options.threshold }),
        ...(options.renderedLineThreshold === undefined
            ? {}
            : { renderedLineThreshold: options.renderedLineThreshold }),
    });
    let eventOutputBaseline = 0;
    let transcript: CodexTranscriptRenderer | undefined;
    transcript = transcriptFor(
        options,
        output,
        () => state,
        () => {
            eventOutputBaseline = transcript?.getVisibleLineCount() ?? 0;
            breadcrumbPolicy.reset(eventOutputBaseline);
        },
    );
    let disposed = false;

    const codexListener: CodexEventListener = (event, context) => {
        if (disposed) return;
        const before = transcript?.getVisibleLineCount() ?? 0;
        eventOutputBaseline = before;
        const lifecycle = lifecycleBreadcrumbEvent(event);
        const periodicCandidate =
            transcript === undefined
                ? undefined
                : breadcrumbCandidateFor(state);
        state = reduceCodexSessionEvent(state, event, context, now);
        controller?.invalidate();
        transcript?.interruptLine();
        const candidate =
            transcript === undefined
                ? undefined
                : breadcrumbCandidateFor(state);
        const pendingPeriodicCandidate = lifecycle
            ? periodicCandidate
            : candidate;
        const closesSession = closesTranscriptSession(event);
        considerClosingBreadcrumb({
            policy: breadcrumbPolicy,
            transcript,
            candidate,
            periodicCandidate: pendingPeriodicCandidate,
            before,
            closesSession,
            lifecycle,
        });
        transcript?.(event, context);
        considerRenderedBreadcrumb({
            policy: breadcrumbPolicy,
            transcript,
            candidate,
            periodicCandidate: pendingPeriodicCandidate,
            eventOutputBaseline,
            closesSession,
            lifecycle,
        });
    };

    const progress: ProgressReporterService = {
        emit: async (update: ProgressUpdate) => {
            if (disposed) return;
            state = reduceProgressUpdate(state, update, now);
            controller?.invalidate();
            transcript?.interruptLine();
            await progressRenderer.emit(update);
        },
        writeRaw: (text) => {
            if (disposed || text.length === 0) return;
            transcript?.interruptLine();
            progressRenderer.writeRaw?.(text);
        },
        stopPersisting: progressRenderer.stopPersisting,
    };

    const insertBreadcrumb = (
        candidate: BreadcrumbLabelCandidate,
    ): SanitizedBreadcrumb => {
        const prepared = prepareBreadcrumbCandidate(candidate);
        if (disposed) return prepared;
        return transcript?.insertBreadcrumb(candidate) ?? prepared;
    };

    return {
        progress,
        codexListener,
        listener: codexListener,
        codexEventListener: codexListener,
        insertBreadcrumb,
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

export type { CodexEventContext, CodexSessionEvent };
export type { ProgressRenderMode };