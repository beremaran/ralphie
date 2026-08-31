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
} from "../../src/pi/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import {
    createDisplayState,
    reducePiSessionEvent,
    reduceProgressUpdate,
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

export type RuntimeScenarioEmission =
    | { readonly kind: "progress"; readonly event: ProgressUpdate }
    | RuntimeScenarioPiEvent;

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
};

export type CommandRuntimeHarnessOptions = {
    readonly scenario?: RuntimeScenarioOracle;
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
    let state = createDisplayState();
    const expectedDisplayStates = [state];
    for (const emission of emissions) {
        state =
            emission.kind === "progress"
                ? reduceProgressUpdate(
                      state,
                      emission.event,
                      () => new Date(SCENARIO_TIME),
                  )
                : reducePiSessionEvent(
                      state,
                      emission.event,
                      emission.context,
                      () => new Date(SCENARIO_TIME),
                  );
        expectedDisplayStates.push(state);
    }
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
    const runCaptures: CommandRuntimeRunCapture[] = [];
    const abortController = new AbortController();
    let eventLogPath: string | undefined;
    let activeCapture: CommandRuntimeRunCapture | undefined;
    let listener: PiEventListener | undefined;
    let disposeCoordinator: (() => Promise<void>) | undefined;
    let disposeRuntime: (() => Promise<void>) | undefined;
    let failure: Error | undefined;
    let runtimeDisposalFailure: Error | undefined;
    let runtime: CommandRuntime | undefined;
    let getDisplayState: (() => DisplayState) | undefined;
    let cleaned = false;

    const recordState = (state: DisplayState): void => {
        activeCapture?.displayStates.push(state);
    };

    const factories: CommandFactories = {
        makeCoordinator: (coordinatorOptions) => {
            eventLogPath = coordinatorOptions.eventLogPath;
            if (eventLogPath !== undefined) eventLogPaths.push(eventLogPath);
            const coordinator = makeProgressCoordinator({
                ...coordinatorOptions,
                ...(scenario === undefined
                    ? {}
                    : { now: () => new Date(SCENARIO_TIME) }),
                colors: false,
            });
            getDisplayState = coordinator.getDisplayState;
            if (activeCapture !== undefined) {
                activeCapture.eventLogPath = eventLogPath;
                activeCapture.displayStates.push(coordinator.getDisplayState());
            }
            let disposed = false;
            disposeCoordinator = async () => {
                if (disposed) return;
                disposed = true;
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
            return { start: async () => undefined as never };
        },
        makeRuntime: ({ pi, progress }) => {
            lifecycle.push("runtime");
            let disposed = false;
            disposeRuntime = async () => {
                if (disposed) return;
                disposed = true;
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
            runtime = {
                ...services,
                pi,
                progress,
                dispose: disposeRuntime,
            } as CommandRuntime;
            return runtime;
        },
        runWorkflow: async (_options, currentRuntime) => {
            lifecycle.push("workflow");
            if (failure !== undefined) throw failure;
            if (scenario === undefined) {
                await currentRuntime.progress.emit({
                    stage: "implementation",
                    status: "started",
                    message: "Fake progress",
                });
                listener?.(
                    {
                        type: "message_update",
                        assistantMessageEvent: {
                            type: "text_delta",
                            delta: "fake Pi event",
                        },
                    } as PiSessionEvent,
                    {
                        sessionID: "fake-session",
                        directory: "/fake/workspace",
                    },
                );
                return undefined as never;
            }
            for (const emission of scenario.emissions) {
                if (emission.kind === "progress") {
                    await currentRuntime.progress.emit(emission.event);
                } else {
                    listener?.(emission.event, emission.context);
                }
            }
            return undefined as never;
        },
    };

    const hasOption = (args: ReadonlyArray<string>, name: string): boolean =>
        args.some((arg) => arg === name || arg.startsWith(`${name}=`));

    const run = async (
        args: ReadonlyArray<string> = ["owner/repository", "--dry-run"],
        terminal = { isInteractive: false, isCI: true, width: 80 },
    ): Promise<void> => {
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
            activeCapture = undefined;
        }
    };

    const dispose = async (): Promise<void> => {
        let cleanupError: unknown;
        try {
            await disposeRuntime?.();
        } catch (error) {
            cleanupError = error;
        }
        try {
            await disposeCoordinator?.();
        } catch (error) {
            cleanupError ??= error;
        }
        if (!cleaned) {
            cleaned = true;
            try {
                await rm(workspace, { recursive: true, force: true });
            } catch (error) {
                cleanupError ??= error;
            }
        }
        if (cleanupError !== undefined) throw cleanupError;
    };

    return {
        stdout,
        stderr,
        lifecycle,
        piEvents,
        eventLogPaths,
        runCaptures,
        abortController,
        workspace,
        scenario,
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
                    ? { isInteractive: false, isCI: false, width: 80 }
                    : { isInteractive: false, isCI: true, width: 80 };
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
