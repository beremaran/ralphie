import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { type PiModel } from "../agent/model.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

/**
 * How Pi's runtime should resolve models and credentials.
 *
 * - `modelBaseUrl` + `modelApiKey` (env vars) enable Option B:
 *   Ralphie writes a throwaway `models.json`/`auth.json` into a private
 *   temporary directory outside the persistent workspace.
 * - `agentDir` (Option A) points Pi at an existing configuration directory
 *   the operator manages themselves.
 */
export type PiProviderConfig = {
    readonly workspace: string;
    readonly modelBaseUrl?: string;
    readonly modelApiKey?: string;
    readonly agentDir?: string;
    readonly model?: PiModel;
};

export type AgentDirResolution = {
    readonly mode: "default" | "custom" | "ephemeral";
    readonly dir: string;
    readonly cleanup: boolean;
    readonly modelsPath: string;
    readonly authPath: string;
};

/** Environment variable names that supply the model credentials. */
export const MODEL_BASE_URL_ENV = "RALPHIE_MODEL_BASE_URL";
export const MODEL_API_KEY_ENV = "RALPHIE_MODEL_API_KEY";

const DEFAULT_MODEL_PROVIDER = "openai";
const DEFAULT_MODEL_ID = "gpt-4o";
const EPHEMERAL_DIR_PREFIX = "ralphie-pi-";

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

/** Remove a throwaway agent directory created for environment credentials. */
export const cleanupPiAgentDir = async (dir: string): Promise<void> => {
    await rm(dir, {
        recursive: true,
        force: true,
    });
};

const writePrivateJson = async (
    path: string,
    value: unknown,
): Promise<void> => {
    await writeFile(path, JSON.stringify(value, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
    // `mode` only applies when a file is created. Keep the guarantee true if
    // the filesystem or umask supplied different permissions.
    await chmod(path, 0o600);
};

const canonicalPath = async (path: string): Promise<string> => {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
};

const isPathWithin = (path: string, parent: string): boolean => {
    const childPath = relative(parent, path);
    return (
        childPath === "" ||
        (!childPath.startsWith("..") && !isAbsolute(childPath))
    );
};

const temporaryRootCandidates = (workspace: string): ReadonlyArray<string> => {
    const temporaryRoot = tmpdir();
    return [
        temporaryRoot,
        "/tmp",
        "/var/tmp",
        dirname(resolveWorkspacePath(workspace)),
        dirname(temporaryRoot),
        homedir(),
    ].filter(
        (candidate, index, candidates) =>
            candidates.indexOf(candidate) === index,
    );
};

const createPrivateTempDirectory = async (
    workspace: string,
): Promise<string> => {
    const workspacePath = await canonicalPath(resolveWorkspacePath(workspace));
    let lastError: unknown;

    for (const candidate of temporaryRootCandidates(workspace)) {
        const root = await canonicalPath(candidate);
        if (isPathWithin(root, workspacePath)) continue;

        try {
            const directory = await mkdtemp(join(root, EPHEMERAL_DIR_PREFIX));
            if (isPathWithin(await canonicalPath(directory), workspacePath)) {
                await cleanupPiAgentDir(directory);
                continue;
            }
            return directory;
        } catch (cause) {
            lastError = cause;
        }
    }

    throw new RalphieError({
        message:
            "Failed to create a private temporary directory outside the workspace for Pi credentials.",
        cause: lastError,
    });
};

const createEphemeralResolution = async (
    config: PiProviderConfig,
): Promise<AgentDirResolution> => {
    const providerId = config.model?.providerID ?? DEFAULT_MODEL_PROVIDER;
    const modelId = config.model?.modelID ?? DEFAULT_MODEL_ID;
    if (providerId.trim().length === 0) {
        throw new RalphieError({
            message: "Ralphie model provider id must not be empty.",
        });
    }

    const dir = await createPrivateTempDirectory(config.workspace);
    try {
        await chmod(dir, 0o700);
        const modelsPath = join(dir, "models.json");
        const authPath = join(dir, "auth.json");
        await writePrivateJson(
            modelsPath,
            buildModelsJson(providerId, config.modelBaseUrl!, modelId),
        );
        await writePrivateJson(
            authPath,
            buildAuthJson(providerId, config.modelApiKey),
        );
        return makeResolution("ephemeral", dir, true, modelsPath, authPath);
    } catch (cause) {
        await cleanupPiAgentDir(dir).catch(() => undefined);
        throw cause;
    }
};

/**
 * Decide which agent directory Pi should read, and (for environment
 * credentials) write the throwaway configuration files. The workspace is not
 * used as a credential location.
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
        return createEphemeralResolution(config);
    }

    return makeResolution(
        "default",
        getAgentDir(),
        false,
        undefined,
        undefined,
    );
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