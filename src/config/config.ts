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
import { redactSensitiveText } from "../shared/redaction.ts";

export const DEFAULT_BRANCH = "main";
export const DEFAULT_WORKSPACE = "~/.ralphie";

const nonEmptyString = z.string().trim().min(1);
const optionalConfigValue = <Schema extends z.ZodType>(schema: Schema) =>
  schema
    .nullable()
    .transform((value) => value ?? undefined)
    .optional();

const repositoryOptionShape = {
  branch: optionalConfigValue(nonEmptyString),
  maxIssues: optionalConfigValue(z.number().int().positive()),
  issueLabels: optionalConfigValue(z.array(nonEmptyString)),
  issueSort: optionalConfigValue(z.enum(IssueSort)),
  issueOrder: optionalConfigValue(z.enum(IssueOrder)),
  model: optionalConfigValue(openCodeModelSchema),
  modelVariant: optionalConfigValue(openCodeModelVariantSchema),
  agent: optionalConfigValue(nonEmptyString),
  dryRun: optionalConfigValue(z.boolean()),
  resume: optionalConfigValue(nonEmptyString),
};

export const ralphieRepositoryConfigSchema = z
  .object({
    repo: nonEmptyString,
    ...repositoryOptionShape,
  })
  .strict();

export const ralphieFileConfigSchema = z
  .object({
    repo: optionalConfigValue(nonEmptyString),
    repositories: z.array(ralphieRepositoryConfigSchema).min(1).optional(),
    ...repositoryOptionShape,
    workspace: optionalConfigValue(nonEmptyString),
    cleanup: optionalConfigValue(z.boolean()),
    startClean: optionalConfigValue(z.boolean()),
    verbose: optionalConfigValue(z.boolean()),
    json: optionalConfigValue(z.boolean()),
    quiet: optionalConfigValue(z.boolean()),
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
