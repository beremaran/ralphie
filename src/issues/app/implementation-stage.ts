import { type GitIssuePreparationService } from "../ports.ts";
import {
    type ProgressStage,
    type ProgressReporterService,
} from "../../progress/ports.ts";
import { errorMessage, throwIfAborted } from "../../shared/error.ts";
import {
    type IssueExecutionContext,
    type WorkflowExecutorInput,
} from "./execution-model.ts";
import {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    REVIEW_ITERATION_LIMIT,
} from "../domain/stage.ts";

/**
 * Helpers every stage of the implementation workflow shares: progress events
 * around an operation, the attempt budgets, cancellation and the checkpoint.
 */
export const issueProgress = (input: WorkflowExecutorInput) => ({
    issue: {
        number: input.context.issue.number,
        title: input.context.issue.title,
    },
});

export const checkSignal = (signal: AbortSignal | undefined): void =>
    throwIfAborted(signal, "Issue execution was aborted.");

/** One attempt out of the budget its stage runs under. */
export type AttemptCounter = {
    readonly attempt: number;
    readonly maxAttempts: number;
};

export const implementationBudget = (context: IssueExecutionContext): number =>
    context.implementationAttempts ?? DEFAULT_IMPLEMENTATION_ATTEMPTS;

export const reviewBudget = (context: IssueExecutionContext): number =>
    context.reviewRounds ?? REVIEW_ITERATION_LIMIT;

export const verificationFixBudget = (context: IssueExecutionContext): number =>
    context.verificationFixes ?? REVIEW_ITERATION_LIMIT;

export const stage = async <A>(
    progress: ProgressReporterService,
    input: WorkflowExecutorInput,
    progressStage: ProgressStage,
    startedMessage: string,
    operation: () => Promise<A>,
    succeededMessage: string | ((value: A) => string),
    details?: Readonly<Record<string, unknown>>,
    attempt?: AttemptCounter,
): Promise<A> => {
    const base = {
        ...issueProgress(input),
        stage: progressStage,
        ...attempt,
        ...(details === undefined ? {} : { details }),
    };
    await progress.emit({
        ...base,
        status: "started",
        message: startedMessage,
    });
    try {
        const value = await operation();
        await progress.emit({
            ...base,
            status: "succeeded",
            message:
                typeof succeededMessage === "function"
                    ? succeededMessage(value)
                    : succeededMessage,
        });
        return value;
    } catch (error) {
        await progress.emit({
            ...base,
            status: "failed",
            message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(
                error,
            )}`,
        });
        throw error;
    }
};

export const readCheckpoint = async (
    preparation: GitIssuePreparationService,
    input: WorkflowExecutorInput,
) =>
    preparation.prepare({
        issueNumber: input.context.issue.number,
        repositoryPath: input.context.repositoryPath,
        branch: input.context.targetBranch,
        signal: input.context.signal,
    });