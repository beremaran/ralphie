import {
    runCommand,
    type CommandFactories,
    type CommandRuntime,
} from "../../src/command.ts";
import type { PiEventListener, PiSessionEvent } from "../../src/pi/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";

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
export const makeCommandRuntimeHarness = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const lifecycle: string[] = [];
    const piEvents: PiSessionEvent[] = [];
    const abortController = new AbortController();
    let eventLogPath: string | undefined;
    let listener: PiEventListener | undefined;
    let disposeCoordinator: (() => Promise<void>) | undefined;
    let disposeRuntime: (() => Promise<void>) | undefined;
    let failure: Error | undefined;
    let runtimeDisposalFailure: Error | undefined;
    let runtime: CommandRuntime | undefined;

    const factories: CommandFactories = {
        makeCoordinator: (options) => {
            eventLogPath = options.eventLogPath;
            const coordinator = makeProgressCoordinator({
                ...options,
                colors: false,
            });
            let disposed = false;
            disposeCoordinator = async () => {
                if (disposed) return;
                disposed = true;
                lifecycle.push("coordinator.dispose");
                await coordinator.dispose();
            };
            return { ...coordinator, dispose: disposeCoordinator };
        },
        makePi: (_config, piListener) => {
            lifecycle.push("pi");
            listener = (event, context) => {
                piEvents.push(event);
                piListener(event, context);
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
                { sessionID: "fake-session", directory: "/fake/workspace" },
            );
            return undefined as never;
        },
    };

    return {
        stdout,
        stderr,
        lifecycle,
        piEvents,
        abortController,
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
        dispose: async () => {
            await disposeRuntime?.();
            await disposeCoordinator?.();
        },
        run: (
            args: ReadonlyArray<string> = ["owner/repository", "--dry-run"],
        ) =>
            runCommand(args, {
                signal: abortController.signal,
                terminal: { isInteractive: false, isCI: true, width: 80 },
                factories,
                output: {
                    stdout: (text) => stdout.push(text),
                    stderr: (text) => stderr.push(text),
                },
            }),
    };
};