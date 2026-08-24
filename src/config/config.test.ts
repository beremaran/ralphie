import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { IssueOrder, IssueSort } from "../github/issues.ts";
import {
  DEFAULT_BRANCH,
  DEFAULT_WORKSPACE,
  RalphieConfigFile,
  RalphieConfigFileLive,
  resolveRalphieConfig,
  resolveRalphieConfigs,
} from "./config.ts";

describe("Ralphie JSON config", () => {
  test("applies defaults when only the repository is configured", () => {
    expect(resolveRalphieConfig({ repo: "owner/repo" }, {})).toEqual({
      repo: "owner/repo",
      branch: DEFAULT_BRANCH,
      issueLabels: [],
      issueSort: IssueSort.Created,
      issueOrder: IssueOrder.Ascending,
      agent: "build",
      workspace: DEFAULT_WORKSPACE,
      cleanup: false,
      startClean: false,
      dryRun: false,
      verbose: false,
      json: false,
      quiet: false,
    });
  });

  test("lets explicit CLI values override file values, including false", () => {
    const resolved = resolveRalphieConfig(
      {
        repo: "file/repo",
        branch: "develop",
        maxIssues: 10,
        issueLabels: ["bug"],
        cleanup: true,
        model: { providerID: "openai", modelID: "gpt-5" },
      },
      {
        repo: "cli/repo",
        branch: "main",
        maxIssues: 2,
        issueLabels: ["urgent"],
        cleanup: false,
      },
    );

    expect(resolved).toMatchObject({
      repo: "cli/repo",
      branch: "main",
      maxIssues: 2,
      issueLabels: ["urgent"],
      cleanup: false,
      model: { providerID: "openai", modelID: "gpt-5" },
    });
  });

  test("requires a repository after merging both sources", () => {
    expect(() => resolveRalphieConfig({}, {})).toThrow("Missing repository");
  });

  test("rejects incompatible output modes after merging", () => {
    expect(() =>
      resolveRalphieConfig({ repo: "owner/repo", json: true }, { quiet: true }),
    ).toThrow("cannot be enabled together");
  });

  test("resolves repository entries in order with shared defaults and local overrides", () => {
    expect(
      resolveRalphieConfigs(
        {
          branch: "develop",
          maxIssues: 10,
          repositories: [
            { repo: "owner/frontend", issueLabels: ["frontend"] },
            { repo: "owner/backend", branch: "release", maxIssues: 2 },
          ],
        },
        { agent: "reviewer" },
      ),
    ).toMatchObject([
      {
        repo: "owner/frontend",
        branch: "develop",
        maxIssues: 10,
        issueLabels: ["frontend"],
        agent: "reviewer",
      },
      {
        repo: "owner/backend",
        branch: "release",
        maxIssues: 2,
        agent: "reviewer",
      },
    ]);
  });

  test("applies explicit CLI overrides to every configured repository", () => {
    const resolved = resolveRalphieConfigs(
      {
        repositories: [
          { repo: "owner/one", branch: "one" },
          { repo: "owner/two", branch: "two" },
        ],
      },
      { branch: "cli", cleanup: true },
    );

    expect(resolved.map(({ branch }) => branch)).toEqual(["cli", "cli"]);
    expect(resolved.every(({ cleanup }) => cleanup)).toBeTrue();
  });

  test("rejects ambiguous and duplicate repository configurations", () => {
    expect(() =>
      resolveRalphieConfigs(
        { repositories: [{ repo: "owner/one" }] },
        { repo: "owner/positional" },
      ),
    ).toThrow("positional repository");
    expect(() =>
      resolveRalphieConfigs(
        {
          repositories: [{ repo: "owner/one" }, { repo: "OWNER/ONE" }],
        },
        {},
      ),
    ).toThrow("must be unique");
    expect(() =>
      resolveRalphieConfigs(
        { repositories: [{ repo: "owner/one" }, { repo: "owner/two" }] },
        { resume: "/tmp/state.json" },
      ),
    ).toThrow("resume separately");
  });

  test("loads and transforms a strict JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-"));
    const path = join(directory, "ralphie.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          repo: "owner/repo",
          maxIssues: 3,
          model: "openai/gpt-5",
        }),
      );
      const config = await Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(path);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);

      expect(config).toEqual({
        repo: "owner/repo",
        maxIssues: 3,
        model: { providerID: "openai", modelID: "gpt-5" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("treats null optional values as unset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-null-"));
    const path = join(directory, "ralphie.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          repo: "owner/repo",
          maxIssues: null,
          issueLabels: null,
          model: null,
          cleanup: null,
        }),
      );
      const config = await Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(path);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);

      expect(resolveRalphieConfig(config, {})).toMatchObject({
        repo: "owner/repo",
        issueLabels: [],
        cleanup: false,
      });
      expect(resolveRalphieConfig(config, {}).maxIssues).toBeUndefined();
      expect(resolveRalphieConfig(config, {}).model).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the published example valid", async () => {
    const config = await Effect.gen(function* () {
      const files = yield* RalphieConfigFile;
      return yield* files.load(join(import.meta.dir, "../../ralphie.example.json"));
    }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);

    expect(config.repositories?.map(({ repo }) => repo)).toEqual([
      "owner/frontend",
      "owner/backend",
    ]);
    expect(config.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
  });

  test("explains malformed JSON and every schema violation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-invalid-"));
    try {
      const malformedPath = join(directory, "malformed.json");
      await writeFile(malformedPath, "{");
      const malformed = Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(malformedPath);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
      await expect(malformed).rejects.toThrow("contains malformed JSON");

      const invalidPath = join(directory, "invalid.json");
      await writeFile(
        invalidPath,
        JSON.stringify({
          repositories: [{ repo: "owner/one" }, { repo: 42 }],
          maxIssues: 0,
          typo: true,
        }),
      );
      const invalid = Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(invalidPath);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
      await expect(invalid).rejects.toThrow("maxIssues: Too small");
      await expect(invalid).rejects.toThrow("repositories[1].repo");
      await expect(invalid).rejects.toThrow('config: Unrecognized key: "typo"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("distinguishes a missing config file", async () => {
    const missingPath = join(tmpdir(), `missing-ralphie-${crypto.randomUUID()}.json`);
    const missing = Effect.gen(function* () {
      const files = yield* RalphieConfigFile;
      return yield* files.load(missingPath);
    }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);

    await expect(missing).rejects.toThrow(`Config file not found: ${missingPath}.`);
  });
});
