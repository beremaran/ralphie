import { isAbsolute, join } from "node:path";

import type { z } from "zod";

import {
    parseRepositorySlug,
    type RepositoryArgument,
} from "../github/repository.ts";
import { RalphieError } from "../shared/error.ts";
import {
    applyOverrides,
    type ConfigMapping,
    formatConfigPath,
    isMapping,
    mergeMappings,
    parseSetOverride,
    type SetOverride,
} from "./overrides.ts";
import type { ConfigDocumentReader } from "./ports.ts";
import {
    configFileSchema,
    type RepositorySettings,
    repositorySettingsSchema,
} from "./settings.ts";

export type LoadSettingsInput = {
    readonly reader: ConfigDocumentReader;
    /** The `--config` path; the XDG location is used when absent. */
    readonly configPath?: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory: string;
    /** Raw `--set path=value` arguments, in command-line order. */
    readonly overrides: ReadonlyArray<string>;
    readonly repository: RepositoryArgument;
    /** The authenticated `gh` login; read only for a bare repository name. */
    readonly githubLogin: () => Promise<string>;
};

export type LoadedSettings = {
    readonly configPath: string;
    /** The resolved `owner/repo` slug. */
    readonly repository: string;
    readonly settings: RepositorySettings;
};

/** `$XDG_CONFIG_HOME/ralphie/config.yaml`, else `~/.config/ralphie/config.yaml`. */
export const defaultConfigPath = (
    environment: Readonly<Record<string, string | undefined>>,
    homeDirectory: string,
): string => {
    const xdg = environment.XDG_CONFIG_HOME;
    const base =
        xdg !== undefined && isAbsolute(xdg)
            ? xdg
            : join(homeDirectory, ".config");
    return join(base, "ralphie", "config.yaml");
};

const missingConfiguration = (path: string, explicit: boolean): RalphieError =>
    new RalphieError({
        message: explicit
            ? `Configuration file not found: ${path}.`
            : `No configuration file found at ${path}. Create one as described in docs/configuration.md, or pass --config <path>.`,
    });

const startsWith = (
    path: ReadonlyArray<PropertyKey>,
    prefix: ReadonlyArray<PropertyKey>,
): boolean =>
    prefix.length <= path.length &&
    prefix.every((segment, index) => String(path[index]) === String(segment));

const issueLines = (
    issue: z.core.$ZodIssue,
): ReadonlyArray<{ path: PropertyKey[]; message: string }> => {
    if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
            path: [...issue.path, key],
            message: "unknown key",
        }));
    }
    const message =
        issue.code === "invalid_key"
            ? (issue.issues[0]?.message ?? issue.message)
            : issue.message;
    return [{ path: [...issue.path], message }];
};

const validate = <Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
    source: string,
    overrides: ReadonlyArray<SetOverride>,
): z.output<Schema> => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const lines = result.error.issues.flatMap(issueLines).map((line) => {
        const fromSet = overrides.some((override) =>
            startsWith(line.path, override.path),
        );
        return `  ${formatConfigPath(line.path)}: ${line.message}${fromSet ? " (from --set)" : ""}`;
    });
    throw new RalphieError({
        message: `Invalid configuration in ${source}:\n${lines.join("\n")}`,
    });
};

const resolveRepository = async (
    argument: RepositoryArgument,
    defaultOwner: string | undefined,
    githubLogin: () => Promise<string>,
): Promise<string> => {
    if (argument.kind === "slug") return argument.slug.slug;
    const owner = defaultOwner ?? (await githubLogin());
    return parseRepositorySlug(`${owner}/${argument.name}`).slug;
};

const repositoryEntry = (
    repos: unknown,
    repository: string,
): ConfigMapping => {
    if (!isMapping(repos)) return {};
    const wanted = repository.toLowerCase();
    const match = Object.entries(repos).find(
        ([key]) => key.toLowerCase() === wanted,
    );
    return isMapping(match?.[1]) ? match[1] : {};
};

const withoutFileOnlyKeys = ({
    defaultOwner: _defaultOwner,
    repos: _repos,
    ...settings
}: ConfigMapping): ConfigMapping => settings;

const documentMapping = (content: unknown, path: string): ConfigMapping => {
    if (content === null || content === undefined) return {};
    if (isMapping(content)) return content;
    throw new RalphieError({
        message: `Invalid configuration in ${path}: the file must be a mapping of settings.`,
    });
};

/**
 * Load the configuration for one run. Precedence, lowest first: built-in
 * defaults, top-level settings, the matching `repos:` entry, then `--set`.
 */
export const loadSettings = async (
    input: LoadSettingsInput,
): Promise<LoadedSettings> => {
    const configPath =
        input.configPath ??
        defaultConfigPath(input.environment, input.homeDirectory);
    const document = await input.reader.read(configPath);
    if (!document.found) {
        throw missingConfiguration(configPath, input.configPath !== undefined);
    }
    const overrides = input.overrides.map((text) =>
        parseSetOverride(text, input.reader.parseValue),
    );
    const raw = applyOverrides(
        documentMapping(document.content, configPath),
        overrides,
    );
    const file = validate(configFileSchema, raw, configPath, overrides);
    const repository = await resolveRepository(
        input.repository,
        file.defaultOwner,
        input.githubLogin,
    );
    const runOverrides = applyOverrides(
        {},
        overrides.filter((override) => override.path[0] !== "repos"),
    );
    const merged = [
        repositoryEntry(raw.repos, repository),
        withoutFileOnlyKeys(runOverrides),
    ].reduce(mergeMappings, withoutFileOnlyKeys(raw));
    return {
        configPath,
        repository,
        settings: validate(
            repositorySettingsSchema,
            merged,
            configPath,
            overrides,
        ),
    };
};
