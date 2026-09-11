import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import {
    makePiModels,
    piModelCatalog,
    readPiDefaultModel,
    resolvePiModel,
} from "../src/adapters/pi/models.ts";
import { thinkingLevelFor } from "../src/core/domain/pi-models.ts";

const makeFauxModels = () => {
    const faux = fauxProvider({
        models: [{ id: "faux-model", reasoning: true }],
        tokensPerSecond: 100_000,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, faux };
};

describe("pi thinking levels", () => {
    test("maps unset and default variants to the medium default", () => {
        expect(thinkingLevelFor(undefined)).toBe("medium");
        expect(thinkingLevelFor("")).toBe("medium");
        expect(thinkingLevelFor("default")).toBe("medium");
    });

    test("passes through supported levels", () => {
        for (const level of [
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ] as const) {
            expect(thinkingLevelFor(level)).toBe(level);
        }
    });

    test("rejects an unsupported level with the supported list", () => {
        expect(() => thinkingLevelFor("banana")).toThrow(
            /Unsupported thinking level/,
        );
    });
});

describe("pi default model settings", () => {
    test("reads defaultProvider and defaultModel from settings.json", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-models-"));
        try {
            await writeFile(
                join(directory, "settings.json"),
                JSON.stringify({
                    defaultProvider: "anthropic",
                    defaultModel: "claude-sonnet-4-6",
                }),
                "utf8",
            );
            expect(await readPiDefaultModel(directory)).toEqual({
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("returns undefined for a missing or partial settings file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-models-"));
        try {
            expect(await readPiDefaultModel(directory)).toBeUndefined();
            await writeFile(
                join(directory, "settings.json"),
                JSON.stringify({ defaultProvider: "anthropic" }),
                "utf8",
            );
            expect(await readPiDefaultModel(directory)).toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects malformed settings JSON", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-pi-models-"));
        try {
            await writeFile(
                join(directory, "settings.json"),
                "not json",
                "utf8",
            );
            await expect(readPiDefaultModel(directory)).rejects.toThrow(
                /not valid JSON/,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("pi model resolution", () => {
    test("resolves an explicit selection against the catalog", async () => {
        const { models, faux } = makeFauxModels();
        const resolved = await resolvePiModel({
            models,
            selection: { providerID: "faux", modelID: "faux-model" },
            agentDir: "/nonexistent",
        });
        expect(resolved.provider).toBe("faux");
        expect(resolved.id).toBe("faux-model");
        expect(faux.state.callCount).toBe(0);
    });

    test("resolves the configured default when no selection is provided", async () => {
        const { models } = makeFauxModels();
        const resolved = await resolvePiModel({
            models,
            defaultModel: { providerID: "faux", modelID: "faux-model" },
            agentDir: "/nonexistent",
        });
        expect(resolved.id).toBe("faux-model");
    });

    test("reports an unknown model with remediation", async () => {
        const { models } = makeFauxModels();
        await expect(
            resolvePiModel({
                models,
                selection: { providerID: "faux", modelID: "missing" },
                agentDir: "/nonexistent",
            }),
        ).rejects.toThrow(/was not found in the pi catalog/);
    });

    test("reports a missing default model with remediation", async () => {
        const { models } = makeFauxModels();
        await expect(
            resolvePiModel({ models, agentDir: "/nonexistent" }),
        ).rejects.toThrow(/No model selected/);
    });

    test("builds a catalog that includes provider, id, and thinking levels", () => {
        const { models } = makeFauxModels();
        const catalog = piModelCatalog(models);
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
            provider: "faux",
            id: "faux-model",
        });
        expect(catalog[0]?.thinkingLevels.length).toBeGreaterThan(0);
    });

    test("builds the real built-in catalog offline", () => {
        const models = makePiModels();
        expect(models.getProvider("anthropic")).toBeDefined();
        expect(models.getModels().length).toBeGreaterThan(100);
    });
});