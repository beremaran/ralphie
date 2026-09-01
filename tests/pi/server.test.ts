import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { makePiService } from "../../src/pi/server.ts";

const makeWorkspace = (): Promise<string> =>
    mkdtemp(`${tmpdir()}/ralphie-server-test-`);

const expectMissing = async (path: string): Promise<void> => {
    await expect(access(path)).rejects.toThrow();
};

describe("Pi runtime lifecycle", () => {
    test("removes generated configuration on normal close", async () => {
        const workspace = await makeWorkspace();
        let generatedDirectory: string | undefined;
        try {
            const service = makePiService(
                {
                    workspace,
                    modelBaseUrl: "https://example.test/v1",
                },
                undefined,
                async (options) => {
                    generatedDirectory = dirname(options?.authPath ?? "");
                    return {} as never;
                },
            );
            const runtime = await service.start();

            expect(generatedDirectory).toBeDefined();
            await runtime.close();
            await expectMissing(generatedDirectory!);
            await runtime.close();
        } finally {
            if (generatedDirectory !== undefined) {
                await rm(generatedDirectory, { recursive: true, force: true });
            }
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("removes generated configuration when startup fails", async () => {
        const workspace = await makeWorkspace();
        let generatedDirectory: string | undefined;
        try {
            const service = makePiService(
                {
                    workspace,
                    modelBaseUrl: "https://example.test/v1",
                },
                undefined,
                async (options) => {
                    generatedDirectory = dirname(options?.authPath ?? "");
                    throw new Error("simulated Pi startup failure");
                },
            );

            await expect(service.start()).rejects.toThrow(
                "Failed to start the Pi runtime.",
            );
            expect(generatedDirectory).toBeDefined();
            await expectMissing(generatedDirectory!);
        } finally {
            if (generatedDirectory !== undefined) {
                await rm(generatedDirectory, { recursive: true, force: true });
            }
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("does not remove an operator-owned directory on startup failure", async () => {
        const workspace = await makeWorkspace();
        const piDir = await mkdtemp(`${tmpdir()}/ralphie-server-custom-`);
        try {
            const service = makePiService(
                { workspace, agentDir: piDir },
                undefined,
                async () => {
                    throw new Error("simulated Pi startup failure");
                },
            );

            await expect(service.start()).rejects.toThrow(
                "Failed to start the Pi runtime.",
            );
            await access(piDir);
        } finally {
            await rm(workspace, { recursive: true, force: true });
            await rm(piDir, { recursive: true, force: true });
        }
    });
});