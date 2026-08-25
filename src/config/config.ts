import { Context, Effect, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { IssueOrder, IssueSort } from "../github/issues.ts";
import { parseRepositoryPattern } from "../github/repository-patterns.ts";
import { parseRepositorySlug } from "../github/repository.ts";
import {
  DEFAULT_OPENCODE_AGENT,
  openCodeModelSchema,
  openCodeModelVariantSchema,
  type OpenCodeModel,
} from "../opencode/model.ts";
import { RalphieError } from "../shared/error.ts";
import { redactSensitiveText } from "../shared/redaction.ts";
import { assertSafeProjectName } from "../project/project.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";
export const IMPLICIT_PROJECT_NAME = "default";

export enum WorkflowMode {
  Lgtm = "lgtm",
  Pr = "pr",
}
export const DEFAULT_WORKFLOW_MODE = WorkflowMode.Lgtm;

const nonEmptyString = z.string().trim().min(1);
function optionalConfigValue<Schema extends z.ZodType>(schema: Schema) {
  return schema
    .nullable()
    .transform((value) => value ?? undefined)
    .optional();
}

const gitConfigSchema = z
  .object({ branch: optionalConfigValue(nonEmptyString) })
  .strict();
const issueConfigSchema = z
  .object({
    limit: optionalConfigValue(z.number().int().positive()),
    sort: optionalConfigValue(
      z
        .object({
          by: optionalConfigValue(z.enum(IssueSort)),
          order: optionalConfigValue(z.enum(IssueOrder)),
        })
        .strict(),
    ),
    filter: optionalConfigValue(
      z.object({ labels: optionalConfigValue(z.array(nonEmptyString)) }).strict(),
    ),
  })
  .strict();
const agentConfigSchema = z
  .object({
    model: optionalConfigValue(
      z
        .object({
          id: optionalConfigValue(openCodeModelSchema),
          variant: optionalConfigValue(openCodeModelVariantSchema),
        })
        .strict(),
    ),
    mode: optionalConfigValue(nonEmptyString),
  })
  .strict();
const executionConfigShape = {
  workflow: optionalConfigValue(z.enum(WorkflowMode)),
  git: optionalConfigValue(gitConfigSchema),
  issues: optionalConfigValue(issueConfigSchema),
  agent: optionalConfigValue(agentConfigSchema),
  dryRun: optionalConfigValue(z.boolean()),
};

export const ralphieRepositoryConfigSchema = z
  .object({
    repo: nonEmptyString,
    ...executionConfigShape,
    resume: optionalConfigValue(nonEmptyString),
  })
  .strict();

export const ralphieProjectConfigSchema = z
  .object({
    name: nonEmptyString,
    repoPattern: optionalConfigValue(nonEmptyString),
    repositories: z.array(ralphieRepositoryConfigSchema).min(1).optional(),
    ...executionConfigShape,
  })
  .strict()
  .superRefine((project, context) => {
    try {
      assertSafeProjectName(project.name);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if ((project.repoPattern === undefined) === (project.repositories === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of repoPattern or repositories is required.",
      });
    }
  });

export const ralphieFileConfigSchema = z
  .object({
    ...executionConfigShape,
    workspace: optionalConfigValue(
      z
        .object({
          path: optionalConfigValue(nonEmptyString),
          cleanup: optionalConfigValue(
            z
              .object({
                before: optionalConfigValue(z.boolean()),
                after: optionalConfigValue(z.boolean()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    output: optionalConfigValue(
      z
        .object({
          verbose: optionalConfigValue(z.boolean()),
          json: optionalConfigValue(z.boolean()),
          quiet: optionalConfigValue(z.boolean()),
        })
        .strict(),
    ),
    projects: z.array(ralphieProjectConfigSchema).min(1).optional(),
  })
  .strict();

export type RalphieFileConfig = z.infer<typeof ralphieFileConfigSchema>;

export type RalphieConfigOverrides = {
  readonly repo?: string;
  readonly workflow?: WorkflowMode;
  readonly branch?: string;
  readonly maxIssues?: number;
  readonly issueLabels?: ReadonlyArray<string>;
  readonly issueSort?: IssueSort;
  readonly issueOrder?: IssueOrder;
  readonly model?: OpenCodeModel;
  readonly modelVariant?: string;
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

export enum RepositoryTargetKind {
  Explicit = "explicit",
  Pattern = "pattern",
}

export type ResolvedExecutionConfig = {
  readonly workflow: WorkflowMode;
  /** Undefined means select main, then master, from the repository remote. */
  readonly branch?: string;
  readonly maxIssues?: number;
  readonly issueLabels: ReadonlyArray<string>;
  readonly issueSort: IssueSort;
  readonly issueOrder: IssueOrder;
  readonly model?: OpenCodeModel;
  readonly modelVariant?: string;
  readonly agent: string;
  readonly dryRun: boolean;
};

export type ResolvedRepositoryTarget = ResolvedExecutionConfig &
  (
    | {
        readonly kind: RepositoryTargetKind.Explicit;
        readonly repo: string;
        readonly resume?: string;
      }
    | {
        readonly kind: RepositoryTargetKind.Pattern;
        readonly repoPattern: string;
      }
  );

export type ResolvedProjectConfig = {
  readonly name: string;
  readonly targets: ReadonlyArray<ResolvedRepositoryTarget>;
};

export type ResolvedRalphieConfig = {
  readonly projects: ReadonlyArray<ResolvedProjectConfig>;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
};

type ExecutionConfig = {
  readonly workflow?: WorkflowMode;
  readonly git?: { readonly branch?: string };
  readonly issues?: {
    readonly limit?: number;
    readonly sort?: { readonly by?: IssueSort; readonly order?: IssueOrder };
    readonly filter?: { readonly labels?: ReadonlyArray<string> };
  };
  readonly agent?: {
    readonly model?: { readonly id?: OpenCodeModel; readonly variant?: string };
    readonly mode?: string;
  };
  readonly dryRun?: boolean;
};

function lastDefined<Value>(
  values: ReadonlyArray<Value | undefined>,
): Value | undefined {
  return values.filter((value): value is Value => value !== undefined).at(-1);
}

const resolveExecution = (
  levels: ReadonlyArray<ExecutionConfig | undefined>,
  overrides: RalphieConfigOverrides,
): ResolvedExecutionConfig => {
  const workflow = lastDefined(levels.map((level) => level?.workflow));
  const branch = lastDefined(levels.map((level) => level?.git?.branch));
  const limit = lastDefined(levels.map((level) => level?.issues?.limit));
  const sortBy = lastDefined(levels.map((level) => level?.issues?.sort?.by));
  const sortOrder = lastDefined(levels.map((level) => level?.issues?.sort?.order));
  const labels = lastDefined(levels.map((level) => level?.issues?.filter?.labels));
  const model = lastDefined(levels.map((level) => level?.agent?.model?.id));
  const modelVariant = lastDefined(levels.map((level) => level?.agent?.model?.variant));
  const mode = lastDefined(levels.map((level) => level?.agent?.mode));
  const dryRun = lastDefined(levels.map((level) => level?.dryRun));
  const maxIssues = overrides.maxIssues ?? limit;
  const selectedModel = overrides.model ?? model;
  const selectedVariant = overrides.modelVariant ?? modelVariant;

  return {
    workflow: overrides.workflow ?? workflow ?? DEFAULT_WORKFLOW_MODE,
    ...((overrides.branch ?? branch) === undefined
      ? {}
      : { branch: overrides.branch ?? branch }),
    ...(maxIssues === undefined ? {} : { maxIssues }),
    issueLabels: [...(overrides.issueLabels ?? labels ?? [])],
    issueSort: overrides.issueSort ?? sortBy ?? IssueSort.Created,
    issueOrder: overrides.issueOrder ?? sortOrder ?? IssueOrder.Ascending,
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
    ...(selectedVariant === undefined ? {} : { modelVariant: selectedVariant }),
    agent: overrides.agent ?? mode ?? DEFAULT_OPENCODE_AGENT,
    dryRun: overrides.dryRun ?? dryRun ?? false,
  };
};

export const resolveRalphieConfig = (
  file: RalphieFileConfig,
  overrides: RalphieConfigOverrides,
): ResolvedRalphieConfig => {
  if (file.projects !== undefined && overrides.repo !== undefined) {
    throw new RalphieError({
      message: "A positional repository cannot be combined with config.projects.",
    });
  }
  const projects =
    file.projects ??
    (overrides.repo === undefined
      ? undefined
      : [{ name: IMPLICIT_PROJECT_NAME, repositories: [{ repo: overrides.repo }] }]);
  if (projects === undefined) {
    throw new RalphieError({
      message:
        "Missing repository: provide a positional repository or config.projects.",
    });
  }

  const projectNames = projects.map(({ name }) => name.toLowerCase());
  if (new Set(projectNames).size !== projectNames.length) {
    throw new RalphieError({ message: "Each project name must be unique." });
  }

  const resolvedProjects = projects.map((project): ResolvedProjectConfig => {
    const projectExecution = resolveExecution([file, project], overrides);
    if (project.repoPattern !== undefined) {
      parseRepositoryPattern(project.repoPattern);
      if (overrides.resume !== undefined) {
        throw new RalphieError({
          message: "--resume cannot be applied to a repository pattern.",
        });
      }
      return {
        name: project.name,
        targets: [
          {
            kind: RepositoryTargetKind.Pattern,
            repoPattern: project.repoPattern,
            ...projectExecution,
          },
        ],
      };
    }

    return {
      name: project.name,
      targets: (project.repositories ?? []).map((repository) => ({
        kind: RepositoryTargetKind.Explicit,
        repo: parseRepositorySlug(repository.repo).slug,
        ...resolveExecution([file, project, repository], overrides),
        ...((overrides.resume ?? repository.resume) === undefined
          ? {}
          : { resume: overrides.resume ?? repository.resume }),
      })),
    };
  });

  const targets = resolvedProjects.flatMap(({ targets }) => targets);
  if (overrides.resume !== undefined && targets.length !== 1) {
    throw new RalphieError({
      message: "--resume can only be used when exactly one repository is configured.",
    });
  }
  const explicit = targets
    .filter((target) => target.kind === RepositoryTargetKind.Explicit)
    .map((target) => target.repo.toLowerCase());
  if (new Set(explicit).size !== explicit.length) {
    throw new RalphieError({
      message: "Each explicitly configured repository must be unique across projects.",
    });
  }

  const json = overrides.json ?? file.output?.json ?? false;
  const quiet = overrides.quiet ?? file.output?.quiet ?? false;
  if (json && quiet) {
    throw new RalphieError({
      message: "JSON and quiet output modes cannot be enabled together.",
    });
  }
  return {
    projects: resolvedProjects,
    workspace: overrides.workspace ?? file.workspace?.path ?? DEFAULT_WORKSPACE,
    cleanup: overrides.cleanup ?? file.workspace?.cleanup?.after ?? false,
    startClean: overrides.startClean ?? file.workspace?.cleanup?.before ?? false,
    verbose: overrides.verbose ?? file.output?.verbose ?? false,
    json,
    quiet,
  };
};

export type RalphieConfigFileService = {
  readonly load: (path: string) => Effect.Effect<RalphieFileConfig, RalphieError>;
};

export const RalphieConfigFile = Context.GenericTag<RalphieConfigFileService>(
  "ralphie/RalphieConfigFile",
);

const configPath = (path: PropertyKey[]): string => {
  if (path.length === 0) return "config";
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : result.length === 0
          ? String(segment)
          : `${result}.${String(segment)}`,
    "",
  );
};

const validationMessage = (path: string, error: z.ZodError): string =>
  `Config file ${path} has invalid settings:\n${error.issues
    .map((issue) => `- ${configPath(issue.path)}: ${issue.message}`)
    .join("\n")}`;

const readErrorMessage = (path: string, cause: unknown): string => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `Config file not found: ${path}.`;
  if (code === "EACCES") return `Cannot read config file ${path}: permission denied.`;
  const detail = cause instanceof Error ? ` ${cause.message}` : "";
  return redactSensitiveText(`Failed to read config file ${path}.${detail}`);
};

export const RalphieConfigFileLive = Layer.succeed(RalphieConfigFile, {
  load: (path) =>
    Effect.gen(function* () {
      const content = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) =>
          new RalphieError({ message: readErrorMessage(path, cause), cause }),
      });
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content),
        catch: (cause) =>
          new RalphieError({
            message: redactSensitiveText(
              `Config file ${path} contains malformed JSON${
                cause instanceof Error ? `: ${cause.message}` : "."
              }`,
            ),
            cause,
          }),
      });
      return yield* Effect.try({
        try: () => ralphieFileConfigSchema.parse(parsed),
        catch: (cause) =>
          new RalphieError({
            message:
              cause instanceof z.ZodError
                ? validationMessage(path, cause)
                : `Config file ${path} could not be validated.`,
            cause,
          }),
      });
    }),
});
