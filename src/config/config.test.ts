import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
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

  test("keeps the published example valid", async () => {
    const config = await Effect.gen(function* () {
      const files = yield* RalphieConfigFile;
      return yield* files.load(join(import.meta.dir, "../../ralphie.example.json"));
    }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);

    expect(config.repo).toBe("owner/repository");
    expect(config.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
  });

  test("rejects malformed JSON and unknown keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-invalid-"));
    try {
      for (const [name, content] of [
        ["malformed.json", "{"],
        ["unknown.json", JSON.stringify({ repo: "owner/repo", typo: true })],
      ] as const) {
        const path = join(directory, name);
        await writeFile(path, content);
        const exit = await Effect.gen(function* () {
          const files = yield* RalphieConfigFile;
          return yield* files.load(path);
        }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromiseExit);
        expect(Exit.isFailure(exit)).toBeTrue();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
