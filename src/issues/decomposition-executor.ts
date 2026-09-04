import {
    decompositionMarker,
    nextDecompositionLineage,
    parseDecompositionMarker,
    renderChildIssueBody,
    renderDecomposedOriginalBody,
    type DecompositionLineage,
} from "../github/decomposition-markdown.ts";
import {
    GitHubMutationRecoveryError,
    GitHubMutationRecoveryOutcome,
    type GitHubIssueMutationService,
} from "../github/issue-mutations.ts";
import type { GitHubIssue, GitHubIssuesService } from "../github/issues.ts";
import type { GitHubIssueRelationshipService } from "../github/issue-relationships.ts";
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
    type CreatedIssueDependencyMapping,
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
import type { NeedsAttentionRouterService } from "./needs-attention.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../options.ts";

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
    relationships: GitHubIssueRelationshipService,
    progress: ProgressReporterService,
    needsAttentionRouter?: NeedsAttentionRouterService,
): DecompositionExecutorService => {
    const recoverableMutation = async <Output>(
        operation: string,
        action: () => Promise<Output>,
        input: WorkflowExecutorInput,
    ): Promise<Output> => {
        const context = issueContext(input);
        const stage =
            operation.startsWith("attach-child-") ||
            operation.startsWith("add-dependency-") ||
            operation === "persist-dependencies"
                ? "issue-relationships"
                : "issue-creation";
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
            context.signal,
        );
        if (invariant.branch !== context.targetBranch) {
            throw new RalphieError({
                message: `Decomposition requires branch ${context.targetBranch}, but checkout is on ${invariant.branch}.`,
            });
        }
        const result = await requestStructuredOutput(context.agent, {
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
            agent: context.agentSelection.agent,
            model: context.agentSelection.model,
            variant: context.agentSelection.variant,
            runId: context.runId,
            diagnostics: context.agentDiagnostics,
            verifyAfter: (signal) =>
                context.repositoryInvariant.verify(
                    context.repositoryPath,
                    invariant,
                    signal,
                ),
            progress,
            progressStage: "decomposition",
            progressIssue: issueContext(input).issue,
            signal: context.signal,
        });
        if (result.needsAttention !== undefined) {
            if (needsAttentionRouter === undefined) {
                throw new RalphieError({
                    message:
                        "A needs-attention signal requires the verifier/router service.",
                });
            }
            const routed = await needsAttentionRouter.route({
                context,
                artifacts,
                request: result.needsAttention,
                checkpoint: {
                    branch: invariant.branch,
                    sha: invariant.head,
                },
            });
            if (routed !== undefined) throw new RoutedNeedsAttention(routed);
        }
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            result.output,
            context.signal,
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
                    () =>
                        input.artifacts.recordCreatedIssue(
                            key,
                            issueNumber,
                            input.context.signal,
                        ),
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
                        input.context.signal,
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

    /**
     * Attach every created or recovered child to the original issue as a
     * native sub-issue, reconciling against what GitHub already reports so a
     * restart cannot duplicate relationships. Conflicting native hierarchy or
     * marker lineage halts with a recovery diagnostic instead of silently
     * reparenting or rewriting issues.
     */
    /** True when an attached child's marker disagrees with the intended parent. */
    const markerLineageConflict = (
        body: string | null,
        parentNumber: number,
        lineage: DecompositionLineage,
    ): boolean => {
        const marker = parseDecompositionMarker(body);
        return (
            marker !== undefined &&
            (marker.parentIssueNumber !== parentNumber ||
                marker.rootIssueNumber !== lineage.rootIssueNumber)
        );
    };

    /** True when a foreign sub-issue is marker-matched to this decomposition. */
    const markerMatchesParent = (
        body: string | null,
        parentNumber: number,
        lineage: DecompositionLineage,
    ): boolean => {
        const marker = parseDecompositionMarker(body);
        return (
            marker !== undefined &&
            marker.parentIssueNumber === parentNumber &&
            marker.rootIssueNumber === lineage.rootIssueNumber
        );
    };

    /** Attach the expected children, skipping those already attached natively. */
    const attachExpectedChildren = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        mapping: CreatedIssueNumberMapping,
        nativeByNumber: ReadonlyMap<number, GitHubIssue>,
        parentNumber: number,
        lineage: DecompositionLineage,
    ): Promise<void> => {
        const { context } = input;
        for (const child of breakdown.issues) {
            const childNumber = mapping[child.key];
            if (childNumber === undefined) {
                throw new RalphieError({
                    message: `Missing created issue for ${child.key}.`,
                });
            }
            const attached = nativeByNumber.get(childNumber);
            if (attached !== undefined) {
                if (
                    markerLineageConflict(attached.body, parentNumber, lineage)
                ) {
                    await ambiguous(
                        input,
                        `Native sub-issue #${childNumber} is attached to #${parentNumber} but its marker names a different parent or root.`,
                        {
                            issueNumber: childNumber,
                            expectedParent: parentNumber,
                            expectedRoot: lineage.rootIssueNumber,
                        },
                    );
                }
                continue;
            }
            await recoverableMutation(
                `attach-child-${child.key}`,
                () =>
                    relationships.attachSubIssue(
                        context.octokit,
                        context.repository,
                        parentNumber,
                        childNumber,
                    ),
                input,
            );
        }
    };

    /** Halt on marker-matched children attached natively but unmapped. */
    const rejectUnexpectedNativeChildren = async (
        input: WorkflowExecutorInput,
        mapping: CreatedIssueNumberMapping,
        nativeByNumber: ReadonlyMap<number, GitHubIssue>,
        parentNumber: number,
        lineage: DecompositionLineage,
    ): Promise<void> => {
        const expectedNumbers = new Set(Object.values(mapping));
        for (const [issueNumber, attached] of nativeByNumber) {
            if (expectedNumbers.has(issueNumber)) continue;
            if (markerMatchesParent(attached.body, parentNumber, lineage)) {
                await ambiguous(
                    input,
                    `Native sub-issue #${issueNumber} matches this decomposition but is absent from the persisted key mapping.`,
                    { issueNumber, expectedParent: parentNumber },
                );
            }
        }
    };

    /**
     * Attach every created or recovered child to the original issue as a
     * native sub-issue, reconciling against what GitHub already reports so a
     * restart cannot duplicate relationships. Conflicting native hierarchy or
     * marker lineage halts with a recovery diagnostic instead of silently
     * reparenting or rewriting issues.
     */
    const attachChildrenToParent = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        lineage: DecompositionLineage,
        mapping: CreatedIssueNumberMapping,
    ): Promise<void> => {
        const { context } = input;
        const parentNumber = context.issue.number;
        const nativeByNumber = new Map(
            (
                await relationships.listSubIssues(
                    context.octokit,
                    context.repository,
                    parentNumber,
                )
            ).map((issue) => [issue.number, issue]),
        );

        await attachExpectedChildren(
            input,
            breakdown,
            mapping,
            nativeByNumber,
            parentNumber,
            lineage,
        );
        await rejectUnexpectedNativeChildren(
            input,
            mapping,
            nativeByNumber,
            parentNumber,
            lineage,
        );
    };

    const dependencyMappingFor = (
        breakdown: IssueBreakdownDecision,
        mapping: CreatedIssueNumberMapping,
    ): CreatedIssueDependencyMapping =>
        Object.fromEntries(
            breakdown.issues.map((child) => [
                child.key,
                child.dependsOn
                    .map((key) => mapping[key])
                    .filter((value): value is number => value !== undefined),
            ]),
        );

    const createChildDependencies = async (
        input: WorkflowExecutorInput,
        childNumber: number,
        blockers: ReadonlyArray<number>,
    ): Promise<void> => {
        const { context } = input;
        const existingNumbers = new Set(
            (
                await relationships.listBlockedBy(
                    context.octokit,
                    context.repository,
                    childNumber,
                )
            ).map((issue) => issue.number),
        );
        for (const blockerNumber of blockers) {
            if (existingNumbers.has(blockerNumber)) continue;
            await recoverableMutation(
                `add-dependency-${childNumber}-on-${blockerNumber}`,
                () =>
                    relationships.addBlockedBy(
                        context.octokit,
                        context.repository,
                        childNumber,
                        blockerNumber,
                    ),
                input,
            );
        }
    };

    const createMissingDependencies = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        mapping: CreatedIssueNumberMapping,
        dependencyMapping: CreatedIssueDependencyMapping,
    ): Promise<void> => {
        for (const child of breakdown.issues) {
            const childNumber = mapping[child.key];
            if (childNumber === undefined) {
                throw new RalphieError({
                    message: `Missing created issue for ${child.key}.`,
                });
            }
            await createChildDependencies(
                input,
                childNumber,
                dependencyMapping[child.key] ?? [],
            );
        }
    };

    /**
     * Reconcile every declared dependsOn edge as a native blocked_by
     * relationship and persist the dependency mapping artifact so queue
     * eligibility never depends on live GitHub state alone. Each edge is an
     * independently recoverable mutation.
     */
    const reconcileNativeDependencies = async (
        input: WorkflowExecutorInput,
        breakdown: IssueBreakdownDecision,
        mapping: CreatedIssueNumberMapping,
    ): Promise<void> => {
        const dependencyMapping = dependencyMappingFor(breakdown, mapping);
        await createMissingDependencies(
            input,
            breakdown,
            mapping,
            dependencyMapping,
        );

        if (input.artifacts.has(IssueArtifactKind.CreatedIssueDependencies)) {
            const persisted = await input.artifacts.read(
                IssueArtifactKind.CreatedIssueDependencies,
            );
            if (
                JSON.stringify(persisted) !== JSON.stringify(dependencyMapping)
            ) {
                await ambiguous(
                    input,
                    "The persisted dependency mapping disagrees with the current breakdown.",
                    { persisted, expected: dependencyMapping },
                );
            }
            return;
        }
        await recoverableMutation(
            "persist-dependencies",
            () =>
                input.artifacts.write(
                    IssueArtifactKind.CreatedIssueDependencies,
                    dependencyMapping,
                    input.context.signal,
                ),
            input,
        );
    };

    const executeDecomposition = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
        const lineage = nextDecompositionLineage(
            context.issue,
            context.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH,
        );
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
        await attachChildrenToParent(input, breakdown, lineage, mapping);
        await reconcileNativeDependencies(input, breakdown, mapping);

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

        // The decomposed parent stays open as the native tracking issue for
        // its sub-issues; it is never closed as a duplicate merely because it
        // was decomposed.
        return {
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: breakdown.issues.map(
                (child) => mapping[child.key]!,
            ),
        } as const;
    };

    return {
        execute: async (input) => {
            try {
                return await executeDecomposition(input);
            } catch (error) {
                if (error instanceof RoutedNeedsAttention) {
                    return error.outcome;
                }
                throw error;
            }
        },
    };
};

class RoutedNeedsAttention extends Error {
    constructor(readonly outcome: WorkflowExecutorResult) {
        super("Needs attention");
    }
}

export const DecompositionExecutorLive = makeDecompositionExecutorService;