import { z } from "zod";

export const complexityDecisionSchema = z.object({
  complexity: z
    .number()
    .int()
    .min(0)
    .max(5)
    .describe("Issue complexity from 0 (trivial) to 5 (very complex)."),
  rationale: z
    .string()
    .min(1)
    .describe("A concise explanation of the assigned complexity."),
});

export type ComplexityDecision = z.infer<typeof complexityDecisionSchema>;

export const reviewDecisionSchema = z
  .object({
    verdict: z.enum(["approved", "changes_requested"]),
    summary: z.string().min(1),
    findings: z.array(
      z.object({
        severity: z.enum(["blocking", "non_blocking"]),
        description: z.string().min(1),
        file: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
      }),
    ),
  })
  .superRefine((decision, context) => {
    const hasBlockingFinding = decision.findings.some(
      (finding) => finding.severity === "blocking",
    );
    if (decision.verdict === "approved" && hasBlockingFinding) {
      context.addIssue({
        code: "custom",
        message: "An approved review cannot contain blocking findings.",
        path: ["findings"],
      });
    }
    if (decision.verdict === "changes_requested" && !hasBlockingFinding) {
      context.addIssue({
        code: "custom",
        message: "A changes-requested review needs a blocking finding.",
        path: ["findings"],
      });
    }
  });

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const commitMessageDecisionSchema = z.object({
  subject: z.string().min(1).max(72),
  body: z.string().min(1).optional(),
});

export type CommitMessageDecision = z.infer<
  typeof commitMessageDecisionSchema
>;

export const issueBreakdownDecisionSchema = z
  .object({
    rationale: z.string().min(1),
    issues: z
      .array(
        z.object({
          key: z
            .string()
            .min(1)
            .describe("A stable identifier used by dependency references."),
          title: z.string().min(1),
          body: z.string().min(1),
          estimatedComplexity: z.number().int().min(0).max(3),
          dependsOn: z.array(z.string().min(1)),
        }),
      )
      .min(2),
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

export type IssueBreakdownDecision = z.infer<
  typeof issueBreakdownDecisionSchema
>;
