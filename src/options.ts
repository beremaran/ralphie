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

/** Policy used when an issue executor reports that an issue needs attention. */
export enum NeedsAttentionPolicy {
    Halt = "halt",
    Continue = "continue",
}

export const DEFAULT_NEEDS_ATTENTION_POLICY = NeedsAttentionPolicy.Halt;

/** The top-level command mode, separate from the issue delivery workflow. */
export enum ExecutionMode {
    Issues = "issues",
    MaintainIssues = "maintain-issues",
    GetPipelinesGreen = "get-pipelines-green",
}

/** Policy used when maintenance finds an issue that duplicates another issue. */
export enum DuplicateAction {
    Link = "link",
    Close = "close",
}

/** Alias for callers that refer to the duplicate action as a policy. */
export const DuplicatePolicy = DuplicateAction;
export type DuplicatePolicy = DuplicateAction;

export const DEFAULT_EXECUTION_MODE = ExecutionMode.Issues;
export const DEFAULT_DUPLICATE_ACTION = DuplicateAction.Link;
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
    readonly onNeedsAttention?: NeedsAttentionPolicy;
    readonly notifyNeedsAttention?: boolean;
    readonly needsAttentionLabel?: string;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly maxAttempts?: number;
    readonly pipelineTimeout?: PipelineTimeout;
    readonly duplicateAction?: DuplicateAction;
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

type SharedIssueSelection = {
    readonly maxIssues?: number;
    readonly issueLabels: ReadonlyArray<string>;
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
};

export type IssueRalphieConfig = SharedRalphieConfig &
    SharedIssueSelection & {
        readonly mode: ExecutionMode.Issues;
        readonly workflow: WorkflowMode;
        readonly onNeedsAttention: NeedsAttentionPolicy;
        readonly notificationsEnabled: boolean;
        readonly needsAttentionLabel?: string;
        readonly groundingThinking?: string;
        readonly complexityThinking?: string;
        readonly reviewThinking?: string;
        readonly commitThinking?: string;
        readonly verificationCommands?: ReadonlyArray<string>;
    };

export type MaintainIssuesRalphieConfig = SharedRalphieConfig &
    SharedIssueSelection & {
        readonly mode: ExecutionMode.MaintainIssues;
        readonly duplicateAction: DuplicateAction;
    };

export type GetPipelinesGreenRalphieConfig = SharedRalphieConfig & {
    readonly mode: ExecutionMode.GetPipelinesGreen;
    readonly maxAttempts: number;
    readonly pipelineTimeout?: PipelineTimeout;
};

export type ResolvedRalphieConfig =
    | IssueRalphieConfig
    | MaintainIssuesRalphieConfig
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

type ModeOptionRule = {
    readonly option: string;
    readonly field: keyof RalphieCliOptions;
    readonly modes: ReadonlyArray<ExecutionMode>;
    /** Keep the established issue-mode diagnostic for shared issue filters. */
    readonly diagnosticModes?: ReadonlyArray<ExecutionMode>;
};

const modeOptionRules: ReadonlyArray<ModeOptionRule> = [
    {
        option: "--max-issues",
        field: "maxIssues",
        modes: [ExecutionMode.Issues, ExecutionMode.MaintainIssues],
        diagnosticModes: [ExecutionMode.Issues],
    },
    {
        option: "--issue-label",
        field: "issueLabels",
        modes: [ExecutionMode.Issues, ExecutionMode.MaintainIssues],
        diagnosticModes: [ExecutionMode.Issues],
    },
    {
        option: "--issue-sort",
        field: "issueSort",
        modes: [ExecutionMode.Issues, ExecutionMode.MaintainIssues],
        diagnosticModes: [ExecutionMode.Issues],
    },
    {
        option: "--issue-sort",
        field: "issueOrder",
        modes: [ExecutionMode.Issues, ExecutionMode.MaintainIssues],
        diagnosticModes: [ExecutionMode.Issues],
    },
    {
        option: "--workflow",
        field: "workflow",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--on-needs-attention",
        field: "onNeedsAttention",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--notify-needs-attention",
        field: "notifyNeedsAttention",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--needs-attention-label",
        field: "needsAttentionLabel",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--verify-command",
        field: "verificationCommands",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--grounding-thinking",
        field: "groundingThinking",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--complexity-thinking",
        field: "complexityThinking",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--review-thinking",
        field: "reviewThinking",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--commit-thinking",
        field: "commitThinking",
        modes: [ExecutionMode.Issues],
    },
    {
        option: "--max-attempts",
        field: "maxAttempts",
        modes: [ExecutionMode.GetPipelinesGreen],
    },
    {
        option: "--pipeline-timeout",
        field: "pipelineTimeout",
        modes: [ExecutionMode.GetPipelinesGreen],
    },
    {
        option: "--duplicate-action",
        field: "duplicateAction",
        modes: [ExecutionMode.MaintainIssues],
    },
];

const modeLabel = (modes: ReadonlyArray<ExecutionMode>): string =>
    modes.join(" or ");

const incompatibleOptionError = (
    option: string,
    mode: ExecutionMode,
    modes: ReadonlyArray<ExecutionMode>,
): RalphieError =>
    new RalphieError({
        message: `Option ${option} is only available in ${modeLabel(modes)} mode and cannot be used with --mode ${mode}.`,
    });

const validateModeOptions = (
    options: RalphieCliOptions,
    mode: ExecutionMode,
): void => {
    for (const rule of modeOptionRules) {
        if (options[rule.field] !== undefined && !rule.modes.includes(mode)) {
            throw incompatibleOptionError(
                rule.option,
                mode,
                rule.diagnosticModes ?? rule.modes,
            );
        }
    }
};

/** Reject explicitly supplied mode-specific flags before value parsing. */
export const validateExplicitRalphieCliOptions = (
    values: Readonly<Record<string, unknown>>,
    mode: ExecutionMode,
): void => {
    for (const rule of modeOptionRules) {
        const optionName = rule.option.slice(2);
        if (values[optionName] !== undefined && !rule.modes.includes(mode)) {
            throw incompatibleOptionError(
                rule.option,
                mode,
                rule.diagnosticModes ?? rule.modes,
            );
        }
    }
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

/** Reject explicitly supplied flags that belong to another top-level mode. */
export const validateRalphieCliOptions = (options: RalphieCliOptions): void => {
    const mode = options.mode ?? DEFAULT_EXECUTION_MODE;
    validateModeOptions(options, mode);
    const needsAttentionLabel = options.needsAttentionLabel?.trim();
    if (
        options.needsAttentionLabel !== undefined &&
        needsAttentionLabel?.length === 0
    ) {
        throw new RalphieError({
            message:
                "Option --needs-attention-label requires a non-empty value.",
        });
    }
    if (
        needsAttentionLabel !== undefined &&
        options.notifyNeedsAttention !== true
    ) {
        throw new RalphieError({
            message:
                "Option --needs-attention-label requires --notify-needs-attention.",
        });
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

const issueSelectionConfig = (
    options: RalphieCliOptions,
): SharedIssueSelection => ({
    ...optionalProperty("maxIssues", options.maxIssues),
    issueLabels: [...(options.issueLabels ?? [])],
    issueSort: options.issueSort ?? IssueSort.Created,
    issueOrder: options.issueOrder ?? IssueOrder.Ascending,
});

const buildResolvedConfig = (
    options: RalphieCliOptions,
    json: boolean,
    quiet: boolean,
): ResolvedRalphieConfig => {
    const common = commonResolvedConfig(options, json, quiet);
    const mode = options.mode ?? DEFAULT_EXECUTION_MODE;
    if (mode === ExecutionMode.GetPipelinesGreen) {
        return {
            ...common,
            mode: ExecutionMode.GetPipelinesGreen,
            maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            ...optionalProperty("pipelineTimeout", options.pipelineTimeout),
        };
    }
    if (mode === ExecutionMode.MaintainIssues) {
        return {
            ...common,
            ...issueSelectionConfig(options),
            mode: ExecutionMode.MaintainIssues,
            duplicateAction:
                options.duplicateAction ?? DEFAULT_DUPLICATE_ACTION,
        };
    }

    return {
        ...common,
        ...issueSelectionConfig(options),
        mode: ExecutionMode.Issues,
        workflow: withDefault(options.workflow, DEFAULT_WORKFLOW_MODE),
        onNeedsAttention: withDefault(
            options.onNeedsAttention,
            DEFAULT_NEEDS_ATTENTION_POLICY,
        ),
        notificationsEnabled: options.notifyNeedsAttention ?? false,
        ...optionalProperty(
            "needsAttentionLabel",
            options.needsAttentionLabel?.trim(),
        ),
        ...optionalProperty("groundingThinking", options.groundingThinking),
        ...optionalProperty("complexityThinking", options.complexityThinking),
        ...optionalProperty("reviewThinking", options.reviewThinking),
        ...optionalProperty("commitThinking", options.commitThinking),
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