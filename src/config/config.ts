import { Context, Effect, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { IssueOrder, IssueSort } from "../github/issues.ts";
import { parseRepositorySlug } from "../github/repository.ts";
import {
  DEFAULT_OPENCODE_AGENT,
  openCodeModelSchema,
  openCodeModelVariantSchema,
  type OpenCodeModel,
} from "../opencode/model.ts";
import { RalphieError } from "../shared/error.ts";

export const DEFAULT_BRANCH = "main";
export const DEFAULT_WORKSPACE = "~/.ralphie";

const nonEmptyString = z.string().trim().min(1);

const repositoryOptionShape = {
  branch: nonEmptyString.optional(),
  maxIssues: z.number().int().positive().optional(),
  issueLabels: z.array(nonEmptyString).optional(),
  issueSort: z.enum(IssueSort).optional(),
  issueOrder: z.enum(IssueOrder).optional(),
  model: openCodeModelSchema.optional(),
  modelVariant: openCodeModelVariantSchema.optional(),
  agent: nonEmptyString.optional(),
  dryRun: z.boolean().optional(),
  resume: nonEmptyString.optional(),
};

export const ralphieRepositoryConfigSchema = z
  .object({
    repo: nonEmptyString,
    ...repositoryOptionShape,
  })
  .strict();

export const ralphieFileConfigSchema = z
  .object({
    repo: nonEmptyString.optional(),
    repositories: z.array(ralphieRepositoryConfigSchema).min(1).optional(),
    ...repositoryOptionShape,
    workspace: nonEmptyString.optional(),
    cleanup: z.boolean().optional(),
    startClean: z.boolean().optional(),
    verbose: z.boolean().optional(),
    json: z.boolean().optional(),
    quiet: z.boolean().optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.repo !== undefined && config.repositories !== undefined) {
      context.addIssue({
        code: "custom",
        message: "repo and repositories cannot both be configured.",
      });
    }
  });

export type RalphieFileConfig = z.infer<typeof ralphieFileConfigSchema>;

export type RalphieConfigOverrides = Omit<RalphieFileConfig, "repositories">;

export type ResolvedRalphieConfig = {
  readonly repo: string;
  readonly branch: string;
  readonly maxIssues?: number;
  readonly issueLabels: ReadonlyArray<string>;
  readonly issueSort: IssueSort;
  readonly issueOrder: IssueOrder;
  readonly model?: OpenCodeModel;
  readonly modelVariant?: string;
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

const defined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;

export const resolveRalphieConfig = (
  file: RalphieFileConfig,
  overrides: RalphieConfigOverrides,
): ResolvedRalphieConfig => {
  const resolved = resolveRalphieConfigs(file, overrides);
  if (resolved.length !== 1) {
    throw new RalphieError({
      message: "Expected exactly one configured repository.",
    });
  }
  return resolved[0]!;
};

const resolveSingleRepository = (
  file: RalphieConfigOverrides,
  overrides: RalphieConfigOverrides,
): ResolvedRalphieConfig => {
  const merged = { ...file, ...defined(overrides) };
  if (merged.repo === undefined) {
    throw new RalphieError({
      message: "Missing repository: provide a positional repository or config.repo.",
    });
  }
  if (merged.json === true && merged.quiet === true) {
    throw new RalphieError({
      message: "JSON and quiet output modes cannot be enabled together.",
    });
  }

  return {
    repo: merged.repo,
    branch: merged.branch ?? DEFAULT_BRANCH,
    ...(merged.maxIssues === undefined ? {} : { maxIssues: merged.maxIssues }),
    issueLabels: [...(merged.issueLabels ?? [])],
    issueSort: merged.issueSort ?? IssueSort.Created,
    issueOrder: merged.issueOrder ?? IssueOrder.Ascending,
    ...(merged.model === undefined ? {} : { model: merged.model }),
    ...(merged.modelVariant === undefined ? {} : { modelVariant: merged.modelVariant }),
    agent: merged.agent ?? DEFAULT_OPENCODE_AGENT,
    workspace: merged.workspace ?? DEFAULT_WORKSPACE,
    cleanup: merged.cleanup ?? false,
    startClean: merged.startClean ?? false,
    dryRun: merged.dryRun ?? false,
    ...(merged.resume === undefined ? {} : { resume: merged.resume }),
    verbose: merged.verbose ?? false,
    json: merged.json ?? false,
    quiet: merged.quiet ?? false,
  };
};

export const resolveRalphieConfigs = (
  file: RalphieFileConfig,
  overrides: RalphieConfigOverrides,
): ReadonlyArray<ResolvedRalphieConfig> => {
  const { repositories, ...defaults } = file;
  if (repositories === undefined) {
    return [resolveSingleRepository(defaults, overrides)];
  }
  if (overrides.repo !== undefined) {
    throw new RalphieError({
      message: "A positional repository cannot be combined with config.repositories.",
    });
  }
  if (defaults.resume !== undefined || overrides.resume !== undefined) {
    throw new RalphieError({
      message:
        "A multi-repository run must configure resume separately on each repository entry.",
    });
  }

  const repositoryOverrides = { ...overrides };
  delete repositoryOverrides.repo;
  const resolved = repositories.map((repository) =>
    resolveSingleRepository({ ...defaults, ...repository }, repositoryOverrides),
  );
  const normalized = resolved.map(({ repo }) =>
    parseRepositorySlug(repo).slug.toLowerCase(),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new RalphieError({
      message: "Each configured repository must be unique.",
    });
  }
  return resolved;
};

export type RalphieConfigFileService = {
  readonly load: (path: string) => Effect.Effect<RalphieFileConfig, RalphieError>;
};

export const RalphieConfigFile = Context.GenericTag<RalphieConfigFileService>(
  "ralphie/RalphieConfigFile",
);

export const RalphieConfigFileLive = Layer.succeed(RalphieConfigFile, {
  load: (path) =>
    Effect.tryPromise({
      try: async () =>
        ralphieFileConfigSchema.parse(JSON.parse(await readFile(path, "utf8"))),
      catch: (cause) =>
        new RalphieError({
          message: `Config file ${path} is invalid or unreadable.`,
          cause,
        }),
    }),
});
