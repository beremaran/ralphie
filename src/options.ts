import { IssueOrder, IssueSort } from "./github/issues.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import { MODEL_API_KEY_ENV, MODEL_BASE_URL_ENV } from "./pi/config.ts";
import { DEFAULT_PI_AGENT, type PiModel } from "./agent/model.ts";
import { RalphieError } from "./shared/error.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

export enum WorkflowMode {
    Lgtm = "lgtm",
    Pr = "pr",
    ParallelPr = "parallel-pr",
}

export const DEFAULT_WORKFLOW_MODE = WorkflowMode.Lgtm;

export type CleanWhen = "start" | "end" | "both";

export type RalphieCliOptions = {
    readonly repo?: string;
    readonly workflow?: WorkflowMode;
    readonly branch?: string;
    readonly parallel?: number;
    readonly piConcurrency?: number;
    readonly maxIssues?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
    readonly model?: PiModel;
    readonly thinking?: string;
    readonly piDir?: string;
    readonly workspace?: string;
    readonly clean?: CleanWhen;
    readonly dryRun?: boolean;
    readonly resume?: string;
    readonly verbose?: boolean;
    readonly json?: boolean;
    readonly quiet?: boolean;
};

export type ResolvedRalphieConfig = {
    readonly repo: string;
    readonly workflow: WorkflowMode;
    readonly branch?: string;
    readonly parallel: number;
    readonly piConcurrency?: number;
    readonly maxIssues?: number;
    readonly issueLabels: ReadonlyArray<string>;
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
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

const optionalProperty = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [Property in Key]: Value } | Record<never, never> =>
    value === undefined
        ? {}
        : ({ [key]: value } as { [Property in Key]: Value });

const withDefault = <Value>(value: Value | undefined, fallback: Value): Value =>
    value ?? fallback;

const buildResolvedConfig = (
    options: RalphieCliOptions,
    json: boolean,
    quiet: boolean,
): ResolvedRalphieConfig => ({
    repo: parseRepositorySlug(options.repo!).slug,
    workflow: withDefault(options.workflow, DEFAULT_WORKFLOW_MODE),
    ...optionalProperty("branch", options.branch),
    parallel: options.parallel ?? 1,
    ...optionalProperty("piConcurrency", options.piConcurrency),
    ...optionalProperty("maxIssues", options.maxIssues),
    issueLabels: [...(options.issueLabels ?? [])],
    issueSort: options.issueSort ?? IssueSort.Created,
    issueOrder: options.issueOrder ?? IssueOrder.Ascending,
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

    return buildResolvedConfig(options, json, quiet);
};