// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: command orchestration has explicit setup and cleanup branches

/**
 * The get-pipelines-green command is the CLI adapter for Pipeline delivery.
 * Authentication, workspace cleanup, OpenCode lifetime, and exit semantics
 * stay here; the delivery lifecycle owns repository preparation, state,
 * observation, repair, push reconciliation, resume, and dry-run behavior.
 */
import { makeAgentSessionDiagnostics } from "./agent/task-session.ts";
import type { AgentSelection } from "./agent/model.ts";
import {
    DEFAULT_PIPELINE_TIMEOUT,
    durationToMilliseconds,
    type GetPipelinesGreenRalphieConfig,
} from "./options.ts";
import type {
    ProgressReporterService,
    ProgressStage,
} from "./progress/progress.ts";
import type { OpenCodeRuntime } from "./opencode/server.ts";
import type { RalphieRuntime } from "./runtime.ts";
import type {
    PipelineDeliveryContext,
    PipelineDeliveryOutcome,
    PipelineDeliveryRequest,
    PipelineDeliveryResult,
} from "./pipeline/delivery-types.ts";
import { RalphieError } from "./shared/error.ts";

export type GetPipelinesGreenOptions = {
    readonly config: GetPipelinesGreenRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
};

export type PipelineRunSummary = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly statePath: string;
    readonly outcome: PipelineDeliveryOutcome;
    readonly dryRun: boolean;
    /** True when dry-run found a repairable failure but made no edits. */
    readonly wouldRepair: boolean;
};

export type GetPipelinesGreenEntryPoint = (
    options: GetPipelinesGreenOptions,
    runtime: RalphieRuntime,
) => Promise<PipelineRunSummary>;

export class PipelineDeliveryOutcomeError extends RalphieError {
    override readonly _tag = "PipelineDeliveryOutcomeError" as const;
    readonly outcome: PipelineDeliveryOutcome;

    constructor(outcome: PipelineDeliveryOutcome) {
        super({
            message:
                outcome.message ??
                `Pipeline delivery stopped with outcome ${outcome.kind}.`,
        });
        this.name = "PipelineDeliveryOutcomeError";
        this.outcome = outcome;
    }
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const checkCancellation = (signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
};

const track = async <Value>(input: {
    readonly progress: ProgressReporterService;
    readonly stage: ProgressStage;
    readonly message: string;
    readonly operation: () => Promise<Value>;
    readonly success: string | ((value: Value) => string);
    readonly repository?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}): Promise<Value> => {
    await input.progress.emit({
        stage: input.stage,
        status: "started",
        message: input.message,
        ...(input.repository === undefined
            ? {}
            : { repository: input.repository }),
        ...(input.details === undefined ? {} : { details: input.details }),
    });
    try {
        const value = await input.operation();
        await input.progress.emit({
            stage: input.stage,
            status: "succeeded",
            message:
                typeof input.success === "function"
                    ? input.success(value)
                    : input.success,
            ...(input.repository === undefined
                ? {}
                : { repository: input.repository }),
            ...(input.details === undefined ? {} : { details: input.details }),
        });
        return value;
    } catch (error) {
        await input.progress.emit({
            stage: input.stage,
            status: "failed",
            message: `${input.message.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
            ...(input.repository === undefined
                ? {}
                : { repository: input.repository }),
            ...(input.details === undefined ? {} : { details: input.details }),
        });
        throw error;
    }
};

const requestFor = (input: {
    readonly config: GetPipelinesGreenRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
    readonly client: Awaited<
        ReturnType<RalphieRuntime["githubClient"]["initialize"]>
    >;
    readonly startServer: () => Promise<OpenCodeRuntime>;
}): PipelineDeliveryRequest => {
    const context: PipelineDeliveryContext = {
        repository: input.config.repo,
        ...(input.config.branch === undefined
            ? {}
            : { branch: input.config.branch }),
        workspace: input.config.workspace,
        runId: input.runId,
        maxAttempts: input.config.maxAttempts,
        pipelineTimeoutMs: durationToMilliseconds(
            input.config.pipelineTimeout ?? DEFAULT_PIPELINE_TIMEOUT,
        ),
        client: input.client,
        signal: input.signal,
    };

    if (input.config.dryRun) {
        return input.config.resume === undefined
            ? { mode: "dry-run", context }
            : {
                  mode: "resume",
                  resumePath: input.config.resume,
                  dryRun: true,
                  context,
              };
    }

    const selection: AgentSelection = {
        agent: input.config.agent,
        ...(input.config.model === undefined
            ? {}
            : { model: input.config.model }),
        ...(input.config.thinking === undefined
            ? {}
            : { variant: input.config.thinking }),
    };
    return input.config.resume === undefined
        ? {
              mode: "live",
              context,
              acquireAgent: async () => {
                  const server = await input.startServer();
                  return {
                      agent: server.client,
                      agentSelection: selection,
                      agentDiagnostics: makeAgentSessionDiagnostics(),
                  };
              },
          }
        : {
              mode: "resume",
              resumePath: input.config.resume,
              context,
              acquireAgent: async () => {
                  const server = await input.startServer();
                  return {
                      agent: server.client,
                      agentSelection: selection,
                      agentDiagnostics: makeAgentSessionDiagnostics(),
                  };
              },
          };
};

const summaryFrom = (input: {
    readonly result: PipelineDeliveryResult;
    readonly dryRun: boolean;
}): PipelineRunSummary => ({
    ...input.result,
    dryRun: input.dryRun,
});

/** Execute get-pipelines-green through the runtime's explicit seams. */
export const getPipelinesGreen: GetPipelinesGreenEntryPoint = async (
    options,
    runtime,
): Promise<PipelineRunSummary> => {
    const { config } = options;
    let server: OpenCodeRuntime | undefined;
    try {
        if (config.cleanStart && config.resume === undefined) {
            await track({
                progress: runtime.progress,
                stage: "workspace-cleanup",
                message: `Removing existing workspace ${config.workspace}...`,
                operation: () => runtime.workspace.remove(config.workspace),
                success: `Existing workspace removed: ${config.workspace}.`,
                repository: config.repo,
            });
        }
        await track({
            progress: runtime.progress,
            stage: "workspace-preparation",
            message: `Preparing workspace ${config.workspace}...`,
            operation: () => runtime.workspace.prepare(config.workspace),
            success: `Workspace ready: ${config.workspace}.`,
            repository: config.repo,
        });
        checkCancellation(options.signal);
        const octokit = await track({
            progress: runtime.progress,
            stage: "github-authentication",
            message: "Checking GitHub authentication...",
            operation: () => runtime.githubClient.initialize(),
            success: "GitHub authentication verified and Octokit initialized.",
            repository: config.repo,
        });
        checkCancellation(options.signal);
        await track({
            progress: runtime.progress,
            stage: "git-verification",
            message: "Checking Git installation...",
            operation: () => runtime.gitRepository.verifyInstalled(),
            success: "Git installation verified.",
            repository: config.repo,
        });
        checkCancellation(options.signal);

        const startServer = async (): Promise<OpenCodeRuntime> => {
            if (server !== undefined) return server;
            server = await track({
                progress: runtime.progress,
                stage: "opencode-runtime",
                message: "Starting OpenCode runtime...",
                operation: () => runtime.opencode.start(),
                success: "OpenCode runtime ready.",
                repository: config.repo,
            });
            return server;
        };

        const result = await runtime.pipelineDeliveryLifecycle.execute(
            requestFor({
                config,
                runId: options.runId,
                signal: options.signal,
                client: octokit,
                startServer,
            }),
        );
        if (result.outcome.kind !== "green") {
            throw new PipelineDeliveryOutcomeError(result.outcome);
        }
        if (config.cleanEnd) {
            await track({
                progress: runtime.progress,
                stage: "workspace-cleanup",
                message: `Removing completed workspace ${config.workspace}...`,
                operation: () => runtime.workspace.remove(config.workspace),
                success: `Completed workspace removed: ${config.workspace}.`,
                repository: config.repo,
            });
        }
        return summaryFrom({ result, dryRun: config.dryRun });
    } finally {
        await server?.close();
    }
};

export const runGetPipelinesGreen = getPipelinesGreen;