import type { GitHubIssue } from "./issues.ts";
import type { IssueBreakdownDecision } from "../issues/decisions.ts";
import { RalphieError } from "../shared/error.ts";

export const MAX_DECOMPOSITION_DEPTH = 3;
export const RALPHIE_DECOMPOSITION_MARKER = "ralphie:decomposition";

export type DecompositionLineage = {
  readonly rootIssueNumber: number;
  readonly parentIssueNumber: number;
  readonly depth: number;
};

const validateDepth = (depth: number): void => {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DECOMPOSITION_DEPTH) {
    throw new RalphieError({
      message: `Decomposition depth ${depth} is outside the supported range 1–${MAX_DECOMPOSITION_DEPTH}.`,
    });
  }
};

const issueLink = (number: number): string => `#${number}`;

export const decompositionMarker = (
  lineage: DecompositionLineage,
  key: string,
): string => {
  validateDepth(lineage.depth);
  return `<!-- ${RALPHIE_DECOMPOSITION_MARKER} root=${lineage.rootIssueNumber} parent=${lineage.parentIssueNumber} key=${JSON.stringify(key)} depth=${lineage.depth} -->`;
};

export const renderChildIssueBody = (input: {
  readonly child: IssueBreakdownDecision["issues"][number];
  readonly lineage: DecompositionLineage;
  readonly issueNumbers: Readonly<Record<string, number>>;
}): string => {
  const { child, lineage, issueNumbers } = input;
  const siblingEntries = Object.entries(issueNumbers);
  const dependencies = child.dependsOn.map((key) => {
    const number = issueNumbers[key];
    if (number === undefined) {
      throw new RalphieError({
        message: `Cannot render dependency ${key}; its GitHub issue number is unknown.`,
      });
    }
    return `- ${issueLink(number)} (${key})`;
  });

  return `${decompositionMarker(lineage, child.key)}

${child.body}

## Decomposition lineage

- Root: ${issueLink(lineage.rootIssueNumber)}
- Parent: ${issueLink(lineage.parentIssueNumber)}
- Depth: ${lineage.depth}/${MAX_DECOMPOSITION_DEPTH}

## Related child issues

${siblingEntries.map(([key, number]) => `- ${issueLink(number)} (${key})`).join("\n")}

## Dependencies

${dependencies.length === 0 ? "- None" : dependencies.join("\n")}`;
};

export const renderDecomposedOriginalBody = (input: {
  readonly original: GitHubIssue;
  readonly breakdown: IssueBreakdownDecision;
  readonly issueNumbers: Readonly<Record<string, number>>;
  readonly lineage: DecompositionLineage;
}): string => {
  validateDepth(input.lineage.depth);
  const stack = input.breakdown.issues.map((child) => {
    const number = input.issueNumbers[child.key];
    if (number === undefined) {
      throw new RalphieError({
        message: `Cannot rewrite the original issue; child ${child.key} has no GitHub issue number.`,
      });
    }
    const dependencies = child.dependsOn
      .map((key) => input.issueNumbers[key])
      .filter((value): value is number => value !== undefined)
      .map(issueLink);
    return `- ${issueLink(number)} — ${child.title}${
      dependencies.length === 0 ? "" : ` (depends on ${dependencies.join(", ")})`
    }`;
  });

  return `<!-- ${RALPHIE_DECOMPOSITION_MARKER} original=${input.original.number} depth=${input.lineage.depth} -->

This issue was decomposed into the following independently actionable issue stack:

${stack.join("\n")}

## Decomposition rationale

${input.breakdown.rationale}

## Original issue content

${input.original.body ?? ""}`;
};
