import { parseRepositoryArgument } from "./github/repository.ts";
import { DEFAULT_AGENT, type AgentModel } from "./agent/model.ts";
import { loadSettings, type LoadSettingsInput } from "./config/load.ts";
import type { RepositorySettings } from "./config/settings.ts";
import { RalphieError } from "./shared/error.ts";

/** What the command line itself carries; every other setting is config. */
export type RalphieCliOptions = {
    readonly repo?: string;
    readonly configPath?: string;
    readonly overrides?: ReadonlyArray<string>;
    /** Temporary until the harness switch-over replaces it with config. */
    readonly model?: AgentModel;
    /** Temporary until the harness switch-over replaces it with config. */
    readonly thinking?: string;
    readonly json?: boolean;
};

/** Where configuration comes from, supplied by the composition root. */
export type ConfigSources = Pick<
    LoadSettingsInput,
    "reader" | "environment" | "homeDirectory" | "githubLogin"
>;

/** The resolved configuration for one issue-workflow run. */
export type ResolvedRalphieConfig = {
    readonly repo: string;
    readonly configPath: string;
    /** Effective settings for `repo`, with every default applied. */
    readonly settings: RepositorySettings;
    readonly model?: AgentModel;
    readonly thinking?: string;
    readonly agent: string;
    readonly json: boolean;
};

/** Resolve the run configuration from the command line and the config file. */
export const resolveRalphieConfig = async (
    options: RalphieCliOptions,
    sources: ConfigSources,
): Promise<ResolvedRalphieConfig> => {
    if (options.repo === undefined) {
        throw new RalphieError({
            message:
                "Missing repository: provide an [owner/]repository argument.",
        });
    }
    const loaded = await loadSettings({
        ...sources,
        ...(options.configPath === undefined
            ? {}
            : { configPath: options.configPath }),
        overrides: options.overrides ?? [],
        repository: parseRepositoryArgument(options.repo),
    });
    return {
        repo: loaded.repository,
        configPath: loaded.configPath,
        settings: loaded.settings,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinking === undefined
            ? {}
            : { thinking: options.thinking }),
        agent: DEFAULT_AGENT,
        json: options.json ?? false,
    };
};
