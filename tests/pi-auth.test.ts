import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileCredentialStore } from "../src/pi/auth.ts";

const withStore = async (
    run: (input: {
        readonly store: FileCredentialStore;
        readonly path: string;
        readonly directory: string;
    }) => Promise<void>,
): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-auth-"));
    const path = join(directory, "nested", "auth.json");
    try {
        await run({
            store: new FileCredentialStore({ path }),
            path,
            directory,
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

describe("pi credential store", () => {
    test("reads a missing file as empty and persists modifications", async () => {
        await withStore(async ({ store, path }) => {
            expect(await store.read("anthropic")).toBeUndefined();

            await store.modify("anthropic", async () => ({
                type: "api_key",
                key: "sk-test",
            }));

            expect(await store.read("anthropic")).toEqual({
                type: "api_key",
                key: "sk-test",
            });
            const written = JSON.parse(await readFile(path, "utf8"));
            expect(written).toEqual({
                anthropic: { type: "api_key", key: "sk-test" },
            });
        });
    });

    test("lists only non-secret provider metadata", async () => {
        await withStore(async ({ store }) => {
            await store.modify("openai", async () => ({
                type: "api_key",
                key: "sk-secret",
            }));
            await store.modify("anthropic", async () => ({
                type: "oauth",
                refresh: "r",
                access: "a",
                expires: 1,
            }));

            expect(
                [...(await store.list())].sort((a, b) =>
                    a.providerId.localeCompare(b.providerId),
                ),
            ).toEqual([
                { providerId: "anthropic", type: "oauth" },
                { providerId: "openai", type: "api_key" },
            ]);
        });
    });

    test("leaves the current credential unchanged when modify returns undefined", async () => {
        await withStore(async ({ store }) => {
            await store.modify("openai", async () => ({
                type: "api_key",
                key: "sk-test",
            }));
            const result = await store.modify("openai", async (current) => {
                expect(current).toEqual({ type: "api_key", key: "sk-test" });
                return undefined;
            });

            expect(result).toEqual({ type: "api_key", key: "sk-test" });
        });
    });

    test("deletes a credential and tolerates a missing entry", async () => {
        await withStore(async ({ store }) => {
            await store.modify("openai", async () => ({
                type: "api_key",
                key: "sk-test",
            }));
            await store.delete("openai");
            await store.delete("openai");

            expect(await store.read("openai")).toBeUndefined();
        });
    });

    test("serializes concurrent modifications without losing entries", async () => {
        await withStore(async ({ store }) => {
            await Promise.all(
                ["openai", "anthropic", "google", "xai"].map(
                    async (providerId) =>
                        await store.modify(providerId, async () => ({
                            type: "api_key",
                            key: `key-${providerId}`,
                        })),
                ),
            );

            expect(
                (await store.list()).map(({ providerId }) => providerId).sort(),
            ).toEqual(["anthropic", "google", "openai", "xai"]);
        });
    });

    test("strips a BOM and rejects malformed JSON", async () => {
        await withStore(async ({ store, path }) => {
            await store.modify("openai", async () => ({
                type: "api_key",
                key: "sk-test",
            }));
            const written = await readFile(path, "utf8");
            await writeFile(path, `\uFEFF${written}`, "utf8");
            expect(await store.read("openai")).toEqual({
                type: "api_key",
                key: "sk-test",
            });

            await writeFile(path, "not json", "utf8");
            await expect(store.read("openai")).rejects.toThrow(
                /Failed to read the pi credential store/,
            );
        });
    });

    test("honors a pre-aborted signal", async () => {
        await withStore(async ({ store }) => {
            const controller = new AbortController();
            controller.abort(new Error("cancelled"));
            await expect(
                store.read("openai", { signal: controller.signal }),
            ).rejects.toThrow("cancelled");
        });
    });
});