import { randomUUID } from "node:crypto";
import { mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

/**
 * How Pi's runtime should resolve models and credentials.
 *
 * - `baseUrl` + `apiKey` (or their env-var equivalents) enable Option B:
 *   Ralphie writes a throwaway `models.json`/`auth.json` into an isolated
 *   `0600` directory inside the workspace so users never need a pre-existing
 *   Pi configuration.
 * - `agentDir` (Option A) points Pi at an existing configuration directory
 *   the operator manages themselves.
 */
export type PiProviderConfig = {
  readonly workspace: string;
  readonly modelBaseUrl?: string;
  readonly modelApiKey?: string;
  readonly agentDir?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
};

type AgentDirResolution = {
  readonly mode: "default" | "custom" | "ephemeral";
  readonly dir: string;
  readonly cleanup: boolean;
  readonly modelsPath: string;
  readonly authPath: string;
};

/** Environment variable names that back the `--model-base-url`/`--api-key` flags. */
export const MODEL_BASE_URL_ENV = "RALPHIE_MODEL_BASE_URL";
export const MODEL_API_KEY_ENV = "RALPHIE_MODEL_API_KEY";

const DEFAULT_MODEL_PROVIDER = "openai";

/**
 * Decide which agent directory Pi should read, and (for Option B) write the
 * throwaway configuration files. The caller must ensure the workspace exists.
 */
export const resolvePiAgentDir = async (
  config: PiProviderConfig,
): Promise<AgentDirResolution> => {
  // Option A wins when explicitly requested: the operator owns this directory.
  if (config.agentDir !== undefined) {
    return makeResolution(
      "custom",
      config.agentDir,
      false,
      undefined,
      undefined,
    );
  }

  // Option B: generate a throwaway config for an OpenAI-compatible endpoint.
  if (config.modelBaseUrl !== undefined) {
    const providerId = config.modelProvider ?? DEFAULT_MODEL_PROVIDER;
    const modelId = config.modelId ?? "gpt-4o";
    if (providerId.trim().length === 0) {
      throw new RalphieError({
        message: "Ralphie model provider id must not be empty.",
      });
    }
    const dir = join(
      resolveWorkspacePath(config.workspace),
      ".ralphie",
      "pi",
      randomUUID(),
    );
    await mkdir(dir, {
      recursive: true,
    });
    await chmod(dir, 0o600);

    const modelsPath = join(dir, "models.json");
    const authPath = join(dir, "auth.json");
    await writeFile(
      modelsPath,
      JSON.stringify(
        buildModelsJson(providerId, config.modelBaseUrl, modelId),
        null,
        2,
      ),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await chmod(modelsPath, 0o600);
    await writeFile(
      authPath,
      JSON.stringify(buildAuthJson(providerId, config.modelApiKey), null, 2),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await chmod(authPath, 0o600);

    return makeResolution("ephemeral", dir, true, modelsPath, authPath);
  }

  return makeResolution("default", getAgentDir(), false, undefined, undefined);
};

const makeResolution = (
  mode: AgentDirResolution["mode"],
  dir: string,
  cleanup: boolean,
  modelsPath: string | undefined,
  authPath: string | undefined,
): AgentDirResolution => ({
  mode,
  dir,
  cleanup,
  modelsPath: modelsPath ?? join(dir, "models.json"),
  authPath: authPath ?? join(dir, "auth.json"),
});

/** Remove a throwaway agent directory created for Option B. */
export const cleanupPiAgentDir = async (dir: string): Promise<void> => {
  await rm(dir, {
    recursive: true,
    force: true,
  });
};

const buildModelsJson = (
  providerId: string,
  baseUrl: string,
  modelId: string,
): unknown => ({
  providers: {
    [providerId]: {
      name: providerId,
      baseUrl,
      api: "openai",
      models: [
        {
          id: modelId,
          api: "openai",
        },
      ],
    },
  },
});

const buildAuthJson = (providerId: string, apiKey?: string): unknown => ({
  [providerId]: {
    type: "api_key" as const,
    key: apiKey,
  },
});