import { z } from "zod";

import type { GitHubIssue } from "../../github/domain.ts";
import { HandOffReason, nonBlankStringSchema } from "./decisions.ts";
import { AI_DISCLAIMER, withDisclaimer } from "./hand-off.ts";

/** The heading that marks a comment as the contract an implementer works from. */
export const AGENT_BRIEF_HEADING = "## Agent Brief";

/** The heading of the template posted when an issue waits on its reporter. */
export const TRIAGE_NOTES_HEADING = "## Triage Notes";

/** A comment body without the AI disclaimer Ralphie starts its comments with. */
export const withoutDisclaimer = (body: string): string =>
    body.startsWith(AI_DISCLAIMER)
        ? body.slice(AI_DISCLAIMER.length).trimStart()
        : body;

/** Whether a comment is an Agent Brief, with or without the disclaimer first. */
export const isAgentBrief = (body: string): boolean =>
    withoutDisclaimer(body).startsWith(AGENT_BRIEF_HEADING);

const isTriageNotes = (body: string): boolean =>
    withoutDisclaimer(body).startsWith(TRIAGE_NOTES_HEADING);

/** The triage state labels, keyed by Matt Pocock's canonical role names. */
export type TriageStateLabels = Readonly<{
    "needs-triage": string;
    "needs-info": string;
    "ready-for-agent": string;
    "ready-for-human": string;
    wontfix: string;
}>;

/** Why an open issue is triage work. */
export type TriageBucket = "unlabelled" | "needs-triage" | "needs-info-reply";

const lower = (label: string): string => label.toLowerCase();

/** The canonical state roles an issue currently carries, in documented order. */
const stateRolesOf = (
    issue: GitHubIssue,
    labels: TriageStateLabels,
): ReadonlyArray<keyof TriageStateLabels> => {
    const present = new Set(issue.labels.map(lower));
    return (Object.keys(labels) as Array<keyof TriageStateLabels>).filter(
        (role) => present.has(lower(labels[role])),
    );
};

/**
 * Whether the reporter commented after the last triage notes. Without any
 * notes, every reporter comment counts: the issue waits on them either way.
 */
const reporterRepliedSinceTriageNotes = (issue: GitHubIssue): boolean => {
    if (issue.author === undefined) return false;
    const comments = issue.comments ?? [];
    const lastNotes = comments.findLastIndex((comment) =>
        isTriageNotes(comment.body),
    );
    return comments
        .slice(lastNotes + 1)
        .some((comment) => comment.author === issue.author);
};

/**
 * Which of the three triage buckets, if any, an open issue belongs to:
 * never triaged (no state label), `needs-triage`, or `needs-info` with
 * reporter activity since the last triage notes. An issue with conflicting
 * state labels is left for a human.
 */
export const triageBucket = (
    issue: GitHubIssue,
    labels: TriageStateLabels,
): TriageBucket | undefined => {
    if (issue.state !== "open") return undefined;
    const roles = stateRolesOf(issue, labels);
    if (roles.length === 0) return "unlabelled";
    const [only] = roles;
    if (roles.length > 1) return undefined;
    if (only === "needs-triage") return "needs-triage";
    if (only === "needs-info" && reporterRepliedSinceTriageNotes(issue)) {
        return "needs-info-reply";
    }
    return undefined;
};

/** The reasons a triager may give for waiting on the reporter. */
const NEEDS_INFO_REASONS = [
    HandOffReason.MissingInformation,
    HandOffReason.ConflictingRequirements,
    HandOffReason.CannotReproduce,
    HandOffReason.OutdatedPremise,
] as const;

const evidenceSchema = z.array(nonBlankStringSchema);

/**
 * The structured outcome of an AFK triage session. There is deliberately no
 * rejection outcome: only a human closes a request as `wontfix`.
 */
export const triageDecisionSchema = z.discriminatedUnion("outcome", [
    z.object({
        outcome: z.literal("promote"),
        brief: nonBlankStringSchema
            .refine(
                (value) => value.trimStart().startsWith(AGENT_BRIEF_HEADING),
                {
                    message: `The brief must start with "${AGENT_BRIEF_HEADING}".`,
                },
            )
            .describe(
                `The Agent Brief comment, starting with the heading "${AGENT_BRIEF_HEADING}".`,
            ),
    }),
    z.object({
        outcome: z.literal("needs_info"),
        reason: z.enum(NEEDS_INFO_REASONS),
        summary: nonBlankStringSchema.describe(
            "What has been established so far.",
        ),
        evidence: evidenceSchema,
        questions: z
            .array(nonBlankStringSchema)
            .min(1)
            .describe("Specific, actionable questions for the reporter."),
    }),
    z.object({
        outcome: z.literal("ready_for_human"),
        summary: nonBlankStringSchema.describe(
            "Why a human has to take this on.",
        ),
        evidence: evidenceSchema,
        questions: z
            .array(nonBlankStringSchema)
            .min(1)
            .describe("What a human needs to decide or do."),
    }),
    z.object({
        outcome: z.literal("already_implemented"),
        summary: nonBlankStringSchema.describe(
            "Where the requested behavior already lives.",
        ),
        evidence: z.array(nonBlankStringSchema).min(1),
    }),
]);

export type TriageDecision = z.infer<typeof triageDecisionSchema>;

/** What the workflow does with one triaged issue. */
export type TriageResult =
    | {
          readonly kind: "promote";
          /** The Agent Brief comment text, starting with the heading. */
          readonly brief: string;
      }
    | {
          readonly kind: "hand-off";
          readonly reason: HandOffReason;
          readonly summary: string;
          readonly evidence: ReadonlyArray<string>;
          readonly questions: ReadonlyArray<string>;
      }
    | {
          /** Only produced after a fresh resolution verifier proved it. */
          readonly kind: "already-implemented";
          readonly summary: string;
          readonly evidence: ReadonlyArray<string>;
      };

/** The Agent Brief as posted: the AI disclaimer, then the brief itself. */
export const renderAgentBriefComment = (brief: string): string =>
    withDisclaimer(brief.trim());

/** The comment that points to where an already-implemented request lives. */
export const renderAlreadyImplementedComment = (content: {
    readonly summary: string;
    readonly evidence: ReadonlyArray<string>;
}): string =>
    withDisclaimer(
        [
            "This is already implemented, so I'm closing it as completed.",
            "",
            content.summary,
            "",
            "**Where it lives:**",
            "",
            ...content.evidence.map((item) => `- ${item}`),
        ].join("\n"),
    );