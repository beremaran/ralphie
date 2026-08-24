import type { PromptSpinnerFactory } from "@bunli/core";
import { Context, Effect, Layer } from "effect";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSensitiveText, redactSensitiveValue } from "../shared/redaction.ts";

export enum ProgressStage {
  Run = "run",
  WorkspaceCleanup = "workspace-cleanup",
  GitHubAuthentication = "github-authentication",
  GitVerification = "git-verification",
  RemoteSafety = "remote-safety",
  RepositoryPreparation = "repository-preparation",
  IssueDiscovery = "issue-discovery",
  OpenCodeServer = "opencode-server",
  IssuePlanning = "issue-planning",
  IssueExecution = "issue-execution",
  IssueQueue = "issue-queue",
  ComplexityAssessment = "complexity-assessment",
  Implementation = "implementation",
  ChangeStaging = "change-staging",
  Review = "review",
  ReviewFix = "review-fix",
  ReviewExhaustion = "review-exhaustion",
  CheckoutRestore = "checkout-restore",
  CommitMessage = "commit-message",
  Commit = "commit",
  Push = "push",
  Decomposition = "decomposition",
  IssueCreation = "issue-creation",
  IssueClosure = "issue-closure",
}

export enum ProgressStatus {
  Started = "started",
  Succeeded = "succeeded",
  Failed = "failed",
  Skipped = "skipped",
  Info = "info",
}

export enum ProgressRenderMode {
  Interactive = "interactive",
  Plain = "plain",
  Json = "json",
  Quiet = "quiet",
}

export type ProgressIssue = {
  readonly number: number;
  readonly title: string;
};

export type ProgressUpdate = {
  readonly stage: ProgressStage;
  readonly status: ProgressStatus;
  readonly message: string;
  readonly issue?: ProgressIssue;
  readonly current?: number;
  readonly total?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ProgressEvent = ProgressUpdate & {
  readonly runId: string;
  readonly timestamp: string;
};

export type ProgressReporterService = {
  readonly emit: (update: ProgressUpdate) => Effect.Effect<void>;
  /** Stop writing durable events while continuing to render progress. */
  readonly stopPersisting: Effect.Effect<void>;
};

export const ProgressReporter = Context.GenericTag<ProgressReporterService>(
  "ralphie/ProgressReporter",
);

export type ProgressRendererOptions = {
  readonly mode: ProgressRenderMode;
  readonly verbose: boolean;
  readonly spinner: PromptSpinnerFactory;
  readonly write?: (text: string) => void;
  readonly now?: () => Date;
  readonly runId?: string;
  /** Optional durable, redacted JSON Lines audit log. */
  readonly eventLogPath?: string;
};

const statusSymbol = (status: ProgressStatus): string => {
  switch (status) {
    case ProgressStatus.Succeeded:
      return "✓";
    case ProgressStatus.Failed:
      return "✗";
    case ProgressStatus.Skipped:
      return "−";
    case ProgressStatus.Started:
      return "◐";
    case ProgressStatus.Info:
      return "•";
  }
};

const formatDetails = (
  details: Readonly<Record<string, unknown>> | undefined,
): string => (details === undefined ? "" : ` ${JSON.stringify(details)}`);

export const makeProgressReporterLayer = ({
  mode,
  verbose,
  spinner: createSpinner,
  write = (text) => process.stderr.write(text),
  now = () => new Date(),
  runId = crypto.randomUUID(),
  eventLogPath,
}: ProgressRendererOptions) =>
  Layer.sync(ProgressReporter, () => {
    let activeSpinner: ReturnType<PromptSpinnerFactory> | undefined;
    let persistEvents = true;

    const renderLine = (event: ProgressEvent): string => {
      const issue = event.issue ? ` #${event.issue.number}` : "";
      const position =
        event.current !== undefined && event.total !== undefined
          ? ` [${event.current}/${event.total}]`
          : "";
      const attempt =
        event.attempt !== undefined && event.maxAttempts !== undefined
          ? ` (${event.attempt}/${event.maxAttempts})`
          : "";
      const details = verbose ? formatDetails(event.details) : "";
      return `${statusSymbol(event.status)}${position}${attempt}${issue} ${event.message}${details}`;
    };

    return {
      emit: (update) =>
        Effect.sync(() => {
          const event: ProgressEvent = {
            ...update,
            message: redactSensitiveText(update.message),
            ...(update.details === undefined
              ? {}
              : {
                  details: redactSensitiveValue(update.details) as Readonly<
                    Record<string, unknown>
                  >,
                }),
            runId,
            timestamp: now().toISOString(),
          };

          if (eventLogPath !== undefined && persistEvents) {
            mkdirSync(dirname(eventLogPath), { recursive: true });
            appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
          }

          if (mode === ProgressRenderMode.Json) {
            write(`${JSON.stringify(event)}\n`);
            return;
          }
          if (
            mode === ProgressRenderMode.Quiet &&
            event.status !== ProgressStatus.Failed
          ) {
            return;
          }

          const line = renderLine(event);
          if (mode !== ProgressRenderMode.Interactive) {
            write(`${line}\n`);
            return;
          }

          if (event.status === ProgressStatus.Started) {
            activeSpinner?.stop();
            activeSpinner = createSpinner({ text: line, showTimer: true });
            activeSpinner.start();
            return;
          }

          if (activeSpinner !== undefined) {
            if (event.status === ProgressStatus.Succeeded) {
              activeSpinner.succeed(line);
            } else if (event.status === ProgressStatus.Failed) {
              activeSpinner.fail(line);
            } else if (event.status === ProgressStatus.Skipped) {
              activeSpinner.warn(line);
            } else {
              activeSpinner.info(line);
            }
            activeSpinner = undefined;
            return;
          }

          write(`${line}\n`);
        }),
      stopPersisting: Effect.sync(() => {
        persistEvents = false;
      }),
    };
  });

export const makeProgressRecorderLayer = (events: ProgressUpdate[]) =>
  Layer.succeed(ProgressReporter, {
    emit: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    stopPersisting: Effect.void,
  });
