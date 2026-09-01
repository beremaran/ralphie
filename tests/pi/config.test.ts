import { describe, expect, test } from "bun:test";
import {
    access,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { cleanupPiAgentDir, resolvePiAgentDir } from "../../src/pi/config.ts";

const makeWorkspace = (): Promise<string> =>
    mkdtemp(join(tmpdir(), "ralphie-config-test-"));

const fileMode = async (path: string): Promise<number> =>
    (await stat(path)).mode & 0o777;

const expectMissing = async (path: string): Promise<void> => {
    await expect(access(path)).rejects.toThrow();
};

describe("Pi agent directory resolution", () => {
    test("uses Pi's default directory without creating workspace configuration", async () => {
        const workspace = await makeWorkspace();
        try {
            const resolution = await resolvePiAgentDir({ workspace });

            expect(resolution).toMatchObject({
                mode: "default",
                dir: getAgentDir(),
                cleanup: false,
                modelsPath: join(getAgentDir(), "models.json"),
                authPath: join(getAgentDir(), "auth.json"),
            });
            await expectMissing(join(workspace, ".ralphie", "pi"));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("preserves an explicitly supplied operator directory", async () => {
        const workspace = await makeWorkspace();
        const piDir = await mkdtemp(join(tmpdir(), "ralphie-custom-pi-"));
        try {
            await writeFile(join(piDir, "operator-owned"), "keep me");
            const resolution = await resolvePiAgentDir({
                workspace,
                agentDir: piDir,
                modelBaseUrl: "https://example.test/v1",
            });

            expect(resolution).toEqual({
                mode: "custom",
                dir: piDir,
                cleanup: false,
                modelsPath: join(piDir, "models.json"),
                authPath: join(piDir, "auth.json"),
            });
            expect(await readFile(join(piDir, "operator-owned"), "utf8")).toBe(
                "keep me",
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
            await rm(piDir, { recursive: true, force: true });
        }
    });

    test("keeps ephemeral configuration outside a workspace used as the temp root", async () => {
        const workspace = tmpdir();
        let directory: string | undefined;
        try {
            const resolution = await resolvePiAgentDir({
                workspace,
                modelBaseUrl: "https://example.test/v1",
            });
            directory = resolution.dir;

            expect(directory).not.toStartWith(`${workspace}${sep}`);
            await cleanupPiAgentDir(directory);
            directory = undefined;
        } finally {
            if (directory !== undefined) await cleanupPiAgentDir(directory);
        }
    });

    test("creates private temporary configuration with secure permissions and cleans it up", async () => {
        const workspace = await makeWorkspace();
        let directory: string | undefined;
        try {
            const resolution = await resolvePiAgentDir({
                workspace,
                modelBaseUrl: "https://example.test/v1",
                modelApiKey: "test-secret",
            });
            directory = resolution.dir;

            expect(resolution.mode).toBe("ephemeral");
            expect(resolution.cleanup).toBe(true);
            expect(directory).not.toContain(join(workspace, ".ralphie"));
            expect(await fileMode(directory)).toBe(0o700);
            expect(await fileMode(resolution.modelsPath)).toBe(0o600);
            expect(await fileMode(resolution.authPath)).toBe(0o600);
            expect(
                JSON.parse(await readFile(resolution.authPath, "utf8")),
            ).toEqual({
                openai: { type: "api_key", key: "test-secret" },
            });

            await cleanupPiAgentDir(directory);
            await expectMissing(directory);
            directory = undefined;
        } finally {
            if (directory !== undefined) await cleanupPiAgentDir(directory);
            await rm(workspace, { recursive: true, force: true });
        }
    });
});