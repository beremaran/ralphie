import { describe, expect, test } from "bun:test";

import { yamlConfigDocumentReader } from "../src/config/adapters/yaml-file.ts";
import { type ConfigSources, resolveRalphieConfig } from "../src/options.ts";
import { writeTemporaryFile } from "./shared/config-fixture.ts";

const sources: ConfigSources = {
    reader: yamlConfigDocumentReader,
    environment: {},
    homeDirectory: "/nonexistent/ralphie-test-home",
    githubLogin: async () => "octocat",
};

describe("run configuration", () => {
    test("requires a positional repository", async () => {
        await expect(resolveRalphieConfig({}, sources)).rejects.toThrow(
            "Missing repository: provide an [owner/]repository argument.",
        );
    });

    test("maps the canonical triage roles to identical labels by default", async () => {
        const configPath = await writeTemporaryFile("{}");

        const config = await resolveRalphieConfig(
            { repo: "acme/api", configPath },
            sources,
        );

        expect(config).toMatchObject({
            repo: "acme/api",
            configPath,
            json: false,
        });
        expect(config.roles.implementer).toEqual({ harness: "claude" });
        expect(config.settings.labels).toEqual({
            "needs-triage": "needs-triage",
            "needs-info": "needs-info",
            "ready-for-agent": "ready-for-agent",
            "ready-for-human": "ready-for-human",
            wontfix: "wontfix",
        });
    });

    test("renames triage labels per repository and per run", async () => {
        const configPath = await writeTemporaryFile(`
labels:
  ready-for-agent: agent-ready
repos:
  acme/api:
    labels:
      needs-info: waiting
`);

        const config = await resolveRalphieConfig(
            {
                repo: "acme/api",
                configPath,
                overrides: ["labels.wontfix=declined"],
            },
            sources,
        );

        expect(config.settings.labels).toEqual({
            "needs-triage": "needs-triage",
            "needs-info": "waiting",
            "ready-for-agent": "agent-ready",
            "ready-for-human": "ready-for-human",
            wontfix: "declined",
        });
    });

    test("rejects an unknown triage role", async () => {
        const configPath = await writeTemporaryFile(
            "labels:\n  ready-for-robots: robots\n",
        );

        await expect(
            resolveRalphieConfig({ repo: "acme/api", configPath }, sources),
        ).rejects.toThrow("  labels.ready-for-robots: unknown key");
    });
});