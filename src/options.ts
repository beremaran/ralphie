import { IssueOrder, IssueSort } from "./core/domain/github.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./core/domain/decomposition-markdown.ts";
export { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./core/domain/decomposition-markdown.ts";
import { parseRepositorySlug } from "./core/domain/repository.ts";
import { DEFAULT_AGENT, type AgentModel } from "./core/domain/agent-model.ts";
import { RalphieError } from "./shared/error.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

export const DEFAULT_IMPLEMENTATION_ATTEMPTS = 3;

export type RalphieCliOptions = {
    readonly repo?: string;
    readonly notifyNeedsAttention?: boolean;
    readonly needsAttentionLabel?: string;
    readonly branch?: string;
    readonly maxDecompositionDepth?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly implementationAttempts?: number;
    readonly workspace?: string;
    readonly json?: boolean;
};

type SharedRalphieConfig = {
    readonly repo: string;
    readonly branch?: string;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly agent: string;
    readonly workspace: string;
    readonly json: boolean;
};

type SharedIssueSelection = {
    readonly issueLabels: ReadonlyArray<string>;
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
};

export type IssueRalphieConfig = SharedRalphieConfig &
    SharedIssueSelection & {
        readonly notificationsEnabled: boolean;
        readonly needsAttentionLabel?: string;
        readonly implementationAttempts: number;
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
): SharedRalphieConfig => ({
    repo: parseRepositorySlug(options.repo!).slug,
    ...optionalProperty("branch", options.branch),
    ...optionalProperty("model", options.model),
    ...optionalProperty("thinking", options.thinking),
    agent: DEFAULT_AGENT,
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    json,
});

const issueSelectionConfig = (
    options: RalphieCliOptions,
): SharedIssueSelection => ({
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

    validateRalphieCliOptions(options);

    return {
        ...commonResolvedConfig(options, json),
        ...issueSelectionConfig(options),
        notificationsEnabled: options.notifyNeedsAttention ?? false,
        ...optionalProperty(
            "needsAttentionLabel",
            options.needsAttentionLabel?.trim(),
        ),
        implementationAttempts:
            options.implementationAttempts ?? DEFAULT_IMPLEMENTATION_ATTEMPTS,
        verificationCommands: [...(options.verificationCommands ?? [])],
        maxDecompositionDepth:
            options.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH,
    };
};