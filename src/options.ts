import { IssueOrder, IssueSort } from "./github/issues.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./github/decomposition-markdown.ts";
export { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./github/decomposition-markdown.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import { DEFAULT_AGENT, type AgentModel } from "./agent/model.ts";
import { RalphieError } from "./shared/error.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

/** Policy used when an issue executor reports that an issue needs attention. */
export enum NeedsAttentionPolicy {
    Halt = "halt",
    Continue = "continue",
}

export const DEFAULT_NEEDS_ATTENTION_POLICY = NeedsAttentionPolicy.Halt;

/** Policy used when an issue ends in an ordinary failure. */
export enum IssueFailurePolicy {
    Halt = "halt",
    Continue = "continue",
}

export const DEFAULT_ISSUE_FAILURE_POLICY = IssueFailurePolicy.Halt;
export const DEFAULT_IMPLEMENTATION_ATTEMPTS = 3;

export type CleanWhen = "start" | "end" | "both";

export type RalphieCliOptions = {
    readonly repo?: string;
    readonly onNeedsAttention?: NeedsAttentionPolicy;
    readonly onIssueFailure?: IssueFailurePolicy;
    readonly notifyNeedsAttention?: boolean;
    readonly needsAttentionLabel?: string;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly maxDecompositionDepth?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly implementationAttempts?: number;
    readonly implementationFallbackModel?: AgentModel;
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
    readonly model?: AgentModel;
    readonly thinking?: string;
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
        readonly onNeedsAttention: NeedsAttentionPolicy;
        readonly onIssueFailure: IssueFailurePolicy;
        readonly notificationsEnabled: boolean;
        readonly needsAttentionLabel?: string;
        readonly implementationAttempts: number;
        readonly implementationFallbackModel?: AgentModel;
        readonly verificationCommands?: ReadonlyArray<string>;
        readonly maxDecompositionDepth: number;
    };

/** The resolved configuration for the issue workflow. */
export type ResolvedRalphieConfig = IssueRalphieConfig;

const optionalProperty = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [Property in Key]: Value } | Record<never, never> =>
    value === undefined
        ? {}
        : ({ [key]: value } as { [Property in Key]: Value });

const withDefault = <Value>(value: Value | undefined, fallback: Value): Value =>
    value ?? fallback;

const validatePositiveIntegers = (options: RalphieCliOptions): void => {
    if (
        options.implementationAttempts !== undefined &&
        (!Number.isSafeInteger(options.implementationAttempts) ||
            options.implementationAttempts <= 0)
    ) {
        throw new RalphieError({
            message:
                "Option --implementation-attempts requires a positive integer.",
        });
    }
    if (
        options.maxDecompositionDepth !== undefined &&
        (!Number.isSafeInteger(options.maxDecompositionDepth) ||
            options.maxDecompositionDepth <= 0)
    ) {
        throw new RalphieError({
            message:
                "Option --max-decomposition-depth requires a positive integer.",
        });
    }
};

export const validateRalphieCliOptions = (options: RalphieCliOptions): void => {
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
    validatePositiveIntegers(options);
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
    agent: DEFAULT_AGENT,
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

/** Resolve the complete issue-workflow configuration from CLI arguments only. */
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

    return {
        ...commonResolvedConfig(options, json, quiet),
        ...issueSelectionConfig(options),
        onNeedsAttention: withDefault(
            options.onNeedsAttention,
            DEFAULT_NEEDS_ATTENTION_POLICY,
        ),
        onIssueFailure: withDefault(
            options.onIssueFailure,
            DEFAULT_ISSUE_FAILURE_POLICY,
        ),
        notificationsEnabled: options.notifyNeedsAttention ?? false,
        ...optionalProperty(
            "needsAttentionLabel",
            options.needsAttentionLabel?.trim(),
        ),
        implementationAttempts:
            options.implementationAttempts ?? DEFAULT_IMPLEMENTATION_ATTEMPTS,
        ...optionalProperty(
            "implementationFallbackModel",
            options.implementationFallbackModel,
        ),
        verificationCommands: [...(options.verificationCommands ?? [])],
        maxDecompositionDepth:
            options.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH,
    };
};