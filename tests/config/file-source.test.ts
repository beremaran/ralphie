import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    defaultConfigPath,
    makeFileConfigSource,
} from "../../src/config/adapters/file-source.ts";

describe("file configuration source", () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "ralphie-config-"));
    });
    afterEach(() => rm(root, { recursive: true, force: true }));

    test("prefers XDG_CONFIG_HOME and falls back to ~/.config", () => {
        expect(
            defaultConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/h" }),
        ).toBe("/xdg/ralphie/config.yaml");
        expect(defaultConfigPath({ env: {}, home: "/h" })).toBe(
            "/h/.config/ralphie/config.yaml",
        );
        expect(
            defaultConfigPath({ env: { XDG_CONFIG_HOME: "" }, home: "/h" }),
        ).toBe("/h/.config/ralphie/config.yaml");
    });

    test("loads and parses the default file", async () => {
        const dir = join(root, "ralphie");
        await mkdir(dir);
        await writeFile(
            join(dir, "config.yaml"),
            "defaultOwner: acme\nrepos:\n  acme/widgets:\n    verify:\n      - bun run check\n",
        );
        const file = await makeFileConfigSource({
            env: { XDG_CONFIG_HOME: root },
        }).load();
        expect(file.path).toBe(join(dir, "config.yaml"));
        expect(file.document).toEqual({
            defaultOwner: "acme",
            repos: { "acme/widgets": { verify: ["bun run check"] } },
        });
    });

    test("loads an explicit path and treats an empty file as an empty config", async () => {
        const path = join(root, "custom.yaml");
        await writeFile(path, "");
        const file = await makeFileConfigSource({ env: {} }).load(path);
        expect(file).toEqual({ path, document: {} });
    });

    test("explains a missing default file", async () => {
        await expect(
            makeFileConfigSource({ env: { XDG_CONFIG_HOME: root } }).load(),
        ).rejects.toThrow("No Ralphie configuration found at");
    });

    test("names a missing explicit file", async () => {
        const path = join(root, "missing.yaml");
        await expect(
            makeFileConfigSource({ env: {} }).load(path),
        ).rejects.toThrow(`Configuration file not found: ${path}`);
    });

    test("reports invalid YAML with the file path", async () => {
        const path = join(root, "bad.yaml");
        await writeFile(path, "a: [");
        await expect(
            makeFileConfigSource({ env: {} }).load(path),
        ).rejects.toThrow(`${path} is not valid YAML`);
    });
});