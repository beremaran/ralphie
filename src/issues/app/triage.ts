import { buildTriagePrompt } from "../../agent/prompts.ts";
import { haltingFailure } from "../../agent/sessions.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import { skillInvocation } from "../../harness/app/skill-injection.ts";
import type { ProgressReporterService } from "../../progress/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import { HandOffReason, IssueResolutionStatus } from "../domain/decisions.ts";
import {
    triageDecisionSchema,
    type TriageBucket,
    type TriageDecision,
    type TriageResult,
    type TriageStateLabels,
} from "../domain/triage.ts";
import type { IssueExecutionContext } from "./execution.ts";
import type { ResolutionVerificationService } from "./resolution-verification.ts";

export type TriageRequest = {
    readonly context: IssueExecutionContext;
    /** Why the issue is triage work. */
    readonly bucket: TriageBucket;
    readonly labels: TriageStateLabels;
};

export type TriageService = {
    /**
     * Run the read-only triager over one issue and decide what Ralphie does
     * with it. Never mutates the checkout or GitHub.
     */
    readonly triage: (request: TriageRequest) => Promise<TriageResult>;
};

type TriageDependencies = {
    readonly progress: ProgressReporterService;
    readonly resolutionVerification: ResolutionVerificationService;
};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const toResult = (
    decision: Exclude<TriageDecision, { outcome: "already_implemented" }>,
): TriageResult => {
    switch (decision.outcome) {
        case "promote":
            return { kind: "promote", brief: decision.brief.trim() };
        case "needs_info":
            return {
                kind: "hand-off",
                reason: decision.reason,
                summary: decision.summary,
                evidence: decision.evidence,
                questions: decision.questions,
            };
        case "ready_for_human":
            return {
                kind: "hand-off",
                reason: HandOffReason.NeedsHumanJudgment,
                summary: decision.summary,
                evidence: decision.evidence,
                questions: decision.questions,
            };
    }
};

/** The triager's claim did not survive the fresh verifier; a human decides. */
const unverifiedClaim = (
    claimed: Extract<TriageDecision, { outcome: "already_implemented" }>,
    why: string,
): TriageResult => ({
    kind: "hand-off",
    reason: HandOffReason.NeedsHumanJudgment,
    summary: `Triage believed this is already implemented, but ${why}`,
    evidence: [claimed.summary, ...claimed.evidence],
    questions: [
        "Confirm whether the requested behavior already exists, then close the issue or describe what is still missing.",
    ],
});

export const makeTriageService = ({
    progress,
    resolutionVerification,
}: TriageDependencies): TriageService => {
    const verifyClaim = async (
        context: IssueExecutionContext,
        claimed: Extract<TriageDecision, { outcome: "already_implemented" }>,
    ): Promise<TriageResult> => {
        try {
            const { decision, handOff } =
                await resolutionVerification.verify(context);
            if (
                handOff === undefined &&
                decision.status === IssueResolutionStatus.Resolved
            ) {
                return {
                    kind: "already-implemented",
                    summary: decision.summary,
                    evidence: decision.evidence,
                };
            }
            return unverifiedClaim(
                claimed,
                "a fresh verification did not prove it.",
            );
        } catch (error) {
            if (
                context.signal?.aborted === true ||
                haltingFailure(error) !== undefined
            ) {
                throw error;
            }
            return unverifiedClaim(
                claimed,
                `the fresh verification failed: ${messageOf(error)}`,
            );
        }
    };

    return {
        triage: async ({ context, bucket, labels }) => {
            const issue = {
                number: context.issue.number,
                title: context.issue.title,
            };
            await progress.emit({
                issue,
                stage: "triage",
                status: "started",
                message: `Triaging #${context.issue.number}...`,
                details: { bucket },
            });
            try {
                const checkpoint = await context.repositoryInvariant.capture(
                    context.repositoryPath,
                    context.signal,
                );
                if (checkpoint.branch !== context.targetBranch) {
                    throw new RalphieError({
                        message: `Triage requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                    });
                }
                const result = await requestStructuredOutput(context.agent, {
                    directory: context.repositoryPath,
                    title: `Triage issue #${context.issue.number}`,
                    prompt: buildTriagePrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        headSha: checkpoint.head,
                        triageInvocation: skillInvocation(
                            context.agent.roles.triager.harness,
                            "triage",
                        ),
                        bucket,
                        labels,
                    }),
                    schema: triageDecisionSchema,
                    role: "triager",
                    repositoryInvariant: checkpoint,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "triage",
                    progressIssue: issue,
                    signal: context.signal,
                });
                const decision = result.output;
                const triaged =
                    decision.outcome === "already_implemented"
                        ? await verifyClaim(context, decision)
                        : toResult(decision);
                await progress.emit({
                    issue,
                    stage: "triage",
                    status: "succeeded",
                    message: `Triage of #${context.issue.number}: ${decision.outcome.replaceAll("_", " ")}.`,
                    details: {
                        outcome: decision.outcome,
                        sessionID: result.sessionID,
                    },
                });
                return triaged;
            } catch (error) {
                await progress.emit({
                    issue,
                    stage: "triage",
                    status: "failed",
                    message: `Triage failed: ${messageOf(error)}`,
                });
                throw error;
            }
        },
    };
};