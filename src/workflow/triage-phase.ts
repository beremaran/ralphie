import type { GitHubIssue, IssueFilters } from "../github/domain.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssuesService,
    GitHubTriageService,
} from "../github/ports.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
    type IssueExecutionOutcome,
} from "../issues/app/execution-model.ts";
import type { TriageService } from "../issues/app/triage.ts";
import {
    renderAgentBriefComment,
    renderAlreadyImplementedComment,
    triageBucket,
    type TriageBucket,
    type TriageResult,
    type TriageStateLabels,
} from "../issues/domain/triage.ts";
import type { ProgressReporterService } from "../progress/ports.ts";
import { RalphieError } from "../shared/error.ts";

type HandOffOutcome = Extract<
    IssueExecutionOutcome,
    { readonly kind: IssueExecutionOutcomeKind.HandOff }
>;

/** What the triage phase needs from the workflow around it. */
export type TriagePhaseDependencies = {
    readonly repo: string;
    readonly labels: TriageStateLabels;
    /** Triage only issues carrying every one of these labels. */
    readonly requireLabels: ReadonlyArray<string>;
    /** Supplies the sort order of the issue listing. */
    readonly issueFilters: IssueFilters;
    readonly signal?: AbortSignal;
    readonly progress: ProgressReporterService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubTriage: GitHubTriageService;
    readonly triage: TriageService;
    /** The context a read-only session for this issue runs in. */
    readonly contextFor: (issue: GitHubIssue) => IssueExecutionContext;
    /** Announce a hand-off and post its comment and label. */
    readonly handOff: (
        issue: GitHubIssue,
        outcome: HandOffOutcome,
    ) => Promise<void>;
    readonly record: (
        issueNumber: number,
        outcome: IssueExecutionOutcome,
    ) => void;
    /** Save run state after each issue. */
    readonly persist: () => Promise<void>;
};

export type TriagePhaseResult = {
    /** Issues that received an Agent Brief and now belong in the queue. */
    readonly promoted: ReadonlyArray<number>;
};

type Candidate = {
    readonly issue: GitHubIssue;
    readonly bucket: TriageBucket;
};

const candidatesIn = (
    issues: ReadonlyArray<GitHubIssue>,
    dependencies: TriagePhaseDependencies,
): ReadonlyArray<Candidate> => {
    const required = dependencies.requireLabels.map((label) =>
        label.toLowerCase(),
    );
    return issues.flatMap((issue) => {
        const present = new Set(
            issue.labels.map((label) => label.toLowerCase()),
        );
        if (!required.every((label) => present.has(label))) return [];
        const bucket = triageBucket(issue, dependencies.labels);
        return bucket === undefined ? [] : [{ issue, bucket }];
    });
};

const handOffOutcome = (
    result: Extract<TriageResult, { readonly kind: "hand-off" }>,
): HandOffOutcome => ({
    kind: IssueExecutionOutcomeKind.HandOff,
    reason: result.reason,
    summary: result.summary,
    evidence: result.evidence,
    questions: result.questions,
    route: "hand-off",
});

const closeAlreadyImplemented = async (
    dependencies: TriagePhaseDependencies,
    issue: GitHubIssue,
    result: Extract<TriageResult, { readonly kind: "already-implemented" }>,
): Promise<void> => {
    const { repo, githubTriage, githubIssueMutations, progress } = dependencies;
    await githubTriage.explainImplemented(
        repo,
        issue.number,
        renderAlreadyImplementedComment(result),
    );
    await githubIssueMutations.close(repo, issue.number, "completed");
    await progress.emit({
        issue: { number: issue.number, title: issue.title },
        stage: "issue-closure",
        status: "succeeded",
        message: `Issue #${issue.number} is already implemented; closed as completed.`,
    });
    dependencies.record(issue.number, {
        kind: IssueExecutionOutcomeKind.Completed,
        completion: "already-resolved",
        resolutionSummary: result.summary,
        evidence: result.evidence,
    });
};

const promote = async (
    dependencies: TriagePhaseDependencies,
    issue: GitHubIssue,
    result: Extract<TriageResult, { readonly kind: "promote" }>,
): Promise<void> => {
    const { repo, labels, githubTriage, progress } = dependencies;
    await githubTriage.promote(repo, issue.number, {
        body: renderAgentBriefComment(result.brief),
        label: labels["ready-for-agent"],
        replaceLabels: Object.values(labels),
    });
    await progress.emit({
        issue: { number: issue.number, title: issue.title },
        stage: "triage",
        status: "info",
        message: `Issue #${issue.number} promoted to ${labels["ready-for-agent"]} with an Agent Brief.`,
    });
};

/** Apply one triage result; returns whether the issue joins the queue. */
const apply = async (
    dependencies: TriagePhaseDependencies,
    issue: GitHubIssue,
    result: TriageResult,
): Promise<boolean> => {
    switch (result.kind) {
        case "promote":
            await promote(dependencies, issue, result);
            return true;
        case "hand-off": {
            const outcome = handOffOutcome(result);
            await dependencies.handOff(issue, outcome);
            dependencies.record(issue.number, outcome);
            return false;
        }
        case "already-implemented":
            await closeAlreadyImplemented(dependencies, issue, result);
            return false;
    }
};

const triageOne = async (
    dependencies: TriagePhaseDependencies,
    { issue, bucket }: Candidate,
): Promise<boolean> => {
    try {
        const result = await dependencies.triage.triage({
            context: dependencies.contextFor(issue),
            bucket,
            labels: dependencies.labels,
        });
        return await apply(dependencies, issue, result);
    } catch (error) {
        if (dependencies.signal?.aborted === true) throw error;
        if (!(error instanceof RalphieError)) throw error;
        dependencies.record(issue.number, {
            kind: IssueExecutionOutcomeKind.Failed,
            message: `Triage failed: ${error.message}`,
        });
        return false;
    } finally {
        await dependencies.persist();
    }
};

/**
 * Triage the issues that are not agent-ready yet: never triaged,
 * `needs-triage`, and `needs-info` with a reporter reply since the last notes.
 * Promoted issues are reported so the caller can queue them for
 * implementation in the same run.
 */
export const runTriagePhase = async (
    dependencies: TriagePhaseDependencies,
): Promise<TriagePhaseResult> => {
    const { repo, progress, githubIssues, requireLabels, issueFilters } =
        dependencies;
    await progress.emit({
        stage: "triage",
        status: "started",
        message: "Looking for issues that need triage...",
    });
    const listed = await githubIssues.listOpen(repo, {
        ...issueFilters,
        labels: requireLabels,
    });
    const candidates = candidatesIn(listed, dependencies);
    await progress.emit({
        stage: "triage",
        status: "info",
        message:
            candidates.length === 0
                ? "No issues need triage."
                : `Triaging ${candidates.length} ${candidates.length === 1 ? "issue" : "issues"}.`,
    });
    const promoted: number[] = [];
    for (const candidate of candidates) {
        dependencies.signal?.throwIfAborted();
        if (await triageOne(dependencies, candidate)) {
            promoted.push(candidate.issue.number);
        }
    }
    return { promoted };
};