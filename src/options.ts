import type { IssueOrder, IssueSort } from "./github/domain.ts";
export { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./issues/domain/decomposition-markdown.ts";
export {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    DEFAULT_WORKSPACE,
} from "./config/domain.ts";
import { DEFAULT_AGENT, type AgentModel } from "./agent/model.ts";
import type { TriageRole } from "./config/domain.ts";
import type { ConfigFile } from "./config/ports.ts";
import {
    resolveRepository,
    resolveSettings,
    validateConfiguration,
    type SetOverride,
} from "./config/resolve.ts";
import { RalphieError } from "./shared/error.ts";

export type RalphieCliOptions = {
    readonly repo?: string;
    readonly configPath?: string;
    readonly overrides?: ReadonlyArray<SetOverride>;
    /** Temporary until the harness switch-over replaces them with config keys. */
    readonly notifyNeedsAttention?: boolean;
    readonly needsAttentionLabel?: string;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly json?: boolean;
};

/** The resolved configuration for the issue workflow. */
export type ResolvedRalphieConfig = {
    readonly repo: string;
    readonly branch?: string;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly agent: string;
    readonly workspace: string;
    readonly json: boolean;
    readonly issueLabels: ReadonlyArray<string>;
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
    readonly labels: Readonly<Record<TriageRole, string>>;
    readonly implementationAttempts: number;
    readonly reviewRounds: number;
    readonly verificationFixes: number;
    readonly maxDecompositionDepth: number;
    readonly verificationCommands: ReadonlyArray<string>;
    readonly notificationsEnabled: boolean;
    readonly needsAttentionLabel?: string;
};

export type IssueRalphieConfig = ResolvedRalphieConfig;

const optionalProperty = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [Property in Key]: Value } | Record<never, never> =>
    value === undefined
        ? {}
        : ({ [key]: value } as { [Property in Key]: Value });

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
};

export type ResolveConfigInput = {
    readonly options: RalphieCliOptions;
    readonly file: ConfigFile;
    /** Login of the authenticated GitHub user; only called for a bare repo. */
    readonly login: () => Promise<string>;
};

/** Resolve the complete issue-workflow configuration. */
export const resolveRalphieConfig = async ({
    options,
    file,
    login,
}: ResolveConfigInput): Promise<ResolvedRalphieConfig> => {
    validateRalphieCliOptions(options);
    const overrides = options.overrides ?? [];
    const { document } = validateConfiguration(file, overrides);
    const repository = await resolveRepository(
        options.repo,
        document.defaultOwner,
        login,
    );
    const settings = resolveSettings(file, overrides, repository.slug);

    return {
        repo: repository.slug,
        ...optionalProperty("branch", settings.branch),
        ...optionalProperty("model", options.model),
        ...optionalProperty("thinking", options.thinking),
        agent: DEFAULT_AGENT,
        workspace: settings.workspace,
        json: options.json ?? false,
        issueLabels: settings.intake.requireLabels,
        issueSort: settings.intake.sort,
        issueOrder: settings.intake.order,
        labels: settings.labels,
        implementationAttempts: settings.limits.implementationAttempts,
        reviewRounds: settings.limits.reviewRounds,
        verificationFixes: settings.limits.verificationFixes,
        maxDecompositionDepth: settings.limits.maxDecompositionDepth,
        verificationCommands: settings.verify,
        notificationsEnabled: options.notifyNeedsAttention ?? false,
        ...optionalProperty(
            "needsAttentionLabel",
            options.needsAttentionLabel?.trim(),
        ),
    };
};