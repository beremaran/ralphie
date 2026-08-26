import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKFLOW_MODE,
  resolveRalphieConfig,
  WorkflowMode,
} from "../src/options.ts";

describe("CLI configuration", () => {
  test("requires a positional repository", () => {
    expect(() => resolveRalphieConfig({})).toThrow(
      "Missing repository: provide an owner/repository argument.",
    );
  });

  test("resolves defaults from CLI arguments only", () => {
    expect(
      resolveRalphieConfig({
        repo: "owner/repo",
      }),
    ).toEqual({
      repo: "owner/repo",
      workflow: DEFAULT_WORKFLOW_MODE,
      issueConcurrency: 1,
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

  test("normalizes clone URLs and applies every override", () => {
    expect(
      resolveRalphieConfig({
        repo: "https://github.com/Owner/Repo.git",
        workflow: WorkflowMode.ParallelPr,
        branch: "develop",
        issueConcurrency: 4,
        agentConcurrency: 2,
        maxIssues: 3,
        issueLabels: ["bug", "ready"],
        issueSort: IssueSort.Updated,
        issueOrder: IssueOrder.Descending,
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        modelVariant: "high",
        agent: "custom",
        workspace: "/tmp/ralphie",
        cleanup: true,
        startClean: true,
        dryRun: true,
        resume: "/tmp/state.json",
        verbose: true,
        json: true,
      }),
    ).toMatchObject({
      repo: "Owner/Repo",
      workflow: WorkflowMode.ParallelPr,
      branch: "develop",
      issueConcurrency: 4,
      agentConcurrency: 2,
      maxIssues: 3,
      issueLabels: ["bug", "ready"],
      issueSort: IssueSort.Updated,
      issueOrder: IssueOrder.Descending,
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      modelVariant: "high",
      agent: "custom",
      workspace: "/tmp/ralphie",
      cleanup: true,
      startClean: true,
      dryRun: true,
      resume: "/tmp/state.json",
      verbose: true,
      json: true,
      quiet: false,
    });
  });

  test("rejects incompatible output modes", () => {
    expect(() =>
      resolveRalphieConfig({
        repo: "owner/repo",
        json: true,
        quiet: true,
      }),
    ).toThrow("JSON and quiet output modes cannot be enabled together.");
  });
});