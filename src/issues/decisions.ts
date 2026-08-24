import { z } from "zod";

export enum ComplexityLevel {
  Level0 = 0,
  Level1 = 1,
  Level2 = 2,
  Level3 = 3,
  Level4 = 4,
  Level5 = 5,
}

export enum ImplementationComplexityLevel {
  Level0 = ComplexityLevel.Level0,
  Level1 = ComplexityLevel.Level1,
  Level2 = ComplexityLevel.Level2,
  Level3 = ComplexityLevel.Level3,
}

export enum ReviewVerdict {
  Approved = "approved",
  ChangesRequested = "changes_requested",
}

export enum ReviewFindingSeverity {
  Blocking = "blocking",
  NonBlocking = "non_blocking",
}

export enum IssueResolutionStatus {
  Resolved = "resolved",
  Unresolved = "unresolved",
}

export const AGENT_TEXT_LIMIT = 8_000;
export const AGENT_ISSUE_BODY_LIMIT = 12_000;
export const AGENT_BREAKDOWN_ISSUE_LIMIT = 50;
export const AGENT_REVIEW_FINDING_LIMIT = 100;

export const complexityDecisionSchema = z.object({
  complexity: z
    .enum(ComplexityLevel)
    .describe("Issue complexity from 0 (trivial) to 5 (very complex)."),
  rationale: z
    .string()
    .min(1)
    .max(AGENT_TEXT_LIMIT)
    .describe("A concise explanation of the assigned complexity."),
});

export type ComplexityDecision = z.infer<typeof complexityDecisionSchema>;

export const reviewDecisionSchema = z
  .object({
    verdict: z.enum(ReviewVerdict),
    summary: z.string().min(1).max(AGENT_TEXT_LIMIT),
    findings: z
      .array(
        z.object({
          severity: z.enum(ReviewFindingSeverity),
          description: z.string().min(1).max(AGENT_TEXT_LIMIT),
          file: z.string().min(1).optional(),
          line: z.number().int().positive().optional(),
        }),
      )
      .max(AGENT_REVIEW_FINDING_LIMIT),
  })
  .superRefine((decision, context) => {
    const hasBlockingFinding = decision.findings.some(
      (finding) => finding.severity === ReviewFindingSeverity.Blocking,
    );
    if (decision.verdict === ReviewVerdict.Approved && hasBlockingFinding) {
      context.addIssue({
        code: "custom",
        message: "An approved review cannot contain blocking findings.",
        path: ["findings"],
      });
    }
    if (decision.verdict === ReviewVerdict.ChangesRequested && !hasBlockingFinding) {
      context.addIssue({
        code: "custom",
        message: "A changes-requested review needs a blocking finding.",
        path: ["findings"],
      });
    }
  });

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const issueResolutionDecisionSchema = z.object({
  status: z.enum(IssueResolutionStatus),
  summary: z.string().min(1).max(AGENT_TEXT_LIMIT),
  evidence: z
    .array(z.string().min(1).max(AGENT_TEXT_LIMIT))
    .min(1)
    .max(AGENT_REVIEW_FINDING_LIMIT),
});

export type IssueResolutionDecision = z.infer<typeof issueResolutionDecisionSchema>;

export const commitMessageDecisionSchema = z.object({
  subject: z.string().min(1).max(72),
  body: z.string().min(1).max(AGENT_TEXT_LIMIT).optional(),
});

export type CommitMessageDecision = z.infer<typeof commitMessageDecisionSchema>;

export const issueBreakdownDecisionSchema = z
  .object({
    rationale: z.string().min(1).max(AGENT_TEXT_LIMIT),
    issues: z
      .array(
        z.object({
          key: z
            .string()
            .min(1)
            .describe("A stable identifier used by dependency references."),
          title: z.string().min(1).max(256),
          body: z.string().min(1).max(AGENT_ISSUE_BODY_LIMIT),
          estimatedComplexity: z.enum(ImplementationComplexityLevel),
          dependsOn: z.array(z.string().min(1)).max(AGENT_BREAKDOWN_ISSUE_LIMIT),
        }),
      )
      .min(2)
      .max(AGENT_BREAKDOWN_ISSUE_LIMIT),
  })
  .superRefine((breakdown, context) => {
    const keys = new Set(breakdown.issues.map((issue) => issue.key));
    if (keys.size !== breakdown.issues.length) {
      context.addIssue({
        code: "custom",
        message: "Breakdown issue keys must be unique.",
        path: ["issues"],
      });
    }

    breakdown.issues.forEach((issue, issueIndex) => {
      issue.dependsOn.forEach((dependency, dependencyIndex) => {
        if (!keys.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Unknown dependency key: ${dependency}.`,
            path: ["issues", issueIndex, "dependsOn", dependencyIndex],
          });
        } else if (dependency === issue.key) {
          context.addIssue({
            code: "custom",
            message: "An issue cannot depend on itself.",
            path: ["issues", issueIndex, "dependsOn", dependencyIndex],
          });
        }
      });
    });

    const dependenciesByKey = new Map(
      breakdown.issues.map((issue) => [issue.key, issue.dependsOn]),
    );
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;

      visiting.add(key);
      const cyclic = (dependenciesByKey.get(key) ?? []).some(
        (dependency) => keys.has(dependency) && hasCycle(dependency),
      );
      visiting.delete(key);
      visited.add(key);
      return cyclic;
    };

    if (breakdown.issues.some((issue) => hasCycle(issue.key))) {
      context.addIssue({
        code: "custom",
        message: "Breakdown issue dependencies must not contain cycles.",
        path: ["issues"],
      });
    }
  });

export type IssueBreakdownDecision = z.infer<typeof issueBreakdownDecisionSchema>;
