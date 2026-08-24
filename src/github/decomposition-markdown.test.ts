import { describe, expect, test } from "bun:test";

import {
  ImplementationComplexityLevel,
  type IssueBreakdownDecision,
} from "../issues/decisions.ts";
import type { GitHubIssue } from "./issues.ts";
import {
  MAX_DECOMPOSITION_DEPTH,
  RALPHIE_DECOMPOSITION_MARKER,
  nextDecompositionLineage,
  renderChildIssueBody,
  renderDecomposedOriginalBody,
} from "./decomposition-markdown.ts";

const original: GitHubIssue = {
  number: 10,
  title: "Large migration",
  url: "https://github.com/owner/repo/issues/10",
  body: "Keep this original context.",
  labels: [],
};

const breakdown: IssueBreakdownDecision = {
  rationale: "Split storage from API work.",
  issues: [
    {
      key: "storage",
      title: "Migrate storage",
      body: "Implement storage migration.",
      estimatedComplexity: ImplementationComplexityLevel.Level3,
      dependsOn: [],
    },
    {
      key: "api",
      title: "Migrate API",
      body: "Implement API migration.",
      estimatedComplexity: ImplementationComplexityLevel.Level2,
      dependsOn: ["storage"],
    },
  ],
};

const lineage = { rootIssueNumber: 10, parentIssueNumber: 10, depth: 1 };
const issueNumbers = { storage: 11, api: 12 };

describe("decomposition Markdown", () => {
  test("links child issues to their parent, siblings, dependencies, and lineage", () => {
    const body = renderChildIssueBody({
      child: breakdown.issues[1]!,
      lineage,
      issueNumbers,
    });

    expect(body).toContain(RALPHIE_DECOMPOSITION_MARKER);
    expect(body).toContain("root=10 parent=10");
    expect(body).toContain("- Parent: #10");
    expect(body).toContain("- #11 (storage)");
    expect(body).toContain("- #12 (api)");
    expect(body).toContain("## Dependencies\n\n- #11 (storage)");
  });

  test("rewrites the original while preserving its content and complete stack", () => {
    const body = renderDecomposedOriginalBody({
      original,
      breakdown,
      issueNumbers,
      lineage,
    });

    expect(body).toContain("- #11 — Migrate storage");
    expect(body).toContain("- #12 — Migrate API (depends on #11)");
    expect(body).toContain("Keep this original context.");
    expect(body).toContain("Split storage from API work.");
  });

  test("rejects decomposition beyond the maximum depth", () => {
    expect(() =>
      renderChildIssueBody({
        child: breakdown.issues[0]!,
        lineage: { ...lineage, depth: MAX_DECOMPOSITION_DEPTH + 1 },
        issueNumbers,
      }),
    ).toThrow();
  });

  test("increments lineage when a generated child requires decomposition", () => {
    const generated = {
      ...original,
      number: 12,
      body: renderChildIssueBody({
        child: breakdown.issues[1]!,
        lineage,
        issueNumbers,
      }),
    };

    expect(nextDecompositionLineage(generated)).toEqual({
      rootIssueNumber: 10,
      parentIssueNumber: 12,
      depth: 2,
    });
  });
});
