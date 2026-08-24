import { Context, Effect, Layer } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GitIssueCheckpoint, type IssueCheckpoint } from "../git/issue-checkpoint.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import { type ReviewDecision, ReviewVerdict } from "./decisions.ts";
import {
  IssueQueueResumeStrategy,
  IssueWorkflowKind,
  REVIEW_ITERATION_LIMIT,
} from "./stage.ts";

export type ReviewAttempt = {
  readonly attempt: number;
  readonly sessionID: string;
  readonly decision: ReviewDecision;
};

export type ReviewExhaustionInput = {
  readonly runId: string;
  readonly workspace: string;
  readonly repositoryPath: string;
  readonly issue: GitHubIssue;
  readonly checkpoint: IssueCheckpoint;
  readonly reviews: ReadonlyArray<ReviewAttempt>;
};

export enum ReviewExhaustionOutcome {
  EscalatedToDecomposition = "escalated-to-decomposition",
}

export type ReviewExhaustionResult = {
  readonly outcome: ReviewExhaustionOutcome.EscalatedToDecomposition;
  readonly diagnosticsPath: string;
  readonly nextWorkflow: IssueWorkflowKind.Decomposition;
  readonly resume: IssueQueueResumeStrategy.RefreshOpenIssues;
};

export const REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES = 2 * 1024 * 1024;

export type IssueRecoveryService = {
  readonly handleReviewExhaustion: (
    input: ReviewExhaustionInput,
  ) => Effect.Effect<ReviewExhaustionResult, RalphieError>;
};

export const IssueRecovery = Context.GenericTag<IssueRecoveryService>(
  "ralphie/IssueRecovery",
);

const safeRunId = (runId: string): string =>
  runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

export const IssueRecoveryLive = Layer.effect(
  IssueRecovery,
  Effect.gen(function* () {
    const git = yield* GitIssueCheckpoint;
    const progress = yield* ProgressReporter;

    return {
      handleReviewExhaustion: (input) =>
        Effect.gen(function* () {
          const attemptsAreComplete = input.reviews.every(
            (review, index) => review.attempt === index + 1,
          );
          const lastReview = input.reviews.at(-1);
          if (
            input.reviews.length !== REVIEW_ITERATION_LIMIT ||
            !attemptsAreComplete ||
            lastReview?.decision.verdict !== ReviewVerdict.ChangesRequested
          ) {
            return yield* new RalphieError({
              message: `Review exhaustion requires ${REVIEW_ITERATION_LIMIT} ordered attempts ending in changes requested.`,
            });
          }

          const issueContext = {
            issue: { number: input.issue.number, title: input.issue.title },
            attempt: input.reviews.length,
            maxAttempts: REVIEW_ITERATION_LIMIT,
          };
          yield* progress.emit({
            ...issueContext,
            stage: ProgressStage.ReviewExhaustion,
            status: ProgressStatus.Info,
            message: `Review did not converge; escalating #${input.issue.number} to decomposition.`,
          });

          const patch = yield* git.createPatch(input.repositoryPath);
          if (Buffer.byteLength(patch) > REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES) {
            return yield* new RalphieError({
              message: `Review diagnostic patch exceeds ${REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES} bytes. Checkout was not restored.`,
            });
          }
          const metadata = `${JSON.stringify(
            {
              issue: input.issue,
              checkpoint: input.checkpoint,
              reviews: input.reviews,
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`;
          if (Buffer.byteLength(metadata) > REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES) {
            return yield* new RalphieError({
              message: `Review diagnostic metadata exceeds ${REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES} bytes. Checkout was not restored.`,
            });
          }
          const diagnosticsPath = join(
            resolveWorkspacePath(input.workspace),
            ".ralphie",
            "runs",
            safeRunId(input.runId),
            "issues",
            String(input.issue.number),
            "review-exhaustion",
          );
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(diagnosticsPath, { recursive: true });
              await Promise.all([
                writeFile(join(diagnosticsPath, "changes.patch"), patch),
                writeFile(join(diagnosticsPath, "metadata.json"), metadata),
              ]);
            },
            catch: (cause) =>
              new RalphieError({
                message: `Failed to preserve review diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
                cause,
              }),
          });

          yield* progress.emit({
            ...issueContext,
            stage: ProgressStage.CheckoutRestore,
            status: ProgressStatus.Started,
            message: `Restoring ${input.checkpoint.branch} to ${input.checkpoint.sha}...`,
            details: { diagnosticsPath },
          });
          yield* git.restore(input.repositoryPath, input.checkpoint).pipe(
            Effect.tapError((error) =>
              progress.emit({
                ...issueContext,
                stage: ProgressStage.CheckoutRestore,
                status: ProgressStatus.Failed,
                message: `Checkout restoration failed: ${error.message}`,
                details: { diagnosticsPath },
              }),
            ),
          );
          yield* progress.emit({
            ...issueContext,
            stage: ProgressStage.CheckoutRestore,
            status: ProgressStatus.Succeeded,
            message: `Restored ${input.checkpoint.branch} to the clean issue base.`,
            details: { diagnosticsPath },
          });

          return {
            outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
            diagnosticsPath,
            nextWorkflow: IssueWorkflowKind.Decomposition,
            resume: IssueQueueResumeStrategy.RefreshOpenIssues,
          };
        }),
    };
  }),
);
