import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IssueOrder, IssueSort } from "../github/issues.ts";
import {
  DEFAULT_WORKSPACE,
  IMPLICIT_PROJECT_NAME,
  RalphieConfigFile,
  RalphieConfigFileLive,
  RepositoryTargetKind,
  resolveRalphieConfig,
} from "./config.ts";

describe("hierarchical Ralphie JSON config", () => {
  test("synthesizes an implicit project for a positional repository", () => {
    expect(resolveRalphieConfig({}, { repo: "owner/repo" })).toEqual({
      projects: [
        {
          name: IMPLICIT_PROJECT_NAME,
          targets: [
            {
              kind: RepositoryTargetKind.Explicit,
              repo: "owner/repo",
              issueLabels: [],
              issueSort: IssueSort.Created,
              issueOrder: IssueOrder.Ascending,
              agent: "build",
              dryRun: false,
            },
          ],
        },
      ],
      workspace: DEFAULT_WORKSPACE,
      cleanup: false,
      startClean: false,
      verbose: false,
      json: false,
      quiet: false,
    });
  });

  test("applies built-in, top-level, project, repository, then CLI precedence", () => {
    const resolved = resolveRalphieConfig(
      {
        git: { branch: "top" },
        issues: {
          limit: 20,
          sort: { by: IssueSort.Updated, order: IssueOrder.Descending },
          filter: { labels: ["top"] },
        },
        agent: {
          model: { id: { providerID: "openai", modelID: "gpt-5" }, variant: "low" },
          mode: "top-agent",
        },
        projects: [
          {
            name: "project-a",
            git: { branch: "project" },
            issues: {
              limit: 10,
              sort: { order: IssueOrder.Ascending },
              filter: { labels: ["project"] },
            },
            agent: { model: { variant: "high" } },
            repositories: [
              {
                repo: "owner/repo",
                git: { branch: "repository" },
                issues: { limit: 5 },
                agent: { mode: "repository-agent" },
              },
            ],
          },
        ],
      },
      { branch: "cli", maxIssues: 2, issueLabels: ["cli"], agent: "cli-agent" },
    );

    expect(resolved.projects[0]?.targets[0]).toMatchObject({
      repo: "owner/repo",
      branch: "cli",
      maxIssues: 2,
      issueLabels: ["cli"],
      issueSort: IssueSort.Updated,
      issueOrder: IssueOrder.Ascending,
      agent: "cli-agent",
      model: { providerID: "openai", modelID: "gpt-5" },
      modelVariant: "high",
    });
  });

  test("preserves an unresolved repository pattern with inherited settings", () => {
    const resolved = resolveRalphieConfig(
      {
        git: { branch: "main" },
        projects: [
          {
            name: "finance",
            repoPattern: "beremaran/finance-*",
            issues: { limit: 3 },
          },
        ],
      },
      {},
    );
    expect(resolved.projects[0]).toMatchObject({
      name: "finance",
      targets: [
        {
          kind: RepositoryTargetKind.Pattern,
          repoPattern: "beremaran/finance-*",
          branch: "main",
          maxIssues: 3,
        },
      ],
    });
  });

  test("leaves omitted branch settings unset at every config level", () => {
    const resolved = resolveRalphieConfig(
      {
        projects: [
          {
            name: "project",
            repositories: [{ repo: "owner/repo" }],
          },
        ],
      },
      {},
    );

    expect(resolved.projects[0]?.targets[0]).not.toHaveProperty("branch");
  });

  test("rejects ambiguous projects, duplicate identities, and incompatible CLI use", () => {
    expect(() =>
      resolveRalphieConfig(
        {
          projects: [
            { name: "same", repositories: [{ repo: "owner/one" }] },
            { name: "SAME", repositories: [{ repo: "owner/two" }] },
          ],
        },
        {},
      ),
    ).toThrow("project name must be unique");
    expect(() =>
      resolveRalphieConfig(
        {
          projects: [
            { name: "one", repositories: [{ repo: "owner/repo" }] },
            { name: "two", repositories: [{ repo: "OWNER/REPO" }] },
          ],
        },
        {},
      ),
    ).toThrow("repository must be unique");
    expect(() =>
      resolveRalphieConfig(
        { projects: [{ name: "one", repoPattern: "owner/*" }] },
        { repo: "owner/repo" },
      ),
    ).toThrow("positional repository");
  });

  test("loads the published hierarchical example", async () => {
    const config = await Effect.gen(function* () {
      const files = yield* RalphieConfigFile;
      return yield* files.load(join(import.meta.dir, "../../ralphie.example.json"));
    }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
    expect(config.projects?.map(({ name }) => name)).toEqual([
      "proj-a",
      "proj-b",
      "lonely-repo",
    ]);
  });

  test("accepts null optional settings as unset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-null-"));
    const path = join(directory, "ralphie.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          issues: { limit: null, filter: { labels: null } },
          projects: [{ name: "one", repositories: [{ repo: "owner/repo" }] }],
        }),
      );
      const file = await Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(path);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
      const target = resolveRalphieConfig(file, {}).projects[0]?.targets[0];
      expect(target?.maxIssues).toBeUndefined();
      expect(target?.issueLabels).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports malformed JSON, nested schema paths, and missing files", async () => {
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
        JSON.stringify({ projects: [{ name: "one", repositories: [{ repo: 42 }] }] }),
      );
      const invalid = Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(invalidPath);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
      await expect(invalid).rejects.toThrow("projects[0].repositories[0].repo");

      const missingPath = join(directory, "missing.json");
      const missing = Effect.gen(function* () {
        const files = yield* RalphieConfigFile;
        return yield* files.load(missingPath);
      }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
      await expect(missing).rejects.toThrow("Config file not found");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
