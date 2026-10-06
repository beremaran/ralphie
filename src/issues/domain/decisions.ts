import { z } from "zod";

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

export enum HandOffReason {
    OutdatedPremise = "outdated_premise",
    ConflictingRequirements = "conflicting_requirements",
    MissingInformation = "missing_information",
    ExternalDependency = "external_dependency",
    CannotReproduce = "cannot_reproduce",
    DecompositionLimitReached = "decomposition_limit_reached",
    ImplementationExhausted = "implementation_exhausted",
}

export enum GroundingDisposition {
    Actionable = "actionable",
    AlreadyResolved = "already_resolved",
    Blocked = "blocked",
    HandOff = "hand_off",
}

export const reviewDecisionSchema = z
    .object({
        verdict: z.enum(ReviewVerdict),
        summary: z.string().min(1),
        findings: z.array(
            z.object({
                severity: z.enum(ReviewFindingSeverity),
                description: z.string().min(1),
                file: z.string().min(1).optional(),
                line: z.number().int().positive().optional(),
            }),
        ),
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
        if (
            decision.verdict === ReviewVerdict.ChangesRequested &&
            !hasBlockingFinding
        ) {
            context.addIssue({
                code: "custom",
                message: "A changes-requested review needs a blocking finding.",
                path: ["findings"],
            });
        }
    });

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const nonBlankStringSchema = z
    .string()
    .refine((value) => value.trim().length > 0, {
        message: "Expected a non-blank string.",
    });

export const issueResolutionDecisionSchema = z.object({
    status: z.enum(IssueResolutionStatus),
    summary: nonBlankStringSchema,
    evidence: z.array(nonBlankStringSchema).min(1),
});

/** Shared contract for every fresh, read-only resolution verification. */
export const resolutionVerificationDecisionSchema =
    issueResolutionDecisionSchema;

export type IssueResolutionDecision = z.infer<
    typeof issueResolutionDecisionSchema
>;
export type ResolutionVerificationDecision = IssueResolutionDecision;

const groundingActionableDecisionSchema = z.object({
    disposition: z.literal(GroundingDisposition.Actionable),
});

const groundingAlreadyResolvedDecisionSchema = z.object({
    disposition: z.literal(GroundingDisposition.AlreadyResolved),
});

export const handOffDecisionSchema = z
    .object({
        disposition: z.literal(GroundingDisposition.HandOff),
        reason: z.enum(HandOffReason),
        summary: nonBlankStringSchema,
        evidence: z.array(nonBlankStringSchema).min(1),
        questions: z.array(nonBlankStringSchema).min(1),
    })
    .strict();

export const groundingDecisionSchema = z.discriminatedUnion("disposition", [
    groundingActionableDecisionSchema,
    groundingAlreadyResolvedDecisionSchema,
    handOffDecisionSchema,
]);

const preflightActionableDecisionSchema = z.object({
    disposition: z.literal(GroundingDisposition.Actionable),
    fitsOneSession: z
        .boolean()
        .describe(
            "True when one implementation session can finish the whole issue; false when it must be decomposed into child issues.",
        ),
});

const preflightBlockedDecisionSchema = z.object({
    disposition: z.literal(GroundingDisposition.Blocked),
    blockedBy: z
        .array(z.number().int().positive())
        .min(1)
        .describe("Numbers of the open issues that must be finished first."),
});

/** The single read-only pre-flight session's disposition for one issue. */
export const preflightDecisionSchema = z.discriminatedUnion("disposition", [
    preflightActionableDecisionSchema,
    groundingAlreadyResolvedDecisionSchema,
    preflightBlockedDecisionSchema,
    handOffDecisionSchema,
]);

export type PreflightDecision = z.infer<typeof preflightDecisionSchema>;

/** What is retained about an actionable pre-flight for restarts. */
export const sessionFitDecisionSchema = z.object({
    fitsOneSession: z.boolean(),
});

export type SessionFitDecision = z.infer<typeof sessionFitDecisionSchema>;

export type GroundingDecision = z.infer<typeof groundingDecisionSchema>;
export type HandOffDecision = Omit<
    z.infer<typeof handOffDecisionSchema>,
    "evidence" | "questions"
> & {
    readonly evidence: ReadonlyArray<string>;
    readonly questions: ReadonlyArray<string>;
};

export const commitMessageDecisionSchema = z.object({
    subject: z.string().min(1).max(72),
    body: z.string().min(1).optional(),
});

export type CommitMessageDecision = z.infer<typeof commitMessageDecisionSchema>;

export const issueBreakdownDecisionSchema = z
    .object({
        rationale: z.string().min(1),
        issues: z
            .array(
                z.object({
                    key: z
                        .string()
                        .min(1)
                        .describe(
                            "A stable identifier used by dependency references.",
                        ),
                    title: z.string().min(1).max(256),
                    whatToBuild: z
                        .string()
                        .min(1)
                        .describe(
                            "The end-to-end behaviour this ticket delivers, without file paths or code snippets.",
                        ),
                    acceptanceCriteria: z
                        .array(z.string().min(1))
                        .min(1)
                        .describe("One verifiable criterion per entry."),
                    dependsOn: z
                        .array(z.string().min(1))
                        .describe("Keys of the tickets that block this one."),
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
                        path: [
                            "issues",
                            issueIndex,
                            "dependsOn",
                            dependencyIndex,
                        ],
                    });
                } else if (dependency === issue.key) {
                    context.addIssue({
                        code: "custom",
                        message: "An issue cannot depend on itself.",
                        path: [
                            "issues",
                            issueIndex,
                            "dependsOn",
                            dependencyIndex,
                        ],
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
                message:
                    "Breakdown issue dependencies must not contain cycles.",
                path: ["issues"],
            });
        }
    });

export type IssueBreakdownDecision = z.infer<
    typeof issueBreakdownDecisionSchema
>;