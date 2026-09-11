import { homedir } from "node:os";
import { join } from "node:path";

/** Pi's config-directory override; see https://pi.dev/docs/latest. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_AUTH_FILE_NAME = "auth.json";
export const PI_SETTINGS_FILE_NAME = "settings.json";

/** Resolve pi's agent directory without touching the filesystem. */
export const resolvePiAgentDir = (
    environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
    const configured = environment[PI_AGENT_DIR_ENV]?.trim();
    return configured === undefined || configured === ""
        ? join(homedir(), ".pi", "agent")
        : configured;
};

export const piAuthPathFor = (agentDir: string): string =>
    join(agentDir, PI_AUTH_FILE_NAME);

export const piSettingsPathFor = (agentDir: string): string =>
    join(agentDir, PI_SETTINGS_FILE_NAME);