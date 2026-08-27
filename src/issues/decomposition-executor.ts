import {
    decompositionMarker,
    nextDecompositionLineage,
    renderChildIssueBody,
    renderDecomposedOriginalBody,
    type DecompositionLineage,
} from "../github/decomposition-markdown.ts";
import {
    GitHubMutationRecoveryError,
    GitHubMutationRecoveryOutcome,
    type GitHubIssueCloseReason,
    type GitHubIssueMutationService,
} from "../github/issue-mutations.ts";
import type { GitHubIssuesService } from "../github/issues.ts";
import { buildDecompositionPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import {
    type ProgressStage,
    type ProgressStatus,
} from "../progress/progress.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    IssueArtifactKind,
    type CreatedIssueNumberMapping,
} from "./artifacts.ts";
import {
    issueBreakdownDecisionSchema,
    type IssueBreakdownDecision,
} from "./decisions.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type { ReviewAttempt } from "./recovery.ts";
import type {
    WorkflowExecutorInput,
    WorkflowExecutorResult,
} from "./workflow-executor-input.ts";

export type DecompositionExecutorService = {
    readonly execute: (
        input: WorkflowExecutorInput,
    ) => Promise<WorkflowExecutorResult>;
};

const existingMapping = async (
    input: WorkflowExecutorInput,
): Promise<CreatedIssueNumberMapping> =>
    input.artifacts.has(IssueArtifactKind.CreatedIssueNumbers)
        ? await input.artifacts.read(IssueArtifactKind.CreatedIssueNumbers)
        : {};

const issueContext = (input: WorkflowExecutorInput) => ({
    issue: {
        number: input.context.issue.number,
        title: input.context.issue.title,
    },
});

export const makeDecompositionExecutorService = (
    mutations: GitHubIssueMutationService,
    issues: GitHubIssuesService,
    progress: ProgressReporterService,
): DecompositionExecutorService => {
    const recoverableMutation = async <Output>(
        operation: string,
        action: () => Promise<Output>,
        input: WorkflowExecutorInput,
    ): Promise<Output> => {
        const context = issueContext(input);
        const stage =
            operation === "close-original" ? "issue-closure" : "issue-creation";
        await progress.emit({
            ...context,
            stage,
            status: "started",
            message: `Applying GitHub mutation ${operation}...`,
            details: { operation },
        });
        try {
            const output = await action();
            await progress.emit({
                ...context,
                stage,
                status: "succeeded",
                message: `GitHub mutation ${operation} completed.`,
                details: {
                    operation,
                    ...(typeof output === "object" &&
                    output !== null &&
                    "number" in output &&
                    typeof output.number === "number"
                        ? { createdIssueNumber: output.number }
                        : {}),
                },
            });
            return output;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            await progress.emit({
                ...context,
                stage,
                status: "failed",
                message: `GitHub mutation ${operation} requires recovery: ${message}`,
                details: {
                    outcome: GitHubMutationRecoveryOutcome,
                    operation,
                },
            });
            throw new GitHubMutationRecoveryError({
                message: `GitHub mutation ${operation} may have partially succeeded; recovery is required.`,
                operation,
                cause: error,
            });
        }
    };

    const ambiguous = async (
        input: WorkflowExecutorInput,
        message: string,
        details: Readonly<Record<string, unknown>>,
    ): Promise<never> => {
        await progress.emit({
            ...issueContext(input),
            stage: "issue-creation",
            status: "failed",
            message: `GitHub mutation state is ambiguous: ${message}`,
            details: {
                ...details,
                outcome: GitHubMutationRecoveryOutcome,
            },
        });
        throw new GitHubMutationRecoveryError({
            message: `GitHub mutation state is ambiguous: ${message}`,
            operation: "reconcile-created-children",
            cause: details,
        });
    };

    const readReviewAttempts = async (
        input: WorkflowExecutorInput,
    ): Promise<ReadonlyArray<ReviewAttempt>> =>
        input.artifacts.has(IssueArtifactKind.ReviewAttempts)
            ? await input.artifacts.read(IssueArtifactKind.ReviewAttempts)
            : [];

    const loadBreakdown = async (
        input: WorkflowExecutorInput,
        reviewAttempts: ReadonlyArray<ReviewAttempt>,
    ): Promise<IssueBreakdownDecision> => {
        const { context, artifacts } = input;
        if (artifacts.has(IssueArtifactKind.IssueBreakdownDecision)) {
            return await artifacts.read(
                IssueArtifactKind.IssueBreakdownDecision,
            );
        }

        const invariant = await context.repositoryInvariant.capture(
            context.repositoryPath,
        );
        if (invariant.branch !== context.targetBranch) {
            throw new RalphieError({
                message: `Decomposition requires branch ${context.targetBranch}, but checkout is on ${invariant.branch}.`,
            });
        }
        const result = await requestStructuredOutput(context.pi, {
            directory: context.repositoryPath,
            title: `Decompose issue #${context.issue.number}`,
            prompt: buildDecompositionPrompt({
                issue: context.issue,
                repositoryPath: context.repositoryPath,
                targetBranch: context.targetBranch,
                failedReviewSummaries: reviewAttempts.map(
                    ({ decision }) => decision,
                ),
            }),
            schema: issueBreakdownDecisionSchema,
            agent: context.piSelection.agent,
            model: context.piSelection.model,
            variant: context.piSelection.variant,
            runId: context.runId,
            diagnostics: context.piDiagnostics,
            verifyAfter: () =>
                context.repositoryInvariant.verify(
                    context.repositoryPath,
                    invariant,
                ),
            progress,
            progressStage: "decomposition",
            progressIssue: issueContext(input).issue,
            signal: context.signal,
        });
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            result.output,
        );
        return result.output;
    };

    const discoverChildren = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        lineage: DecompositionLineage,
    ): Promise<Map<string, number>> => {
        const { context } = input;
        const discovered = await issues.listDecompositionChildren(
            context.octokit,
            context.repository,
            lineage,
        );
        const discoveredByKey = new Map<string, number>();
        for (const child of discovered) {
            if (
                !breakdown.issues.some(
                    (issue) => issue.key === child.decompositionKey,
                )
            ) {
                return await ambiguous(
                    input,
                    `Found generated child ${child.number} with unexpected key ${child.decompositionKey}.`,
                    {
                        issueNumber: child.number,
                        key: child.decompositionKey,
                    },
                );
            }
            const previous = discoveredByKey.get(child.decompositionKey);
            if (previous !== undefined && previous !== child.number) {
                return await ambiguous(
                    input,
                    `Found multiple generated children for key ${child.decompositionKey}.`,
                    {
                        key: child.decompositionKey,
                        issueNumbers: [previous, child.number],
                    },
                );
            }
            discoveredByKey.set(child.decompositionKey, child.number);
        }
        return discoveredByKey;
    };

    const reconcileDiscoveredMapping = async (
        input: WorkflowExecutorInput,
        mapping: CreatedIssueNumberMapping,
        discoveredByKey: ReadonlyMap<string, number>,
    ): Promise<CreatedIssueNumberMapping> => {
        let nextMapping = mapping;
        for (const [key, issueNumber] of discoveredByKey) {
            const recorded = nextMapping[key];
            if (recorded !== undefined && recorded !== issueNumber) {
                return await ambiguous(
                    input,
                    `Artifact mapping for ${key} points to #${recorded}, but GitHub marker discovery found #${issueNumber}.`,
                    { key, recorded, discovered: issueNumber },
                );
            }
            if (recorded === undefined) {
                await recoverableMutation(
                    `record-created-${key}`,
                    () => input.artifacts.recordCreatedIssue(key, issueNumber),
                    input,
                );
                nextMapping = { ...nextMapping, [key]: issueNumber };
            }
        }
        return nextMapping;
    };

    const createMissingChildren = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        lineage: DecompositionLineage,
        mapping: CreatedIssueNumberMapping,
    ): Promise<CreatedIssueNumberMapping> => {
        const { context } = input;
        let nextMapping = mapping;
        for (const child of breakdown.issues) {
            if (nextMapping[child.key] !== undefined) continue;
            const created = await recoverableMutation(
                `create-child-${child.key}`,
                () =>
                    mutations.create(context.octokit, context.repository, {
                        title: child.title,
                        body: `${decompositionMarker(lineage, child.key)}\n\n${child.body}`,
                    }),
                input,
            );
            await recoverableMutation(
                `record-created-${child.key}`,
                () =>
                    input.artifacts.recordCreatedIssue(
                        child.key,
                        created.number,
                    ),
                input,
            );
            nextMapping = { ...nextMapping, [child.key]: created.number };
        }
        return nextMapping;
    };

    const linkChildren = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        lineage: DecompositionLineage,
        mapping: CreatedIssueNumberMapping,
    ): Promise<void> => {
        const { context } = input;
        for (const child of breakdown.issues) {
            const childNumber = mapping[child.key];
            if (childNumber === undefined) {
                throw new RalphieError({
                    message: `Missing created issue for ${child.key}.`,
                });
            }
            await recoverableMutation(
                `link-child-${child.key}`,
                () =>
                    mutations.update(
                        context.octokit,
                        context.repository,
                        childNumber,
                        {
                            body: renderChildIssueBody({
                                child,
                                lineage,
                                issueNumbers: mapping,
                            }),
                        },
                    ),
                input,
            );
        }
    };

    const executeDecomposition = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
        const lineage = nextDecompositionLineage(context.issue);
        const reviewAttempts = await readReviewAttempts(input);
        const breakdown = await loadBreakdown(input, reviewAttempts);
        let mapping = await existingMapping(input);
        const discoveredByKey = await discoverChildren(
            input,
            breakdown,
            lineage,
        );
        mapping = await reconcileDiscoveredMapping(
            input,
            mapping,
            discoveredByKey,
        );
        mapping = await createMissingChildren(
            input,
            breakdown,
            lineage,
            mapping,
        );
        await linkChildren(input, breakdown, lineage, mapping);

        await recoverableMutation(
            "rewrite-original",
            () =>
                mutations.update(
                    context.octokit,
                    context.repository,
                    context.issue.number,
                    {
                        body: renderDecomposedOriginalBody({
                            original: context.issue,
                            breakdown,
                            issueNumbers: mapping,
                            lineage,
                        }),
                    },
                ),
            input,
        );
        await recoverableMutation(
            "close-original",
            () =>
                mutations.close(
                    context.octokit,
                    context.repository,
                    context.issue.number,
                    "duplicate",
                ),
            input,
        );

        return {
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: breakdown.issues.map(
                (child) => mapping[child.key]!,
            ),
        } as const;
    };

    return {
        execute: executeDecomposition,
    };
};

export const DecompositionExecutorLive = makeDecompositionExecutorService;