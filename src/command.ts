import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
    type ConfigSources,
    type ResolvedRalphieConfig,
    type RalphieCliOptions,
    resolveRalphieConfig,
} from "./options.ts";
import { fileConfigDocumentWriter } from "./config/adapters/file-writer.ts";
import { type InitDependencies, initializeConfig } from "./config/init.ts";
import { defaultConfigPath } from "./config/load.ts";
import type { ConfigDocumentWriter } from "./config/ports.ts";
import { intakeOrdering } from "./config/settings.ts";
import { yamlConfigDocumentReader } from "./config/adapters/yaml-file.ts";
import { makeGitHubViewerService } from "./github/adapters/viewer.ts";
import { CommandRunnerLive } from "./process/adapters/command-runner.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "./progress/adapters/coordinator.ts";
import { type ProgressRenderMode } from "./progress/adapters/progress.ts";
import {
    makeHarnessAdapters,
    makeLiveRuntime,
    type IssueWorkflowRuntime,
    type SkillInjectionSettings,
} from "./runtime.ts";
import type { SessionEventListener } from "./harness/ports.ts";
import { makeHarnessProbe } from "./harness/adapters/probe.ts";
import {
    makeHarnessStartupChecker,
    type HarnessStartupChecker,
} from "./harness/app/startup-checks.ts";
import type { ProgressReporterService } from "./progress/ports.ts";
import { exitCodeForError, RalphieExitCode } from "./workflow/exit-code.ts";
import { issueWorkflow } from "./workflow/workflow.ts";
import type { IssueWorkflow, WorkflowOptions } from "./workflow/ports.ts";
import { BUILD_INFO } from "./build-info.ts";
import { makeRunEventLog } from "./run/adapters/event-log.ts";
import type { RunControl, RunEventLog, RunLayout } from "./run/ports.ts";
import { makeRunLayout } from "./run/adapters/layout.ts";
import { RalphieError } from "./shared/error.ts";

const cliOptions = {
    config: { type: "string" },
    set: { type: "string", multiple: true },
    output: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
} as const;

const REPOSITORY_KEY = 'repos."<owner/repo>"';

/** Former flags and the config key that replaces each one. */
const REMOVED_FLAGS: Readonly<Record<string, string>> = {
    branch: `${REPOSITORY_KEY}.branch`,
    b: `${REPOSITORY_KEY}.branch`,
    "verify-command": `${REPOSITORY_KEY}.verify`,
    "issue-label": "intake.requireLabels",
    "issue-sort": "intake.sort",
    "implementation-attempts": "limits.implementationAttempts",
    "max-decomposition-depth": "limits.maxDecompositionDepth",
    workspace: "workspace",
    "notify-needs-attention": "notifications.enabled",
    "needs-attention-label": "notifications.label",
    model: "harnesses.<harness>.model or roles.<role>.model",
    thinking: "harnesses.<harness>.effort or roles.<role>.effort",
};

type ParsedCli = {
    readonly init: boolean;
    readonly help: boolean;
    readonly version: boolean;
    readonly options: RalphieCliOptions;
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

const asBoolean = (values: Record<string, unknown>, name: string): boolean =>
    values[name] === true;

const asStrings = (
    values: Record<string, unknown>,
    name: string,
): ReadonlyArray<string> => {
    const value = values[name];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) =>
        z.string().parse(item),
    );
};

const outputModeSchema = z.enum(["default", "json"]);

/** Fail on any former flag, naming the config key that replaces it. */
const rejectRemovedFlags = (args: ReadonlyArray<string>): void => {
    const { tokens } = parseArgs({
        args: [...args],
        options: cliOptions,
        allowPositionals: true,
        strict: false,
        tokens: true,
    });
    for (const token of tokens) {
        if (token.kind !== "option") continue;
        const key = REMOVED_FLAGS[token.name];
        if (key !== undefined) {
            throw new RalphieError({
                message: `Option ${token.rawName} was removed. Set ${key} in the config file instead, or override it for one run with --set.`,
            });
        }
    }
};

const parseCliOptions = (
    values: Record<string, unknown>,
    repo: string | undefined,
): RalphieCliOptions => {
    const rawOutput = asNonEmptyString(values, "output");
    const outputValue =
        rawOutput === undefined ? undefined : outputModeSchema.parse(rawOutput);
    const configPath = asNonEmptyString(values, "config");

    return {
        ...(repo === undefined ? {} : { repo }),
        ...(configPath === undefined ? {} : { configPath }),
        overrides: asStrings(values, "set"),
        json: outputValue === "json",
    };
};

/** Parse the public `ralphie [owner/]repository [options]` command line. */
export const parseCliArgs = (args: ReadonlyArray<string>): ParsedCli => {
    rejectRemovedFlags(args);
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
    const init = parsed.positionals[0] === "init";
    return {
        init,
        help: asBoolean(values, "help"),
        version: asBoolean(values, "version"),
        options: parseCliOptions(
            values,
            init ? undefined : parsed.positionals[0],
        ),
    };
};

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
    if (terminal.isInteractive && !terminal.isCI && process.stderr.isTTY) {
        return "interactive";
    }
    return "plain";
};

export const HELP_TEXT = `Usage: ralphie [owner/]repository [options]
       ralphie init [--config <path>]

Turn open GitHub issues into reviewed commits through coding-agent harnesses.

The repository is owner/name or a GitHub HTTPS or SSH clone URL. A bare name
takes its owner from defaultOwner in the config file, else the gh login.
Every other setting comes from the config file. \`ralphie init\` finds the
harnesses on PATH and writes a starter config file, never overwriting one.

Options:
      --config <path>          Config file (default $XDG_CONFIG_HOME/ralphie/config.yaml,
                               else ~/.config/ralphie/config.yaml)
      --set <path=value>       Override a config key for this run (repeatable), for example
                               --set limits.reviewRounds=3 or --set 'repos."owner/repo".branch=dev'
      --output <mode>          Output: default (TUI on a terminal, plain when piped) or json
  -h, --help                   Show this help
  -v, --version                Show version (use --output json for build metadata)

Environment:
  XDG_CONFIG_HOME              Base directory for the default config file (default ~/.config)
  GH_TOKEN                     GitHub.com token for gh (preferred)
  GITHUB_TOKEN                 Fallback GitHub.com token alias for gh
                               Interactive \`gh auth login\` or a mounted GitHub CLI profile is not required

Sessions run through the harness CLIs named in the config file (claude by
default), which bring their own login or credentials.
`;

export type CommandRuntime = IssueWorkflowRuntime & {
    readonly dispose?: () => Promise<void>;
};

export type CommandFactories = {
    readonly makeCoordinator?: (
        options: ProgressCoordinatorOptions,
    ) => ProgressCoordinator;
    readonly makeRuntime?: (input: {
        readonly progress: ProgressCoordinator["progress"];
        readonly runEventLog: RunEventLog;
        readonly layout: RunLayout;
        readonly sessionListener: SessionEventListener;
        readonly skills: SkillInjectionSettings;
    }) => CommandRuntime;
    readonly runWorkflow?: IssueWorkflow["run"];
    /** Checks the assigned harnesses before any work starts. */
    readonly checkHarnesses?: HarnessStartupChecker;
    /** Detects installed harnesses for `ralphie init`. */
    readonly harnessProbe?: InitDependencies["probe"];
    /** Creates the config file for `ralphie init`. */
    readonly configWriter?: ConfigDocumentWriter;
    /** The authenticated gh login, read only to complete a bare repository name. */
    readonly githubLogin?: () => Promise<string>;
};

export type CommandOutput = {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
};

export type RunCommandInput = {
    readonly signal?: AbortSignal;
    readonly terminal?: CliTerminalInfo;
    /** Explicit test seams; production callers should use the defaults. */
    readonly factories?: CommandFactories;
    readonly output?: CommandOutput;
    /** Environment consulted for the default config location. */
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
};

const commandOutput = (output?: CommandOutput): CommandOutput =>
    output ?? {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
    };

const resolveCommandFactories = (
    factories: CommandFactories = {},
): Required<CommandFactories> => ({
    makeCoordinator: factories.makeCoordinator ?? makeProgressCoordinator,
    makeRuntime: factories.makeRuntime ?? makeLiveRuntime,
    runWorkflow: factories.runWorkflow ?? issueWorkflow.run,
    checkHarnesses:
        factories.checkHarnesses ??
        makeHarnessStartupChecker(
            makeHarnessProbe({
                runner: CommandRunnerLive,
                adapters: makeHarnessAdapters(CommandRunnerLive),
            }),
        ),
    harnessProbe:
        factories.harnessProbe ??
        makeHarnessProbe({
            runner: CommandRunnerLive,
            adapters: makeHarnessAdapters(CommandRunnerLive),
        }),
    configWriter: factories.configWriter ?? fileConfigDocumentWriter,
    githubLogin:
        factories.githubLogin ??
        makeGitHubViewerService(CommandRunnerLive).login,
});

const configSourcesFor = (
    input: RunCommandInput,
    githubLogin: () => Promise<string>,
): ConfigSources => ({
    reader: yamlConfigDocumentReader,
    environment: input.environment ?? process.env,
    homeDirectory: input.homeDirectory ?? homedir(),
    githubLogin,
});

const eventLogFor = (layout: RunLayout): RunEventLog =>
    makeRunEventLog({ path: layout.eventLogPath });

const makeCommandCoordinator = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
    runId: string,
    factory: NonNullable<CommandFactories["makeCoordinator"]>,
    output: CommandOutput,
    eventLog: RunEventLog,
): ProgressCoordinator =>
    factory({
        mode: resolveProgressMode(config, terminal),
        width: () => process.stderr.columns ?? terminal.width,
        write: config.json ? output.stdout : output.stderr,
        colors: terminal.isInteractive && !terminal.isCI,
        runId,
        eventLog,
    });

/**
 * The bundled skills sit beside the entry point's parent directory, both from
 * source (`src/`) and from the bundle (`dist/`).
 */
const BUNDLED_SKILLS_DIRECTORY = resolve(
    import.meta.dir,
    "..",
    "vendor",
    "mattpocock-skills",
);

const skillSettingsFor = (
    config: ResolvedRalphieConfig,
): SkillInjectionSettings => ({
    directory:
        config.settings.skills.dir === undefined
            ? BUNDLED_SKILLS_DIRECTORY
            : resolve(config.settings.skills.dir),
    labels: config.settings.labels,
});

/** The mapped agent-ready label plus every configured `intake.requireLabels`. */
const agentReadyLabels = (
    settings: ResolvedRalphieConfig["settings"],
): ReadonlyArray<string> => [
    ...new Set([
        settings.labels["ready-for-agent"],
        ...settings.intake.requireLabels,
    ]),
];

const workflowOptionsFor = (
    config: ResolvedRalphieConfig,
    input: RunCommandInput,
    runId: string,
    control?: RunControl,
): WorkflowOptions => {
    const { settings } = config;
    return {
        repo: config.repo,
        ...(settings.branch === undefined ? {} : { branch: settings.branch }),
        maxDecompositionDepth: settings.limits.maxDecompositionDepth,
        issueFilters: {
            labels: agentReadyLabels(settings),
            ...intakeOrdering(settings.intake.sort),
        },
        verificationCommands: settings.verify,
        implementationAttempts: settings.limits.implementationAttempts,
        reviewRounds: settings.limits.reviewRounds,
        verificationFixes: settings.limits.verificationFixes,
        roles: config.roles,
        sessionLimits: {
            editTimeoutMs: settings.limits.sessionTimeoutMinutes.edit * 60_000,
            readOnlyTimeoutMs:
                settings.limits.sessionTimeoutMinutes.readOnly * 60_000,
            ...(settings.limits.maxBudgetUsd === undefined
                ? {}
                : { maxBudgetUsd: settings.limits.maxBudgetUsd }),
        },
        workspace: settings.workspace,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(control === undefined ? {} : { control }),
        runId,
        notificationsEnabled: settings.notifications.enabled,
        ...(settings.notifications.label === undefined
            ? {}
            : { needsAttentionLabel: settings.notifications.label }),
    };
};

/** Fail fast, naming the fix, when the configured harnesses cannot run. */
const runStartupChecks = async (
    config: ResolvedRalphieConfig,
    check: HarnessStartupChecker,
    progress: ProgressReporterService,
): Promise<void> => {
    const report = await check({
        roles: config.roles,
        maxBudgetUsd: config.settings.limits.maxBudgetUsd,
    });
    for (const warning of report.warnings) {
        await progress.emit({
            stage: "agent-runtime",
            status: "info",
            message: `Warning: ${warning}`,
        });
    }
    if (report.errors.length > 0) {
        throw new RalphieError({
            message: `Harness startup checks failed:\n${report.errors
                .map((error) => `  - ${error}`)
                .join("\n")}`,
        });
    }
};

const commandErrorFor = (error: unknown, signal: AbortSignal): Error => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = exitCodeForError(error, signal);
    return new Error(message, { cause: error });
};

const disposeCommandResources = async (
    runtime: CommandRuntime | undefined,
    coordinator: ProgressCoordinator | undefined,
    commandError: Error | undefined,
): Promise<void> => {
    let cleanupError: unknown;
    try {
        await runtime?.dispose?.();
    } catch (error) {
        cleanupError = error;
    }
    try {
        await coordinator?.dispose();
    } catch (error) {
        cleanupError ??= error;
    }
    if (commandError === undefined && cleanupError !== undefined) {
        throw cleanupError;
    }
};

export const runCommand = async (
    args: ReadonlyArray<string> = Bun.argv.slice(2),
    input: RunCommandInput = {},
): Promise<void> => {
    const output = commandOutput(input.output);
    const parsed = parseCliArgs(args);
    if (parsed.help) {
        output.stdout(HELP_TEXT);
        return;
    }
    if (parsed.version) {
        output.stdout(
            parsed.options.json
                ? `${JSON.stringify(BUILD_INFO)}\n`
                : `${BUILD_INFO.version}\n`,
        );
        return;
    }

    const factories = resolveCommandFactories(input.factories);
    if (parsed.init) {
        const result = await initializeConfig(
            { probe: factories.harnessProbe, writer: factories.configWriter },
            parsed.options.configPath ??
                defaultConfigPath(
                    input.environment ?? process.env,
                    input.homeDirectory ?? homedir(),
                ),
        );
        output.stdout(
            `Wrote ${result.path}\nHarnesses found: ${result.detected.join(", ")}\nEdit it, then run: ralphie owner/repository\n`,
        );
        return;
    }
    const config = await resolveRalphieConfig(
        parsed.options,
        configSourcesFor(input, factories.githubLogin),
    );

    const terminal = input.terminal ?? terminalInfo();
    const runId = crypto.randomUUID();
    const layout = makeRunLayout(config.settings.workspace, runId);
    const runEventLog = eventLogFor(layout);
    let coordinator: ProgressCoordinator | undefined;
    let runtime: CommandRuntime | undefined;
    let commandError: Error | undefined;

    try {
        coordinator = makeCommandCoordinator(
            config,
            terminal,
            runId,
            factories.makeCoordinator,
            output,
            runEventLog,
        );
        await runStartupChecks(
            config,
            factories.checkHarnesses,
            coordinator.progress,
        );
        runtime = factories.makeRuntime({
            progress: coordinator.progress,
            runEventLog,
            layout,
            sessionListener: coordinator.sessionListener,
            skills: skillSettingsFor(config),
        });
        await factories.runWorkflow(
            workflowOptionsFor(config, input, runId, coordinator.control),
            runtime,
        );
        process.exitCode = RalphieExitCode.Success;
    } catch (error) {
        commandError = commandErrorFor(
            error,
            input.signal ?? new AbortController().signal,
        );
        throw commandError;
    } finally {
        await disposeCommandResources(runtime, coordinator, commandError);
    }
};