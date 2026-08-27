import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    WorkflowMode,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { piModelSchema, piModelVariantSchema } from "./agent/model.ts";
import {
    makeProgressReporter,
    ProgressRenderMode,
} from "./progress/progress.ts";
import { type PiProviderConfig } from "./pi/config.ts";
import { makePiService } from "./pi/server.ts";
import { makeLiveRuntime } from "./runtime.ts";
import { exitCodeForFailure } from "./process/exit-code.ts";
import { workflow } from "./workflow.ts";
import { redactSensitiveText } from "./shared/redaction.ts";
import { type RunState, RunStateStoreLive } from "./run/state.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";

const cliOptions = {
    branch: { type: "string", short: "b" },
    workflow: { type: "string" },
    "issue-concurrency": { type: "string" },
    "agent-concurrency": { type: "string" },
    "max-issues": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    "issue-order": { type: "string" },
    model: { type: "string" },
    "model-variant": { type: "string" },
    "model-base-url": { type: "string" },
    "api-key": { type: "string" },
    "model-provider": { type: "string" },
    "model-id": { type: "string" },
    "agent-dir": { type: "string" },
    agent: { type: "string" },
    verbose: { type: "boolean" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    "dry-run": { type: "boolean" },
    workspace: { type: "string" },
    cleanup: { type: "boolean" },
    "start-clean": { type: "boolean" },
    resume: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
} as const;

type ParsedCli = {
    readonly help: boolean;
    readonly version: boolean;
    readonly options: Parameters<typeof resolveRalphieConfig>[0];
};

const asString = (
    values: Record<string, unknown>,
    name: string,
): string | undefined => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new Error(`Option --${name} requires a string value.`);
    }
    return value;
};

const asNonEmptyString = (
    values: Record<string, unknown>,
    name: string,
): string | undefined => {
    const value = asString(values, name);
    return value === undefined
        ? undefined
        : z.string().trim().min(1).parse(value);
};

const asNumber = (
    values: Record<string, unknown>,
    name: string,
): number | undefined => {
    const value = asString(values, name);
    return value === undefined
        ? undefined
        : z.coerce.number().int().positive().parse(value);
};

const asBoolean = (values: Record<string, unknown>, name: string): boolean =>
    values[name] === true;

/** Parse the public `ralphie <repository> [options]` command line. */
export const parseCliArgs = (args: ReadonlyArray<string>): ParsedCli => {
    const parsed = parseArgs({
        args: [...args],
        options: cliOptions,
        allowPositionals: true,
        strict: true,
    });
    if (parsed.positionals.length > 1) {
        throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }

    const values = parsed.values as Record<string, unknown>;
    const labels = values["issue-label"];
    if (
        labels !== undefined &&
        !Array.isArray(labels) &&
        typeof labels !== "string"
    ) {
        throw new Error("Option --issue-label requires a value.");
    }
    const issueLabels =
        labels === undefined
            ? undefined
            : (Array.isArray(labels) ? labels : [labels]).map((label) =>
                  z.string().trim().min(1).parse(label),
              );
    const modelValue = asString(values, "model");

    return {
        help: asBoolean(values, "help"),
        version: asBoolean(values, "version"),
        options: {
            repo: parsed.positionals[0],
            branch: asString(values, "branch"),
            workflow:
                asString(values, "workflow") === undefined
                    ? undefined
                    : z.enum(WorkflowMode).parse(asString(values, "workflow")),
            issueConcurrency: asNumber(values, "issue-concurrency"),
            agentConcurrency: asNumber(values, "agent-concurrency"),
            maxIssues: asNumber(values, "max-issues"),
            issueLabels,
            issueSort:
                asString(values, "issue-sort") === undefined
                    ? undefined
                    : z.enum(IssueSort).parse(asString(values, "issue-sort")),
            issueOrder:
                asString(values, "issue-order") === undefined
                    ? undefined
                    : z.enum(IssueOrder).parse(asString(values, "issue-order")),
            model:
                modelValue === undefined
                    ? undefined
                    : piModelSchema.parse(modelValue),
            modelVariant:
                asNonEmptyString(values, "model-variant") === undefined
                    ? undefined
                    : piModelVariantSchema.parse(
                          asNonEmptyString(values, "model-variant"),
                      ),
            modelBaseUrl: asNonEmptyString(values, "model-base-url"),
            modelApiKey: asNonEmptyString(values, "api-key"),
            modelProvider: asNonEmptyString(values, "model-provider"),
            modelId: asNonEmptyString(values, "model-id"),
            agentDir: asNonEmptyString(values, "agent-dir"),
            agent: asNonEmptyString(values, "agent"),
            workspace: asNonEmptyString(values, "workspace"),
            cleanup: asBoolean(values, "cleanup"),
            startClean: asBoolean(values, "start-clean"),
            dryRun: asBoolean(values, "dry-run"),
            resume: asNonEmptyString(values, "resume"),
            verbose: asBoolean(values, "verbose"),
            json: asBoolean(values, "json"),
            quiet: asBoolean(values, "quiet"),
        },
    };
};

const resolvePiConfig = (config: ResolvedRalphieConfig): PiProviderConfig => ({
    workspace: config.workspace,
    modelBaseUrl: config.modelBaseUrl,
    modelApiKey: config.modelApiKey,
    modelProvider: config.modelProvider ?? config.model?.providerID,
    modelId: config.modelId ?? config.model?.modelID,
    agentDir: config.agentDir,
});

export type CliTerminalInfo = {
    readonly isInteractive: boolean;
    readonly isCI: boolean;
    readonly width: number;
};

export const terminalInfo = (): CliTerminalInfo => ({
    isInteractive:
        process.stdin.isTTY === true && process.stderr.isTTY === true,
    isCI: process.env.CI === "true" || process.env.CI === "1",
    width: process.stderr.columns ?? 80,
});

const resolveProgressMode = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
): ProgressRenderMode => {
    if (config.json) return ProgressRenderMode.Json;
    if (config.quiet) return ProgressRenderMode.Quiet;
    if (terminal.isInteractive && !terminal.isCI && process.stderr.isTTY) {
        return ProgressRenderMode.Interactive;
    }
    return ProgressRenderMode.Plain;
};

export const HELP_TEXT = `Usage: ralphie <owner/repository> [options]

Run a GitHub issue queue through Pi.

Options:
  -b, --branch <name>          Branch to operate on
      --workflow <mode>        lgtm, pr, or parallel-pr
      --issue-concurrency <n>  Concurrent issues in parallel-pr mode
      --agent-concurrency <n>  Maximum concurrent Pi tasks
      --max-issues <n>         Maximum issues to process
      --issue-label <label>    Include only issues with this label (repeatable)
      --issue-sort <field>     created, updated, or comments
      --issue-order <order>    asc or desc
      --model <provider/model> Pi model selection
      --model-variant <level>  Pi thinking level
      --model-base-url <url>   OpenAI-compatible model base URL
      --api-key <key>          Model API key
      --model-provider <id>    Model provider id
      --model-id <id>          Model id
      --agent-dir <path>       Existing Pi agent directory
      --agent <name>            Pi agent name (default: build)
      --workspace <path>       Workspace directory
      --resume <path>          Resume saved run state
      --verbose                Include detailed progress
      --json                   Emit JSON Lines progress
      --quiet                  Emit failures only
      --dry-run                Assess without mutations
      --cleanup                Remove workspace after success
      --start-clean            Remove workspace before starting
  -h, --help                   Show this help
  -v, --version                Show version
`;

type RunCommandInput = {
    readonly signal?: AbortSignal;
    readonly terminal?: CliTerminalInfo;
};

const loadResumeState = async (
    config: ResolvedRalphieConfig,
): Promise<RunState | undefined> => {
    if (config.resume === undefined) return undefined;

    const resumeState = await RunStateStoreLive.load(config.resume);
    if (config.branch === undefined) return resumeState;

    const reconciliation = reconcileRunState(resumeState, {
        repository: config.repo,
        branch: config.branch,
    });
    if (!reconciliation.compatible) {
        throw new Error(
            `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
        );
    }
    return resumeState;
};

const eventLogPathFor = (
    config: ResolvedRalphieConfig,
    runId: string,
): string =>
    config.resume === undefined
        ? join(
              resolveWorkspacePath(config.workspace),
              ".ralphie",
              "runs",
              runId,
              "events.jsonl",
          )
        : join(dirname(config.resume), "events.jsonl");

const makeCommandProgress = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
    runId: string,
): ReturnType<typeof makeProgressReporter> =>
    makeProgressReporter({
        mode: resolveProgressMode(config, terminal),
        verbose: config.verbose,
        width: () => process.stderr.columns ?? terminal.width,
        write: config.json
            ? (text) => process.stdout.write(text)
            : (text) => process.stderr.write(text),
        runId,
        eventLogPath: eventLogPathFor(config, runId),
    });

const workflowOptionsFor = (
    config: ResolvedRalphieConfig,
    input: RunCommandInput,
    runId: string,
    resumeState: RunState | undefined,
) => ({
    workflow: config.workflow,
    issueConcurrency: config.issueConcurrency,
    agentConcurrency: config.agentConcurrency,
    repo: config.repo,
    branch: config.branch,
    maxIssues: config.maxIssues,
    issueFilters: {
        labels: config.issueLabels,
        sort: config.issueSort,
        order: config.issueOrder,
    },
    model: config.model,
    modelVariant: config.modelVariant,
    agent: config.agent,
    workspace: config.workspace,
    cleanup: config.cleanup,
    startClean: config.startClean,
    signal: input.signal,
    runId,
    resumeState,
    resumePath: config.resume,
    dryRun: config.dryRun,
});

/** Execute one Ralphie command. */
export const runCommand = async (
    args: ReadonlyArray<string> = Bun.argv.slice(2),
    input: RunCommandInput = {},
): Promise<void> => {
    const parsed = parseCliArgs(args);
    if (parsed.help) {
        process.stdout.write(HELP_TEXT);
        return;
    }
    if (parsed.version) {
        process.stdout.write("0.1.0\n");
        return;
    }

    const config = resolveRalphieConfig(parsed.options);
    const resumeState = await loadResumeState(config);

    const terminal = input.terminal ?? terminalInfo();
    const runId = resumeState?.runId ?? crypto.randomUUID();
    const progress = makeCommandProgress(config, terminal, runId);
    const runtime = makeLiveRuntime({
        pi: makePiService(resolvePiConfig(config)),
        progress,
    });

    try {
        await workflow(
            workflowOptionsFor(config, input, runId, resumeState),
            runtime,
        );
    } catch (error) {
        const message =
            error instanceof Error
                ? redactSensitiveText(error.message)
                : String(error);
        process.exitCode = exitCodeForFailure(
            input.signal ?? new AbortController().signal,
        );
        throw new Error(message, { cause: error });
    }
};

export default runCommand;