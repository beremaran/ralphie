import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { RalphieError } from "../../shared/error.ts";
import type { ConfigFile, ConfigSourceService } from "../ports.ts";

export type FileConfigSourceOptions = {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly home?: string;
};

/** `$XDG_CONFIG_HOME/ralphie/config.yaml`, else `~/.config/ralphie/config.yaml`. */
export const defaultConfigPath = ({
    env = process.env,
    home = homedir(),
}: FileConfigSourceOptions = {}): string => {
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg === undefined || xdg === "" ? join(home, ".config") : xdg;
    return join(base, "ralphie", "config.yaml");
};

const isMissing = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";

const readConfigText = async (
    path: string,
    explicit: boolean,
): Promise<string> => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (!isMissing(error)) throw error;
        throw new RalphieError({
            message: explicit
                ? `Configuration file not found: ${path}`
                : `No Ralphie configuration found at ${path}. Create it as described in docs/configuration.md, or pass --config <path>.`,
            cause: error,
        });
    }
};

const parseConfigText = (text: string, path: string): unknown => {
    try {
        return Bun.YAML.parse(text) ?? {};
    } catch (error) {
        throw new RalphieError({
            message: `Configuration file ${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
        });
    }
};

export const makeFileConfigSource = (
    options: FileConfigSourceOptions = {},
): ConfigSourceService => ({
    load: async (explicitPath): Promise<ConfigFile> => {
        const path =
            explicitPath === undefined
                ? defaultConfigPath(options)
                : resolve(explicitPath);
        const text = await readConfigText(path, explicitPath !== undefined);
        return { path, document: parseConfigText(text, path) };
    },
});