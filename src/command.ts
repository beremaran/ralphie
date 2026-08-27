import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
    type CleanWhen,
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    WorkflowMode,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { piModelSchema, piModelVariantSchema } from "./agent/model.ts";
import {
    makeProgressReporter,
    type ProgressRenderMode,
} from "./progress/progress.ts";
import { makePiTranscriptRenderer } from "./progress/transcript.ts";
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
    "max-issues": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    "pi-dir": { type: "string" },
    workspace: { type: "string" },
    "dry-run": { type: "boolean" },
    clean: { type: "string" },
    resume: { type: "string" },
    output: { type: "string" },
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

const cleanWhenSchema = z.enum(["start", "end", "both"]);
const outputModeSchema = z.enum(["default", "verbose", "quiet", "json"]);

const parseIssueSort = (
    value: string,
): {
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
} => {
    const parts = value.split(":");
    if (parts.length > 2) {
        throw new Error(
            "Option --issue-sort requires <created|updated|comments> with an optional :asc or :desc.",
        );
    }
    const sort = z.enum(IssueSort).parse(parts[0] ?? "");
    const order =
        parts[1] === undefined
            ? IssueOrder.Ascending
            : z.enum(IssueOrder).parse(parts[1]);
    return { issueSort: sort, issueOrder: order };
};

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
    const issueSortValue = asNonEmptyString(values, "issue-sort");
    const thinkingValue = asNonEmptyString(values, "thinking");
    const cleanValue = asNonEmptyString(values, "clean");
    const rawOutput = asNonEmptyString(values, "output");
    const outputValue =
        rawOutput === undefined ? undefined : outputModeSchema.parse(rawOutput);

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
            maxIssues: asNumber(values, "max-issues"),
            issueLabels,
            ...(issueSortValue === undefined
                ? {}
                : parseIssueSort(issueSortValue)),
            model:
                modelValue === undefined
                    ? undefined
                    : piModelSchema.parse(modelValue),
            thinking:
                thinkingValue === undefined
                    ? undefined
                    : piModelVariantSchema.parse(thinkingValue),
            piDir: asNonEmptyString(values, "pi-dir"),
            workspace: asNonEmptyString(values, "workspace"),
            clean:
                cleanValue === undefined
                    ? undefined
                    : cleanWhenSchema.parse(cleanValue),
            dryRun: asBoolean(values, "dry-run"),
            resume: asNonEmptyString(values, "resume"),
            verbose: outputValue === "verbose",
            json: outputValue === "json",
            quiet: outputValue === "quiet",
        },
    };
};

const resolvePiConfig = (config: ResolvedRalphieConfig): PiProviderConfig => ({
    workspace: config.workspace,
    modelBaseUrl: config.modelBaseUrl,
    modelApiKey: config.modelApiKey,
    model: config.model,
    agentDir: config.piDir,
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
    if (config.json) return "json";
    if (config.quiet) return "quiet";
    if (terminal.isInteractive && !terminal.isCI && process.stderr.isTTY) {
        return "interactive";
    }
    return "plain";
};

export const HELP_TEXT = `Usage: ralphie <owner/repository> [options]

Run a GitHub issue queue through Pi.

Options:
  -b, --branch <name>          Branch to operate on
      --workflow <mode>        lgtm or pr
      --max-issues <n>         Maximum issues to process
      --issue-label <label>    Include only issues with this label (repeatable)
      --issue-sort <sort>      created, updated, or comments, optionally :asc or :desc
      --model <provider/model> Pi model selection
      --thinking <level>       Pi thinking level: off, minimal, low, medium, high, xhigh, or max
      --pi-dir <path>          Existing Pi agent directory
      --workspace <path>       Workspace directory
      --dry-run                Assess without mutations
      --resume <path>          Resume saved run state
      --clean <when>           Remove the workspace at start, end, or both
      --output <mode>          Output: live transcript/progress, verbose, quiet, or json
  -h, --help                   Show this help
  -v, --version                Show version

Environment:
  RALPHIE_MODEL_BASE_URL       OpenAI-compatible model base URL
  RALPHIE_MODEL_API_KEY        Model API key
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

const makeCommandTranscript = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
    progress: ReturnType<typeof makeProgressReporter>,
) =>
    config.quiet
        ? undefined
        : makePiTranscriptRenderer({
              write:
                  progress.writeRaw ??
                  ((text) =>
                      (config.json ? process.stdout : process.stderr).write(
                          text,
                      )),
              colors: terminal.isInteractive && !terminal.isCI,
              json: config.json,
              verbose: config.verbose,
              width: () => process.stderr.columns ?? terminal.width,
          });

const workflowOptionsFor = (
    config: ResolvedRalphieConfig,
    input: RunCommandInput,
    runId: string,
    resumeState: RunState | undefined,
) => ({
    workflow: config.workflow,
    repo: config.repo,
    branch: config.branch,
    maxIssues: config.maxIssues,
    issueFilters: {
        labels: config.issueLabels,
        sort: config.issueSort,
        order: config.issueOrder,
    },
    model: config.model,
    modelVariant: config.thinking,
    agent: config.agent,
    workspace: config.workspace,
    cleanup: config.cleanEnd,
    startClean: config.cleanStart,
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
    const transcript = makeCommandTranscript(config, terminal, progress);
    const runtime = makeLiveRuntime({
        pi: makePiService(resolvePiConfig(config), transcript),
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