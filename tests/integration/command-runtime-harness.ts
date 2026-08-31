import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    runCommand,
    type CommandFactories,
    type CommandRuntime,
} from "../../src/command.ts";
import type {
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
    PiClient,
} from "../../src/pi/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import {
    makeProgressOutput,
    type ProgressOutput,
} from "../../src/progress/progress.ts";
import type { PiRuntime } from "../../src/pi/server.ts";
import {
    createDisplayState,
    type DisplayState,
} from "../../src/progress/display-state.ts";
import type { ProgressUpdate } from "../../src/progress/progress.ts";

const SCENARIO_TIME = new Date("2026-01-02T03:04:05.000Z");
const SCENARIO_SECRET = "github_pat_runtime_scenario_secret";

export type RuntimeScenarioPiEvent = {
    readonly kind: "pi";
    readonly event: PiSessionEvent;
    readonly context: PiEventContext;
};

export type CommandRuntimeHarnessStep =
    | { readonly kind: "progress"; readonly event: ProgressUpdate }
    | RuntimeScenarioPiEvent
    | {
          readonly kind: "wait-for-signal";
          /** Defaults to the signal supplied to runCommand. */
          readonly signal?: AbortSignal;
      }
    | {
          /** Short alias useful for focused harness tests. */
          readonly kind: "wait";
          /** Defaults to the signal supplied to runCommand. */
          readonly signal?: AbortSignal;
      }
    | { readonly kind: "failure"; readonly error: Error };

export type RuntimeScenarioEmission = Extract<
    CommandRuntimeHarnessStep,
    { readonly kind: "progress" | "pi" }
>;

export type RuntimeScenarioOracle = {
    /** The ordered source stream used to drive the command/runtime boundary. */
    readonly emissions: ReadonlyArray<RuntimeScenarioEmission>;
    readonly progressEvents: ReadonlyArray<ProgressUpdate>;
    readonly piEvents: ReadonlyArray<RuntimeScenarioPiEvent>;
    /** Includes the initial state, followed by one state per source emission. */
    readonly expectedDisplayStates: ReadonlyArray<DisplayState>;
    readonly secret: string;
};

export type CommandRuntimeRunCapture = {
    readonly args: ReadonlyArray<string>;
    readonly stdout: string[];
    readonly stderr: string[];
    readonly displayStates: DisplayState[];
    readonly piEvents: RuntimeScenarioPiEvent[];
    eventLogPath?: string;
    eventLogContents?: string;
    eventLog?: string;
};

export type CommandRuntimeHarnessOptions = {
    readonly scenario?: RuntimeScenarioOracle;
    /** Explicit ordered source steps for focused lifecycle tests. */
    readonly steps?: ReadonlyArray<CommandRuntimeHarnessStep>;
    /** Width passed to the real transcript and progress renderers. */
    readonly terminalWidth?: number;
    /** Short alias for terminalWidth. */
    readonly width?: number;
    /** Visible rendered rows between breadcrumb opportunities. */
    readonly renderedLineThreshold?: number;
    /** Compatibility aliases for the coordinator's cadence option. */
    readonly breadcrumbThreshold?: number;
    readonly threshold?: number;
};

const piEvent = (event: object): PiSessionEvent =>
    event as unknown as PiSessionEvent;

const scenarioPi = (event: object, issue: number): RuntimeScenarioPiEvent => ({
    kind: "pi",
    event: piEvent(event),
    context: {
        sessionID: `scenario-session-${issue}`,
        directory: `/tmp/ralphie-runtime-scenario/issue-${issue}`,
        title: `Issue #${issue} scenario`,
    },
});

const scenarioProgress = (
    stage: ProgressUpdate["stage"],
    status: ProgressUpdate["status"],
    message: string,
    context: Omit<ProgressUpdate, "stage" | "status" | "message"> = {},
): RuntimeScenarioEmission => ({
    kind: "progress",
    event: { stage, status, message, ...context },
});

const makeMultiIssueRuntimeOracle = (): RuntimeScenarioOracle => {
    const issueOne = { number: 101, title: "Implement the first queued issue" };
    const issueTwo = {
        number: 102,
        title: "Implement the second queued issue",
    };
    const issueOneContext = {
        current: 1,
        total: 2,
        repository: "owner/repository",
        issue: issueOne,
    };
    const issueTwoContext = {
        current: 2,
        total: 2,
        repository: "owner/repository",
        issue: issueTwo,
    };
    const emissions: RuntimeScenarioEmission[] = [
        scenarioProgress(
            "repository-discovery",
            "started",
            `Discovering owner/repository with ${SCENARIO_SECRET}`,
            {
                repository: "owner/repository",
                details: { source: "fixture", secret: SCENARIO_SECRET },
            },
        ),
        scenarioProgress(
            "repository-discovery",
            "succeeded",
            "Repository identity confirmed.",
            { repository: "owner/repository" },
        ),
        scenarioProgress(
            "issue-discovery",
            "succeeded",
            "Discovered two queued issues.",
            { repository: "owner/repository", total: 2 },
        ),
        scenarioProgress(
            "issue-queue",
            "started",
            "Queued parent issue #100; activating leaf #101.",
            {
                ...issueOneContext,
                details: { parentIssue: 100, activeLeaf: 101 },
            },
        ),
        scenarioProgress(
            "issue-planning",
            "started",
            "Planning the active leaf issue.",
            {
                ...issueOneContext,
                details: { parentIssue: 100, activeLeaf: 101 },
            },
        ),
        scenarioProgress(
            "implementation",
            "started",
            `Implementing #101 with ${SCENARIO_SECRET}`,
            {
                ...issueOneContext,
                details: {
                    parentIssue: 100,
                    activeLeaf: 101,
                    secret: SCENARIO_SECRET,
                },
            },
        ),
        scenarioPi({ type: "agent_start" }, 101),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: { type: "thinking_start" },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: `Reasoning with ${SCENARIO_SECRET}`,
                },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: { type: "thinking_end" },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_start",
                    toolCall: { name: "read" },
                },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_end",
                    toolCall: { name: "read" },
                },
            },
            101,
        ),
        scenarioPi(
            {
                type: "tool_execution_start",
                toolCallId: "scenario-read-101",
                toolName: "read",
                args: { path: "README.md" },
            },
            101,
        ),
        scenarioPi(
            {
                type: "tool_execution_update",
                toolCallId: "scenario-read-101",
                toolName: "read",
                partialResult: { content: "fixture output" },
            },
            101,
        ),
        scenarioPi(
            {
                type: "tool_execution_end",
                toolCallId: "scenario-read-101",
                toolName: "read",
                result: { content: "fixture output" },
                isError: false,
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_start" },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "Implementation complete.",
                },
            },
            101,
        ),
        scenarioPi(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_end" },
            },
            101,
        ),
        scenarioPi({ type: "agent_end", messages: [], willRetry: true }, 101),
        scenarioPi(
            {
                type: "auto_retry_start",
                attempt: 2,
                maxAttempts: 3,
                delayMs: 0,
                errorMessage: `retrying ${SCENARIO_SECRET}`,
            },
            101,
        ),
        scenarioPi({ type: "auto_retry_end", attempt: 2, success: true }, 101),
        scenarioPi({ type: "agent_start" }, 101),
        scenarioPi({ type: "agent_end", messages: [], willRetry: false }, 101),
        scenarioPi({ type: "agent_settled" }, 101),
        scenarioProgress(
            "review",
            "started",
            "Reviewing the first issue (attempt 1/2).",
            { ...issueOneContext, attempt: 1, maxAttempts: 2 },
        ),
        scenarioProgress(
            "review",
            "failed",
            `Review found a defect involving ${SCENARIO_SECRET}`,
            {
                ...issueOneContext,
                attempt: 1,
                maxAttempts: 2,
                details: { finding: "fixture defect", secret: SCENARIO_SECRET },
            },
        ),
        scenarioProgress(
            "review-fix",
            "started",
            "Addressing review findings (attempt 1/2).",
            { ...issueOneContext, attempt: 1, maxAttempts: 2 },
        ),
        scenarioProgress(
            "review",
            "started",
            "Reviewing the first issue (attempt 2/2).",
            { ...issueOneContext, attempt: 2, maxAttempts: 2 },
        ),
        scenarioProgress(
            "review",
            "succeeded",
            "Review passed on retry attempt 2/2.",
            { ...issueOneContext, attempt: 2, maxAttempts: 2 },
        ),
        scenarioProgress(
            "issue-closure",
            "succeeded",
            "First queued issue succeeded.",
            { ...issueOneContext },
        ),
        scenarioProgress(
            "issue-queue",
            "started",
            "Activating the second queued issue.",
            {
                ...issueTwoContext,
                details: { parentIssue: 100, activeLeaf: 102 },
            },
        ),
        scenarioProgress(
            "implementation",
            "started",
            "Implementing the second queued issue.",
            { ...issueTwoContext },
        ),
        scenarioProgress(
            "implementation",
            "failed",
            "Second queued issue failed verification.",
            { ...issueTwoContext, details: { failure: "fixture failure" } },
        ),
    ];
    // This sequence is the hand-authored source oracle for the scenario. Keep
    // it independent from the display-state reducer so reducer regressions
    // cannot update both the implementation and its expected values.
    const stageStartedAt = SCENARIO_TIME.getTime();
    const initialState: DisplayState = {
        activity: "waiting",
        activityLabel: "Waiting",
    };
    const repositoryState = {
        activity: "waiting",
        activityLabel: "Waiting",
        repository: "owner/repository",
        stageStartedAt,
    } as const;
    const issueOneState = {
        ...repositoryState,
        issue: {
            current: 1,
            total: 2,
            number: 101,
            title: "Implement the first queued issue",
        },
        parentIssue: 100,
        activeLeaf: 101,
    } as const;
    const issueOneClosureState = {
        ...repositoryState,
        issue: issueOneState.issue,
        parentIssue: 100,
    } as const;
    const issueTwoState = {
        ...repositoryState,
        issue: {
            current: 2,
            total: 2,
            number: 102,
            title: "Implement the second queued issue",
        },
        parentIssue: 100,
        activeLeaf: 102,
    } as const;
    const expectedDisplayStates: ReadonlyArray<DisplayState> = [
        initialState,
        {
            ...repositoryState,
            stage: "repository-discovery",
            status: "started",
        },
        {
            ...repositoryState,
            stage: "repository-discovery",
            status: "succeeded",
        },
        {
            ...repositoryState,
            stage: "issue-discovery",
            status: "succeeded",
        },
        {
            ...issueOneState,
            stage: "issue-queue",
            status: "started",
        },
        {
            ...issueOneState,
            stage: "issue-planning",
            status: "started",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "thinking",
            activityLabel: "Thinking",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "thinking",
            activityLabel: "Thinking",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "thinking",
            activityLabel: "Thinking",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "thinking",
            activityLabel: "Thinking",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "tool",
            activityLabel: "Using read",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "tool",
            activityLabel: "Using read",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "tool",
            activityLabel: "Using read",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "tool",
            activityLabel: "Using read",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "waiting",
            activityLabel: "Waiting",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "responding",
            activityLabel: "Responding",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "responding",
            activityLabel: "Responding",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "responding",
            activityLabel: "Responding",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "retrying",
            activityLabel: "Retrying",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "retrying",
            activityLabel: "Retrying",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "waiting",
            activityLabel: "Waiting",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "thinking",
            activityLabel: "Thinking",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "waiting",
            activityLabel: "Waiting",
        },
        {
            ...issueOneState,
            stage: "implementation",
            status: "started",
            activity: "waiting",
            activityLabel: "Waiting",
        },
        {
            ...issueOneState,
            stage: "review",
            status: "started",
            reviewAttempt: { current: 1, total: 2 },
        },
        {
            ...issueOneState,
            stage: "review",
            status: "failed",
            reviewAttempt: { current: 1, total: 2 },
        },
        {
            ...issueOneState,
            stage: "review-fix",
            status: "started",
            reviewAttempt: { current: 1, total: 2 },
        },
        {
            ...issueOneState,
            stage: "review",
            status: "started",
            reviewAttempt: { current: 2, total: 2 },
        },
        {
            ...issueOneState,
            stage: "review",
            status: "succeeded",
            reviewAttempt: { current: 2, total: 2 },
        },
        {
            ...issueOneClosureState,
            stage: "issue-closure",
            status: "succeeded",
        },
        {
            ...issueTwoState,
            stage: "issue-queue",
            status: "started",
        },
        {
            ...issueTwoState,
            stage: "implementation",
            status: "started",
        },
        {
            ...issueTwoState,
            stage: "implementation",
            status: "failed",
        },
    ];
    return {
        emissions,
        progressEvents: emissions.flatMap((emission) =>
            emission.kind === "progress" ? [emission.event] : [],
        ),
        piEvents: emissions.flatMap((emission) =>
            emission.kind === "pi" ? [emission] : [],
        ),
        expectedDisplayStates,
        secret: SCENARIO_SECRET,
    };
};

/** Reusable deterministic multi-issue source and display-state oracle. */
export const multiIssueRuntimeOracle = makeMultiIssueRuntimeOracle();

export type CommandRuntimeHarness = ReturnType<
    typeof makeCommandRuntimeHarness
>;

const defaultSteps: ReadonlyArray<CommandRuntimeHarnessStep> = [
    {
        kind: "progress",
        event: {
            stage: "implementation",
            status: "started",
            message: "Fake progress",
        },
    },
    {
        kind: "pi",
        event: {
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                delta: "fake Pi event",
            },
        } as PiSessionEvent,
        context: {
            sessionID: "fake-session",
            directory: "/fake/workspace",
        },
    },
];

const fakeService = (name: string, lifecycle: string[]): object =>
    new Proxy(
        {},
        {
            get: (_target, operation) => async () => {
                lifecycle.push(`${name}.${String(operation)}`);
                return undefined;
            },
        },
    );

const waitForSignal = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
        const rejectOnAbort = (): void =>
            reject(signal.reason ?? new Error("Harness signal was aborted."));
        if (signal.aborted) {
            rejectOnAbort();
            return;
        }
        signal.addEventListener("abort", rejectOnAbort, { once: true });
    });

const requireWorkflowSignal = (
    signal: AbortSignal | undefined,
): AbortSignal => {
    if (signal === undefined) {
        throw new Error(
            "runCommand did not pass an AbortSignal to the fake workflow.",
        );
    }
    return signal;
};

const runHarnessStep = async (input: {
    readonly step: CommandRuntimeHarnessStep;
    readonly signal: AbortSignal;
    readonly progress: CommandRuntime["progress"];
    readonly emitPi: PiEventListener;
}): Promise<void> => {
    switch (input.step.kind) {
        case "progress":
            await input.progress.emit(input.step.event);
            return;
        case "pi":
            input.emitPi(input.step.event, input.step.context);
            return;
        case "failure":
            throw input.step.error;
        case "wait":
        case "wait-for-signal":
            await waitForSignal(input.step.signal ?? input.signal);
            return;
    }
};

/** Deterministic command boundary used by command/runtime integration tests. */
export const makeCommandRuntimeHarness = (
    options: CommandRuntimeHarnessOptions = {},
) => {
    const scenario = options.scenario;
    const workspace = mkdtempSync(join(tmpdir(), "ralphie-command-runtime-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const lifecycle: string[] = [];
    const piEvents: PiSessionEvent[] = [];
    const eventLogPaths: string[] = [];
    const eventLogContents: string[] = [];
    const runCaptures: CommandRuntimeRunCapture[] = [];
    const abortController = new AbortController();
    const workflowSignals: AbortSignal[] = [];
    const disposalCalls = {
        runtime: 0,
        coordinator: 0,
        piRuntime: 0,
        output: 0,
    };
    const writesAfterCleanup: string[] = [];
    let eventLogPath: string | undefined;
    const configuredWidth = options.terminalWidth ?? options.width ?? 80;
    const configuredThreshold =
        options.renderedLineThreshold ??
        options.breadcrumbThreshold ??
        options.threshold;
    let activeTerminalWidth = configuredWidth;
    let activeCapture: CommandRuntimeRunCapture | undefined;
    let listener: PiEventListener | undefined;
    let disposeCoordinator: (() => Promise<void>) | undefined;
    let disposeRuntime: (() => Promise<void>) | undefined;
    let failure: Error | undefined;
    let runtimeDisposalFailure: Error | undefined;
    let runtime: CommandRuntime | undefined;
    let piRuntime: PiRuntime | undefined;
    let outputDisposed = false;
    let getDisplayState: (() => DisplayState) | undefined;
    let cleaned = false;

    const recordState = (state: DisplayState): void => {
        activeCapture?.displayStates.push(state);
    };

    const factories: CommandFactories = {
        makeCoordinator: (coordinatorOptions) => {
            eventLogPath = coordinatorOptions.eventLogPath;
            if (eventLogPath !== undefined) eventLogPaths.push(eventLogPath);
            const baseOutput = makeProgressOutput({
                mode: coordinatorOptions.mode,
                write: coordinatorOptions.write,
            });
            outputDisposed = false;
            const observeOutputCall = (text: string): void => {
                if (outputDisposed) writesAfterCleanup.push(text);
            };
            const output: ProgressOutput = {
                beginLive: (line) => {
                    observeOutputCall(line);
                    baseOutput.beginLive(line);
                },
                appendLine: (line, liveLine) => {
                    observeOutputCall(line);
                    if (liveLine !== undefined) observeOutputCall(liveLine);
                    baseOutput.appendLine(line, liveLine);
                },
                writeLine: (line) => {
                    observeOutputCall(line);
                    baseOutput.writeLine(line);
                },
                writeTranscript: (text) => {
                    observeOutputCall(text);
                    baseOutput.writeTranscript(text);
                },
                dispose: () => {
                    disposalCalls.output += 1;
                    lifecycle.push("output.dispose");
                    baseOutput.dispose();
                    outputDisposed = true;
                },
            };
            const coordinator = makeProgressCoordinator({
                ...coordinatorOptions,
                ...(scenario === undefined
                    ? {}
                    : { now: () => new Date(SCENARIO_TIME) }),
                width: () => activeTerminalWidth,
                ...(configuredThreshold === undefined
                    ? {}
                    : { renderedLineThreshold: configuredThreshold }),
                output,
                colors: false,
            });
            getDisplayState = coordinator.getDisplayState;
            if (activeCapture !== undefined) {
                activeCapture.eventLogPath = eventLogPath;
                activeCapture.displayStates.push(coordinator.getDisplayState());
            }
            disposeCoordinator = async () => {
                disposalCalls.coordinator += 1;
                lifecycle.push("coordinator.dispose");
                await coordinator.dispose();
            };
            const originalProgress = coordinator.progress;
            return {
                ...coordinator,
                progress: {
                    ...originalProgress,
                    emit: async (update) => {
                        await originalProgress.emit(update);
                        recordState(coordinator.getDisplayState());
                    },
                },
                dispose: disposeCoordinator,
            };
        },
        makePi: (_config, piListener) => {
            lifecycle.push("pi");
            listener = (event, context) => {
                piEvents.push(event);
                activeCapture?.piEvents.push({ kind: "pi", event, context });
                piListener(event, context);
                recordState(getDisplayState?.() ?? createDisplayState());
            };
            const client: PiClient = {
                session: {
                    create: async () => {
                        lifecycle.push("pi.client.session.create");
                        return { data: { id: "fake-session" } };
                    },
                    prompt: async () => {
                        lifecycle.push("pi.client.session.prompt");
                        return {
                            data: {
                                info: {
                                    id: "fake-assistant",
                                    role: "assistant",
                                },
                                parts: [],
                            },
                        };
                    },
                },
                close: () => lifecycle.push("pi.client.close"),
            };
            return {
                start: async () => {
                    lifecycle.push("pi.start");
                    piRuntime = {
                        url: "embedded://fake-pi",
                        client,
                        close: async () => {
                            disposalCalls.piRuntime += 1;
                            lifecycle.push("pi.runtime.close");
                            client.close?.();
                        },
                    };
                    return piRuntime;
                },
            };
        },
        makeRuntime: ({ pi, progress }) => {
            lifecycle.push("runtime");
            disposeRuntime = async () => {
                disposalCalls.runtime += 1;
                lifecycle.push("runtime.dispose");
                if (runtimeDisposalFailure !== undefined) {
                    throw runtimeDisposalFailure;
                }
            };
            const serviceNames = [
                "commandRunner",
                "githubClient",
                "pipelineSnapshot",
                "pipelineObservation",
                "githubIssues",
                "githubIssueMutations",
                "githubPullRequests",
                "gitRepository",
                "gitRepositoryInvariant",
                "gitIssueCheckpoint",
                "gitIssueOperations",
                "gitIssuePreparation",
                "gitRemoteSafety",
                "issueArtifactStore",
                "complexityAssessment",
                "groundingAssessment",
                "decompositionExecutor",
                "implementationExecutor",
                "dryRunIssueExecutor",
                "issueExecutor",
                "issueRecovery",
                "runStateStore",
                "workspace",
            ] as const;
            const services = Object.fromEntries(
                serviceNames.map((name) => [
                    name,
                    fakeService(name, lifecycle),
                ]),
            );
            const observedProgress = {
                ...progress,
                emit: async (update: ProgressUpdate) => {
                    if (outputDisposed) {
                        writesAfterCleanup.push(JSON.stringify(update));
                    }
                    await progress.emit(update);
                },
                writeRaw: (text: string) => {
                    if (outputDisposed) writesAfterCleanup.push(text);
                    progress.writeRaw?.(text);
                },
            };
            runtime = {
                ...services,
                pi,
                progress: observedProgress,
                dispose: disposeRuntime,
            } as CommandRuntime;
            return runtime;
        },
        runWorkflow: async (workflowOptions, currentRuntime) => {
            lifecycle.push("workflow");
            if (failure !== undefined) throw failure;
            const signal = requireWorkflowSignal(workflowOptions.signal);
            workflowSignals.push(signal);
            const steps =
                options.steps ??
                (scenario === undefined ? defaultSteps : scenario.emissions);
            const startedRuntime = await currentRuntime.pi.start();
            piRuntime = startedRuntime;
            try {
                for (const step of steps) {
                    if (signal.aborted) signal.throwIfAborted();
                    await runHarnessStep({
                        step,
                        signal,
                        progress: currentRuntime.progress,
                        emitPi: (event, context) => listener?.(event, context),
                    });
                }
            } finally {
                await startedRuntime.close();
            }
            return undefined as never;
        },
    };

    const hasOption = (args: ReadonlyArray<string>, name: string): boolean =>
        args.some((arg) => arg === name || arg.startsWith(`${name}=`));

    const run = async (
        args: ReadonlyArray<string> = ["owner/repository", "--dry-run"],
        terminal = {
            isInteractive: false,
            isCI: true,
            width: configuredWidth,
        },
    ): Promise<void> => {
        activeTerminalWidth = terminal.width;
        const effectiveArgs = hasOption(args, "--workspace")
            ? [...args]
            : [...args, "--workspace", workspace];
        const capture: CommandRuntimeRunCapture = {
            args: effectiveArgs,
            stdout: [],
            stderr: [],
            displayStates: [],
            piEvents: [],
        };
        runCaptures.push(capture);
        activeCapture = capture;
        try {
            await runCommand(effectiveArgs, {
                signal: abortController.signal,
                terminal,
                factories,
                output: {
                    stdout: (text) => {
                        stdout.push(text);
                        capture.stdout.push(text);
                    },
                    stderr: (text) => {
                        stderr.push(text);
                        capture.stderr.push(text);
                    },
                },
            });
        } finally {
            const path = capture.eventLogPath;
            if (path !== undefined && (await Bun.file(path).exists())) {
                capture.eventLogContents = await readFile(path, "utf8");
                capture.eventLog = capture.eventLogContents;
                eventLogContents.push(capture.eventLogContents);
            }
            activeCapture = undefined;
        }
    };

    const dispose = async (): Promise<void> => {
        // runCommand owns runtime and coordinator disposal. This optional
        // teardown only removes the fixture workspace and must not mask a
        // missing or duplicate command cleanup before assertions run.
        if (cleaned) return;
        cleaned = true;
        await rm(workspace, { recursive: true, force: true });
    };

    return {
        stdout,
        stderr,
        lifecycle,
        piEvents,
        eventLogPaths,
        eventLogContents,
        runCaptures,
        abortController,
        workflowSignals,
        workspace,
        scenario,
        steps:
            options.steps ??
            (scenario === undefined ? defaultSteps : scenario.emissions),
        disposalCalls,
        writesAfterCleanup,
        get piRuntime() {
            return piRuntime;
        },
        get eventLogPath() {
            return eventLogPath;
        },
        get runtime() {
            return runtime;
        },
        failWith(error: Error) {
            failure = error;
        },
        failRuntimeDisposalWith(error: Error) {
            runtimeDisposalFailure = error;
        },
        readEventLog: async (path = eventLogPath): Promise<string> => {
            if (path === undefined) return "";
            return await readFile(path, "utf8");
        },
        cleanup: dispose,
        dispose,
        run,
        runMode: (mode: "default" | "ci" | "quiet" | "json") => {
            const terminal =
                mode === "default"
                    ? {
                          isInteractive: false,
                          isCI: false,
                          width: configuredWidth,
                      }
                    : {
                          isInteractive: false,
                          isCI: true,
                          width: configuredWidth,
                      };
            const args =
                mode === "default" || mode === "ci"
                    ? ["owner/repository", "--dry-run"]
                    : ["owner/repository", "--dry-run", "--output", mode];
            return run(args, terminal);
        },
    };
};

/** Harness preloaded with the complete cross-mode runtime scenario. */
export const makeMultiIssueRuntimeHarness = () =>
    makeCommandRuntimeHarness({ scenario: multiIssueRuntimeOracle });
