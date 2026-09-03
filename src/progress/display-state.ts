import type { PiEventContext, PiSessionEvent } from "../opencode/client.ts";
import { stripTerminalControls } from "../shared/terminal.ts";
import type {
    ProgressEvent,
    ProgressStage,
    ProgressStatus,
    ProgressUpdate,
} from "./progress.ts";

export type DisplayActivity =
    | "thinking"
    | "responding"
    | "tool"
    | "compacting"
    | "retrying"
    | "waiting";

export type DisplayIssue = {
    readonly current: number;
    readonly total: number;
    readonly number: number;
    readonly title: string;
};

export type DisplayReviewAttempt = {
    readonly current: number;
    readonly total: number;
};

/** State needed by presentation code, without any terminal or persistence concerns. */
export type DisplayState = {
    readonly repository?: string;
    readonly issue?: DisplayIssue;
    /** The active decomposition parent, when the queue is running a leaf. */
    readonly parentIssue?: number;
    /** The nested leaf currently being run under the active parent. */
    readonly activeLeaf?: number;
    readonly stage?: ProgressStage;
    readonly status?: ProgressStatus;
    readonly reviewAttempt?: DisplayReviewAttempt;
    readonly activity: DisplayActivity;
    readonly activityLabel: string;
    /** Epoch milliseconds at which the current stage became active. */
    readonly stageStartedAt?: number;
};

export type DisplayTimestamp = Date | number | string;
export type DisplayClock = () => DisplayTimestamp;

export type DisplayStateOptions = {
    readonly now?: DisplayClock;
};

/** Human-readable names for every workflow stage. */
export const PROGRESS_STAGE_LABELS: Readonly<Record<ProgressStage, string>> = {
    run: "Running workflow",
    "workspace-preparation": "Preparing workspace",
    "workspace-cleanup": "Cleaning up workspace",
    "github-authentication": "Authenticating with GitHub",
    "git-verification": "Verifying Git",
    "remote-safety": "Checking remote safety",
    "repository-discovery": "Discovering repository",
    "repository-preparation": "Preparing repository",
    "issue-discovery": "Discovering issues",
    "opencode-runtime": "Starting OpenCode",
    "issue-planning": "Planning issue",
    "issue-execution": "Executing issue",
    "issue-queue": "Updating issue queue",
    grounding: "Checking issue readiness",
    "issue-grounding": "Checking issue readiness",
    "complexity-assessment": "Assessing complexity",
    implementation: "Implementing changes",
    "change-staging": "Staging changes",
    verification: "Running verification",
    "verification-fix": "Repairing verification failure",
    "resolution-verification": "Verifying resolution",
    review: "Reviewing changes",
    "review-fix": "Addressing review findings",
    "review-exhaustion": "Handling review exhaustion",
    "checkout-restore": "Restoring checkout",
    "commit-message": "Generating commit message",
    commit: "Creating commit",
    push: "Pushing changes",
    decomposition: "Decomposing issue",
    "issue-creation": "Creating issues",
    "issue-relationships": "Linking issues",
    "issue-closure": "Closing issue",
    "pr-gate": "Waiting for PR checks",
    "notification-recovery": "Publishing needs-attention notification",
};

/** Stable labels for activities that do not carry a dynamic name. */
export const DISPLAY_ACTIVITY_LABELS: Readonly<
    Record<DisplayActivity, string>
> = {
    thinking: "Thinking",
    responding: "Responding",
    tool: "Using tool",
    compacting: "Compacting context",
    retrying: "Retrying",
    waiting: "Waiting",
};

const makeInitialDisplayState = (): DisplayState => ({
    activity: "waiting",
    activityLabel: DISPLAY_ACTIVITY_LABELS.waiting,
});

export const createDisplayState = (): DisplayState => makeInitialDisplayState();
export const initialDisplayState: DisplayState = makeInitialDisplayState();

const recordValue = (value: unknown): Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : {};

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Reduce display text to one terminal-safe line without altering its content.
 *
 * Only ANSI/control removal and whitespace normalization apply here; values
 * are otherwise preserved verbatim for rendering and canonical keys.
 */
const displayText = (value: string): string =>
    stripTerminalControls(value).replace(/\s+/g, " ").trim();

const nonEmptyDisplayText = (value: string, fallback: string): string => {
    const clean = displayText(value);
    return clean === "" ? fallback : clean;
};

const timestampValue = (value: unknown): number | undefined => {
    if (value instanceof Date) {
        const milliseconds = value.getTime();
        return Number.isFinite(milliseconds) ? milliseconds : undefined;
    }
    if (typeof value === "number")
        return Number.isFinite(value) ? value : undefined;
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

const clockValue = (clock: DisplayClock): number => {
    const timestamp = timestampValue(clock());
    return timestamp ?? Date.now();
};

const clockFrom = (
    input: DisplayClock | DisplayStateOptions | undefined,
): DisplayClock =>
    typeof input === "function" ? input : (input?.now ?? (() => Date.now()));

const timestampFromProgress = (
    update: ProgressUpdate | ProgressEvent,
    clock: DisplayClock,
): number => {
    const timestamp = timestampValue((update as ProgressEvent).timestamp);
    return timestamp ?? clockValue(clock);
};

/** Normalize stored display values without dropping any of their content. */
const normalizedState = (state: DisplayState): DisplayState => ({
    ...state,
    ...(state.repository === undefined
        ? {}
        : { repository: displayText(state.repository) }),
    ...(state.issue === undefined
        ? {}
        : {
              issue: {
                  ...state.issue,
                  title: displayText(state.issue.title),
              },
          }),
    activityLabel: nonEmptyDisplayText(
        state.activityLabel,
        DISPLAY_ACTIVITY_LABELS[state.activity],
    ),
});

const nestedTimestamp = (value: unknown): number | undefined => {
    const direct = timestampValue(value);
    if (direct !== undefined) return direct;
    const record = recordValue(value);
    const timestamp = timestampValue(record.timestamp);
    if (timestamp !== undefined) return timestamp;
    const created = timestampValue(record.created);
    if (created !== undefined) return created;
    return record.time === undefined ? undefined : nestedTimestamp(record.time);
};

const timestampFromPi = (
    event: PiSessionEvent,
    context: PiEventContext,
    clock: DisplayClock,
): number => {
    const eventRecord = recordValue(event);
    const message = eventRecord.message;
    const partial = recordValue(eventRecord.assistantMessageEvent).partial;
    const result = eventRecord.result;
    const contextTimestamp = (recordValue(context) as { timestamp?: unknown })
        .timestamp;
    for (const candidate of [
        eventRecord.timestamp,
        eventRecord.time,
        message,
        partial,
        result,
        contextTimestamp,
    ]) {
        const timestamp = nestedTimestamp(candidate);
        if (timestamp !== undefined) return timestamp;
    }
    return clockValue(clock);
};

const repositoryFor = (
    state: DisplayState,
    update: ProgressUpdate,
): string | undefined => {
    const details = recordValue(update.details);
    const incoming = update.repository ?? stringValue(details.repository);
    if (incoming === undefined) return state.repository;
    const clean = displayText(incoming);
    return clean === "" ? state.repository : clean;
};

const isLeafCompletion = (update: ProgressUpdate): boolean =>
    update.stage === "issue-closure" && update.status === "succeeded";

const nestedIssueContextFor = (
    state: DisplayState,
    update: ProgressUpdate,
): Pick<DisplayState, "parentIssue" | "activeLeaf"> => {
    const details = recordValue(update.details);
    const parentIssue = numberValue(details.parentIssue);
    const activeLeaf = numberValue(details.activeLeaf);
    const leafCompleted = isLeafCompletion(update);
    return {
        ...(parentIssue === undefined
            ? state.parentIssue === undefined
                ? {}
                : { parentIssue: state.parentIssue }
            : { parentIssue }),
        ...(leafCompleted
            ? {}
            : activeLeaf === undefined
              ? state.activeLeaf === undefined
                  ? {}
                  : { activeLeaf: state.activeLeaf }
              : { activeLeaf }),
    };
};

const issueFor = (
    state: DisplayState,
    update: ProgressUpdate,
): DisplayIssue | undefined => {
    const previous = state.issue;
    const incoming = update.issue;
    const current = numberValue(update.current);
    const total = numberValue(update.total);
    if (incoming === undefined) return previous;

    const sameIssue = previous?.number === incoming.number;
    const resolvedCurrent =
        current ?? (sameIssue ? previous?.current : undefined);
    const resolvedTotal = total ?? (sameIssue ? previous?.total : undefined);
    if (resolvedCurrent === undefined || resolvedTotal === undefined) {
        if (!sameIssue || previous === undefined) return previous;
        return { ...previous, title: displayText(incoming.title) };
    }
    return {
        current: resolvedCurrent,
        total: resolvedTotal,
        number: incoming.number,
        title: displayText(incoming.title),
    };
};

const reviewAttemptFor = (
    state: DisplayState,
    update: ProgressUpdate,
): DisplayReviewAttempt | undefined => {
    const previous = state.reviewAttempt;
    const current = numberValue(update.attempt);
    const total = numberValue(update.maxAttempts);
    const issueChanged =
        update.issue !== undefined &&
        state.issue?.number !== update.issue.number;
    if (issueChanged) {
        return current === undefined || total === undefined
            ? undefined
            : { current, total };
    }
    if (current === undefined && total === undefined) return previous;
    const resolvedCurrent = current ?? previous?.current;
    const resolvedTotal = total ?? previous?.total;
    return resolvedCurrent === undefined || resolvedTotal === undefined
        ? previous
        : { current: resolvedCurrent, total: resolvedTotal };
};

const stageStartedAtFor = (
    state: DisplayState,
    update: ProgressUpdate,
    timestamp: number,
): number =>
    state.stage !== update.stage ||
    update.status === "started" ||
    state.stageStartedAt === undefined
        ? timestamp
        : state.stageStartedAt;

export const progressStageLabel = (stage: ProgressStage): string =>
    displayText(PROGRESS_STAGE_LABELS[stage]);

export const activityLabelFor = (
    activity: DisplayActivity,
    detail?: string,
): string => {
    if (activity !== "tool" || detail === undefined) {
        return displayText(DISPLAY_ACTIVITY_LABELS[activity]);
    }
    return nonEmptyDisplayText(`Using ${detail}`, DISPLAY_ACTIVITY_LABELS.tool);
};

export const reduceProgressUpdate = (
    currentState: DisplayState | undefined,
    update: ProgressUpdate | ProgressEvent,
    now?: DisplayClock | DisplayStateOptions,
): DisplayState => {
    const state = normalizedState(currentState ?? makeInitialDisplayState());
    const clock = clockFrom(now);
    const timestamp = timestampFromProgress(update, clock);
    const repository = repositoryFor(state, update);
    const issue = issueFor(state, update);
    const nestedIssueContext = nestedIssueContextFor(state, update);
    const reviewAttempt = isLeafCompletion(update)
        ? undefined
        : reviewAttemptFor(state, update);
    const {
        reviewAttempt: _previousReviewAttempt,
        activeLeaf: _previousActiveLeaf,
        ...stateWithoutAttempt
    } = state;
    const stage = update.stage;
    return {
        ...stateWithoutAttempt,
        ...(repository === undefined ? {} : { repository }),
        ...(issue === undefined ? {} : { issue }),
        ...nestedIssueContext,
        ...(reviewAttempt === undefined ? {} : { reviewAttempt }),
        stage,
        status: update.status,
        activity: "waiting",
        activityLabel: displayText(DISPLAY_ACTIVITY_LABELS.waiting),
        stageStartedAt: stageStartedAtFor(state, update, timestamp),
    };
};

type ActivityChange = {
    readonly activity: DisplayActivity;
    readonly label?: string;
};

const change = (activity: DisplayActivity, label?: string): ActivityChange => ({
    activity,
    ...(label === undefined ? {} : { label }),
});

const messageToolName = (
    event: Extract<PiSessionEvent, { type: "message_update" }>,
): string | undefined =>
    stringValue(
        recordValue(recordValue(event.assistantMessageEvent).toolCall).name,
    );

const messageActivity = (
    event: Extract<PiSessionEvent, { type: "message_update" }>,
): ActivityChange | undefined => {
    const kind = event.assistantMessageEvent.type;
    if (
        kind === "thinking_start" ||
        kind === "thinking_delta" ||
        kind === "thinking_end"
    ) {
        return change("thinking");
    }
    if (kind === "text_start" || kind === "text_delta" || kind === "text_end") {
        return change("responding");
    }
    if (
        kind === "toolcall_start" ||
        kind === "toolcall_delta" ||
        kind === "toolcall_end"
    ) {
        const toolName = messageToolName(event);
        return toolName === undefined
            ? change("tool")
            : change("tool", activityLabelFor("tool", toolName));
    }
    if (kind === "start") return change("thinking");
    if (kind === "done") return change("waiting");
    if (kind === "error") return change("waiting");
    return undefined;
};

const lifecycleActivity = (
    event: PiSessionEvent,
): ActivityChange | undefined => {
    switch (event.type) {
        case "agent_start":
            return change("thinking");
        case "agent_settled":
        case "turn_end":
        case "auto_retry_end":
        case "summarization_retry_finished":
            return change("waiting");
        case "agent_end":
            return event.willRetry ? change("retrying") : change("waiting");
        case "turn_start":
            return change("thinking");
        case "compaction_start":
            return change("compacting");
        case "compaction_end":
            return event.willRetry ? change("retrying") : change("waiting");
        case "auto_retry_start":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
            return change("retrying");
        default:
            return undefined;
    }
};

const piActivity = (event: PiSessionEvent): ActivityChange | undefined => {
    if (event.type === "message_update") return messageActivity(event);
    if (event.type === "tool_execution_start") {
        return change("tool", activityLabelFor("tool", event.toolName));
    }
    if (event.type === "tool_execution_update") {
        return change("tool", activityLabelFor("tool", event.toolName));
    }
    if (event.type === "tool_execution_end") {
        return change("waiting");
    }
    if (event.type === "bash_execution_update") {
        return change("tool", activityLabelFor("tool", "bash"));
    }
    if (event.type === "message_start") {
        return recordValue(event.message).role === "assistant"
            ? change("responding")
            : change("waiting");
    }
    if (event.type === "message_end") return change("waiting");
    return lifecycleActivity(event);
};

export const reducePiSessionEvent = (
    currentState: DisplayState | undefined,
    event: PiSessionEvent,
    context: PiEventContext = { sessionID: "", directory: "" },
    now?: DisplayClock | DisplayStateOptions,
): DisplayState => {
    const state = normalizedState(currentState ?? makeInitialDisplayState());
    const activity = piActivity(event);
    if (activity === undefined) return state;
    const timestamp =
        state.stage === undefined || state.stageStartedAt !== undefined
            ? undefined
            : timestampFromPi(event, context, clockFrom(now));
    return {
        ...state,
        ...(timestamp === undefined ? {} : { stageStartedAt: timestamp }),
        activity: activity.activity,
        activityLabel: nonEmptyDisplayText(
            activity.label ?? DISPLAY_ACTIVITY_LABELS[activity.activity],
            DISPLAY_ACTIVITY_LABELS[activity.activity],
        ),
    };
};

export function updateDisplayState(
    state: DisplayState | undefined,
    update: ProgressUpdate | ProgressEvent,
    now?: DisplayClock | DisplayStateOptions,
): DisplayState;
export function updateDisplayState(
    state: DisplayState | undefined,
    event: PiSessionEvent,
    context: PiEventContext,
    now?: DisplayClock | DisplayStateOptions,
): DisplayState;
export function updateDisplayState(
    state: DisplayState | undefined,
    event: PiSessionEvent,
    now?: DisplayClock | DisplayStateOptions,
): DisplayState;
export function updateDisplayState(
    state: DisplayState | undefined,
    input: ProgressUpdate | ProgressEvent | PiSessionEvent,
    contextOrNow?: PiEventContext | DisplayClock | DisplayStateOptions,
    now?: DisplayClock | DisplayStateOptions,
): DisplayState {
    if ("type" in input) {
        const hasContext =
            typeof contextOrNow === "object" &&
            contextOrNow !== null &&
            "sessionID" in contextOrNow &&
            "directory" in contextOrNow;
        const context = hasContext
            ? (contextOrNow as PiEventContext)
            : undefined;
        const clock = hasContext
            ? now
            : (contextOrNow as DisplayClock | DisplayStateOptions | undefined);
        return reducePiSessionEvent(
            state,
            input,
            context ?? { sessionID: "", directory: "" },
            clock,
        );
    }
    return reduceProgressUpdate(state, input, contextOrNow as DisplayClock);
}

export const reduceDisplayState = updateDisplayState;
export const updateDisplayStateFromProgress = reduceProgressUpdate;
export const updateDisplayStateFromPi = reducePiSessionEvent;