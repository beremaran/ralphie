import { Context, Effect, FiberRef, Layer } from "effect";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSensitiveText, redactSensitiveValue } from "../shared/redaction.ts";

export enum ProgressStage {
  Run = "run",
  WorkspacePreparation = "workspace-preparation",
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
  ResolutionVerification = "resolution-verification",
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
  readonly repository?: string;
  readonly repositoryRunId?: string;
  readonly issue?: ProgressIssue;
  readonly current?: number;
  readonly total?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ProgressContext = Pick<ProgressUpdate, "repository" | "repositoryRunId">;

const currentProgressContext = FiberRef.unsafeMake<ProgressContext>({});

export const withProgressContext = <Result, Error, Requirements>(
  effect: Effect.Effect<Result, Error, Requirements>,
  context: ProgressContext,
): Effect.Effect<Result, Error, Requirements> =>
  Effect.locally(effect, currentProgressContext, context);

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
  readonly write?: (text: string) => void;
  readonly width?: () => number;
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

const CLEAR_LIVE_LINE = "\r\x1b[2K";

const clipToWidth = (text: string, width: number): string => {
  const available = Math.max(1, width - 1);
  if (Bun.stringWidth(text) <= available) return text;
  if (available === 1) return "…";

  const contentWidth = available - Bun.stringWidth("…");
  let clipped = "";
  let used = 0;
  for (const character of text) {
    const characterWidth = Bun.stringWidth(character);
    if (used + characterWidth > contentWidth) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}…`;
};

const progressIdentity = (event: ProgressEvent): string =>
  `${event.stage}:${event.issue?.number ?? ""}:${event.attempt ?? ""}`;

type ActiveProgress = {
  readonly identity: string;
  readonly line: string;
  readonly startedAt: number;
};

export const makeProgressReporterLayer = ({
  mode,
  verbose,
  write = (text) => process.stderr.write(text),
  width = () => process.stderr.columns ?? 80,
  now = () => new Date(),
  runId = crypto.randomUUID(),
  eventLogPath,
}: ProgressRendererOptions) =>
  Layer.sync(ProgressReporter, () => {
    const activeProgress: ActiveProgress[] = [];
    let liveLineVisible = false;
    let persistEvents = true;

    const renderLine = (event: ProgressEvent): string => {
      const repository = event.repository ? ` [${event.repository}]` : "";
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
      return `${statusSymbol(event.status)}${repository}${position}${attempt}${issue} ${event.message}${details}`;
    };

    const clearLiveLine = () => {
      if (!liveLineVisible) return;
      write(CLEAR_LIVE_LINE);
      liveLineVisible = false;
    };

    const renderLiveLine = () => {
      const active = activeProgress.at(-1);
      if (active === undefined) return;
      write(clipToWidth(active.line, width()));
      liveLineVisible = true;
    };

    const appendLine = (line: string) => {
      clearLiveLine();
      write(`${line}\n`);
      renderLiveLine();
    };

    const removeActive = (identity: string): ActiveProgress | undefined => {
      for (let index = activeProgress.length - 1; index >= 0; index -= 1) {
        if (activeProgress[index]?.identity !== identity) continue;
        return activeProgress.splice(index, 1)[0];
      }
      return undefined;
    };

    return {
      emit: (update) =>
        Effect.gen(function* () {
          const context = yield* FiberRef.get(currentProgressContext);
          yield* Effect.sync(() => {
            const emittedAt = now();
            const event: ProgressEvent = {
              ...context,
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
              timestamp: emittedAt.toISOString(),
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
              clearLiveLine();
              removeActive(progressIdentity(event));
              activeProgress.push({
                identity: progressIdentity(event),
                line,
                startedAt: emittedAt.getTime(),
              });
              renderLiveLine();
              return;
            }

            const terminalRunEvent =
              event.stage === ProgressStage.Run &&
              (event.status === ProgressStatus.Succeeded ||
                event.status === ProgressStatus.Failed);
            const settled =
              event.status === ProgressStatus.Succeeded ||
              event.status === ProgressStatus.Failed ||
              event.status === ProgressStatus.Skipped;
            const active = settled ? removeActive(progressIdentity(event)) : undefined;
            if (terminalRunEvent) {
              activeProgress.length = 0;
            }
            const duration =
              active === undefined
                ? ""
                : ` (${(
                    Math.max(0, emittedAt.getTime() - active.startedAt) / 1000
                  ).toFixed(1)}s)`;
            appendLine(`${line}${duration}`);
          });
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
