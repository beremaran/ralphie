import { IssueOrder, IssueSort } from "./github/issues.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import { MODEL_API_KEY_ENV, MODEL_BASE_URL_ENV } from "./pi/config.ts";
import { DEFAULT_PI_AGENT, type PiModel } from "./agent/model.ts";
import { RalphieError } from "./shared/error.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

export enum WorkflowMode {
    Lgtm = "lgtm",
    Pr = "pr",
}

export const DEFAULT_WORKFLOW_MODE = WorkflowMode.Lgtm;

/** The top-level command mode, separate from the issue delivery workflow. */
export enum ExecutionMode {
    Issues = "issues",
    GetPipelinesGreen = "get-pipelines-green",
}

export const DEFAULT_EXECUTION_MODE = ExecutionMode.Issues;
export const DEFAULT_MAX_ATTEMPTS = 3;

export type CleanWhen = "start" | "end" | "both";

export type DurationUnit = "seconds" | "minutes" | "hours";

/** A positive, whole-unit duration supplied to a pipeline operation. */
export type Duration = {
    readonly value: number;
    readonly unit: DurationUnit;
};

export type PipelineTimeout = Duration;

const durationMultipliers: Record<DurationUnit, number> = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
};

/** Convert a typed duration to milliseconds for time-based services. */
export const durationToMilliseconds = (duration: Duration): number =>
    duration.value * durationMultipliers[duration.unit];

/** Parse the strict CLI grammar `<positive integer><s|m|h>`. */
export const parsePipelineTimeout = (value: string): PipelineTimeout => {
    const match = /^(\d+)([smh])$/.exec(value);
    if (match === null) {
        throw new Error(
            "Option --pipeline-timeout requires a positive integer followed by s, m, or h (for example 30s, 10m, or 2h).",
        );
    }

    const amount = Number(match[1]);
    const unit: DurationUnit =
        match[2] === "s" ? "seconds" : match[2] === "m" ? "minutes" : "hours";
    const milliseconds = amount * durationMultipliers[unit];
    if (
        amount <= 0 ||
        !Number.isSafeInteger(amount) ||
        !Number.isSafeInteger(milliseconds)
    ) {
        throw new Error(
            "Option --pipeline-timeout requires a positive integer duration within the supported range.",
        );
    }
    return { value: amount, unit };
};

export type RalphieCliOptions = {
    readonly repo?: string;
    readonly mode?: ExecutionMode;
    readonly workflow?: WorkflowMode;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly maxAttempts?: number;
    readonly pipelineTimeout?: PipelineTimeout;
    readonly model?: PiModel;
    readonly thinking?: string;
    readonly groundingThinking?: string;
    readonly complexityThinking?: string;
    readonly reviewThinking?: string;
    readonly commitThinking?: string;
    readonly piDir?: string;
    readonly workspace?: string;
    readonly clean?: CleanWhen;
    readonly dryRun?: boolean;
    readonly resume?: string;
    readonly verbose?: boolean;
    readonly json?: boolean;
    readonly quiet?: boolean;
};

type SharedRalphieConfig = {
    readonly repo: string;
    readonly branch?: string;
    readonly model?: PiModel;
    readonly thinking?: string;
    readonly groundingThinking?: string;
    readonly complexityThinking?: string;
    readonly reviewThinking?: string;
    readonly commitThinking?: string;
    readonly piDir?: string;
    readonly modelBaseUrl?: string;
    readonly modelApiKey?: string;
    readonly agent: string;
    readonly workspace: string;
    readonly cleanStart: boolean;
    readonly cleanEnd: boolean;
    readonly dryRun: boolean;
    readonly resume?: string;
    readonly verbose: boolean;
    readonly json: boolean;
    readonly quiet: boolean;
};

export type IssueRalphieConfig = SharedRalphieConfig & {
    readonly mode: ExecutionMode.Issues;
    readonly workflow: WorkflowMode;
    readonly maxIssues?: number;
    readonly issueLabels: ReadonlyArray<string>;
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
    readonly verificationCommands?: ReadonlyArray<string>;
};

export type GetPipelinesGreenRalphieConfig = SharedRalphieConfig & {
    readonly mode: ExecutionMode.GetPipelinesGreen;
    readonly maxAttempts: number;
    readonly pipelineTimeout?: PipelineTimeout;
};

export type ResolvedRalphieConfig =
    | IssueRalphieConfig
    | GetPipelinesGreenRalphieConfig;

const optionalProperty = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [Property in Key]: Value } | Record<never, never> =>
    value === undefined
        ? {}
        : ({ [key]: value } as { [Property in Key]: Value });

const withDefault = <Value>(value: Value | undefined, fallback: Value): Value =>
    value ?? fallback;

const issueOnlyOptions = [
    "--max-issues",
    "--issue-label",
    "--issue-sort",
    "--workflow",
] as const;

const pipelineOnlyOptions = ["--max-attempts", "--pipeline-timeout"] as const;

const incompatibleOptionError = (
    option: string,
    mode: ExecutionMode,
): RalphieError =>
    new RalphieError({
        message:
            mode === ExecutionMode.GetPipelinesGreen
                ? `Option ${option} is only available in issues mode and cannot be used with --mode ${mode}.`
                : `Option ${option} is only available in get-pipelines-green mode and cannot be used with --mode ${mode}.`,
    });

const validateIssueOptions = (
    options: RalphieCliOptions,
    mode: ExecutionMode,
): void => {
    if (options.maxIssues !== undefined)
        throw incompatibleOptionError(issueOnlyOptions[0], mode);
    if (options.issueLabels !== undefined)
        throw incompatibleOptionError(issueOnlyOptions[1], mode);
    if (options.issueSort !== undefined || options.issueOrder !== undefined)
        throw incompatibleOptionError(issueOnlyOptions[2], mode);
    if (options.workflow !== undefined)
        throw incompatibleOptionError(issueOnlyOptions[3], mode);
};

const validatePipelineOptions = (
    options: RalphieCliOptions,
    mode: ExecutionMode,
): void => {
    if (options.maxAttempts !== undefined)
        throw incompatibleOptionError(pipelineOnlyOptions[0], mode);
    if (options.pipelineTimeout !== undefined)
        throw incompatibleOptionError(pipelineOnlyOptions[1], mode);
};

const validateMaxAttempts = (options: RalphieCliOptions): void => {
    if (
        options.maxAttempts !== undefined &&
        (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)
    ) {
        throw new RalphieError({
            message: "Option --max-attempts requires a positive integer.",
        });
    }
};

/** Reject explicitly supplied flags that belong to the other top-level mode. */
export const validateRalphieCliOptions = (options: RalphieCliOptions): void => {
    const mode = options.mode ?? DEFAULT_EXECUTION_MODE;
    if (mode === ExecutionMode.GetPipelinesGreen) {
        validateIssueOptions(options, mode);
    } else {
        validatePipelineOptions(options, mode);
    }
    validateMaxAttempts(options);
};

const commonResolvedConfig = (
    options: RalphieCliOptions,
    json: boolean,
    quiet: boolean,
): SharedRalphieConfig => ({
    repo: parseRepositorySlug(options.repo!).slug,
    ...optionalProperty("branch", options.branch),
    ...optionalProperty("model", options.model),
    ...optionalProperty("thinking", options.thinking),
    ...optionalProperty("groundingThinking", options.groundingThinking),
    ...optionalProperty("complexityThinking", options.complexityThinking),
    ...optionalProperty("reviewThinking", options.reviewThinking),
    ...optionalProperty("commitThinking", options.commitThinking),
    ...optionalProperty("piDir", options.piDir),
    ...optionalProperty("modelBaseUrl", process.env[MODEL_BASE_URL_ENV]),
    ...optionalProperty("modelApiKey", process.env[MODEL_API_KEY_ENV]),
    agent: DEFAULT_PI_AGENT,
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    cleanStart: options.clean === "start" || options.clean === "both",
    cleanEnd: options.clean === "end" || options.clean === "both",
    dryRun: options.dryRun ?? false,
    ...optionalProperty("resume", options.resume),
    verbose: options.verbose ?? false,
    json,
    quiet,
});

const buildResolvedConfig = (
    options: RalphieCliOptions,
    json: boolean,
    quiet: boolean,
): ResolvedRalphieConfig => {
    const common = commonResolvedConfig(options, json, quiet);
    if (options.mode === ExecutionMode.GetPipelinesGreen) {
        return {
            ...common,
            mode: ExecutionMode.GetPipelinesGreen,
            maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            ...optionalProperty("pipelineTimeout", options.pipelineTimeout),
        };
    }

    return {
        ...common,
        mode: ExecutionMode.Issues,
        workflow: withDefault(options.workflow, DEFAULT_WORKFLOW_MODE),
        ...optionalProperty("maxIssues", options.maxIssues),
        issueLabels: [...(options.issueLabels ?? [])],
        issueSort: options.issueSort ?? IssueSort.Created,
        issueOrder: options.issueOrder ?? IssueOrder.Ascending,
        verificationCommands: [...(options.verificationCommands ?? [])],
    };
};

/** Resolve the complete run configuration from CLI arguments only. */
export const resolveRalphieConfig = (
    options: RalphieCliOptions,
): ResolvedRalphieConfig => {
    if (options.repo === undefined) {
        throw new RalphieError({
            message:
                "Missing repository: provide an owner/repository argument.",
        });
    }

    const json = options.json ?? false;
    const quiet = options.quiet ?? false;
    if (json && quiet) {
        throw new RalphieError({
            message: "JSON and quiet output modes cannot be enabled together.",
        });
    }

    validateRalphieCliOptions(options);

    return buildResolvedConfig(options, json, quiet);
};