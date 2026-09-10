import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentModel } from "../agent/model.ts";

/** Pi's config-directory override; see https://pi.dev/docs/latest. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_AUTH_FILE_NAME = "auth.json";
export const PI_SETTINGS_FILE_NAME = "settings.json";

export type PiAgentConfig = {
    /** Model selected by --model; when absent the pi settings default applies. */
    readonly model?: AgentModel;
    /** Test seam: override the pi agent directory (default `~/.pi/agent`). */
    readonly agentDir?: string;
};

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