import { IssueOrder, IssueSort } from "./github/issues.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import {
  MODEL_API_KEY_ENV,
  MODEL_BASE_URL_ENV,
} from "./pi/config.ts";
import { DEFAULT_PI_AGENT, type PiModel } from "./agent/model.ts";
import { RalphieError } from "./shared/error.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

export enum WorkflowMode {
  Lgtm = "lgtm",
  Pr = "pr",
  ParallelPr = "parallel-pr",
}

export const DEFAULT_WORKFLOW_MODE = WorkflowMode.Lgtm;

export type RalphieCliOptions = {
  readonly repo?: string;
  readonly workflow?: WorkflowMode;
  readonly branch?: string;
  readonly issueConcurrency?: number;
  readonly agentConcurrency?: number;
  readonly maxIssues?: number;
  readonly issueLabels?: ReadonlyArray<string>;
  readonly issueSort?: IssueSort;
  readonly issueOrder?: IssueOrder;
  readonly model?: PiModel;
  readonly modelVariant?: string;
  readonly modelBaseUrl?: string;
  readonly modelApiKey?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly agentDir?: string;
  readonly agent?: string;
  readonly workspace?: string;
  readonly cleanup?: boolean;
  readonly startClean?: boolean;
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
  readonly issueConcurrency: number;
  readonly agentConcurrency?: number;
  readonly maxIssues?: number;
  readonly issueLabels: ReadonlyArray<string>;
  readonly issueSort: IssueSort;
  readonly issueOrder: IssueOrder;
  readonly model?: PiModel;
  readonly modelVariant?: string;
  readonly modelBaseUrl?: string;
  readonly modelApiKey?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly agentDir?: string;
  readonly agent: string;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
  readonly dryRun: boolean;
  readonly resume?: string;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
};

/** Resolve the complete run configuration from CLI arguments only. */
export const resolveRalphieConfig = (
  options: RalphieCliOptions,
): ResolvedRalphieConfig => {
  if (options.repo === undefined) {
    throw new RalphieError({
      message: "Missing repository: provide an owner/repository argument.",
    });
  }

  const json = options.json ?? false;
  const quiet = options.quiet ?? false;
  if (json && quiet) {
    throw new RalphieError({
      message: "JSON and quiet output modes cannot be enabled together.",
    });
  }

  return {
    repo: parseRepositorySlug(options.repo).slug,
    workflow: options.workflow ?? DEFAULT_WORKFLOW_MODE,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    issueConcurrency: options.issueConcurrency ?? 1,
    ...(options.agentConcurrency === undefined
      ? {}
      : { agentConcurrency: options.agentConcurrency }),
    ...(options.maxIssues === undefined ? {} : { maxIssues: options.maxIssues }),
    issueLabels: [...(options.issueLabels ?? [])],
    issueSort: options.issueSort ?? IssueSort.Created,
    issueOrder: options.issueOrder ?? IssueOrder.Ascending,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.modelVariant === undefined
      ? {}
      : { modelVariant: options.modelVariant }),
    agent: options.agent ?? DEFAULT_PI_AGENT,
    ...(options.modelBaseUrl === undefined
      ? {}
      : { modelBaseUrl: options.modelBaseUrl }),
    ...(options.modelApiKey === undefined
      ? {}
      : { modelApiKey: options.modelApiKey }),
    ...(options.modelProvider === undefined
      ? {}
      : { modelProvider: options.modelProvider }),
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    // Flags take precedence over the documented environment variables.
    ...(options.modelBaseUrl === undefined &&
    process.env[MODEL_BASE_URL_ENV] !== undefined
      ? { modelBaseUrl: process.env[MODEL_BASE_URL_ENV] }
      : {}),
    ...(options.modelApiKey === undefined &&
    process.env[MODEL_API_KEY_ENV] !== undefined
      ? { modelApiKey: process.env[MODEL_API_KEY_ENV] }
      : {}),
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    cleanup: options.cleanup ?? false,
    startClean: options.startClean ?? false,
    dryRun: options.dryRun ?? false,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    verbose: options.verbose ?? false,
    json,
    quiet,
  };
};
