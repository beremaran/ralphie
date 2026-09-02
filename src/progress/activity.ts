import type { PiSessionEvent } from "../pi/client.ts";
import {
    redactSensitiveText,
    redactSensitiveValue,
    stripTerminalControls,
} from "../shared/redaction.ts";
import { green, red, yellow } from "./colors.ts";
import { PROGRESS_STAGE_LABELS } from "./display-state.ts";
import type { ProgressStatus, ProgressUpdate } from "./progress.ts";

/**
 * Rendering-independent activity view contract.
 *
 * Tracks recent operations (tool calls, shell commands, reads/searches,
 * thinking, lifecycle work, and workflow progress) in a bounded registry
 * keyed by operation id, so repeated updates replace the same operation
 * instead of appending rows. The formatter emits one-line rows (operation
 * label, clipped target, status) and bounded snapshots of at most three
 * physical rows. Assistant response text and lossless JSON events never
 * enter the state: only sanitized, bounded labels, targets, and details.
 */

export type ActivityKind =
    | "tool"
    | "shell"
    | "read"
    | "thinking"
    | "lifecycle"
    | "progress";

export type ActivityStatus = "running" | "succeeded" | "failed";

export type ActivityClock = () => number;

/** One tracked operation in the activity registry. */
export type ActivityOperation = {
    /** Stable key; repeated updates with the same id replace this operation. */
    readonly id: string;
    readonly kind: ActivityKind;
    /** Sanitized one-line operation label (e.g. "bash", "read", "Thinking"). */
    readonly label: string;
    /** Sanitized one-line target text; empty when there is nothing to name. */
    readonly target: string;
    readonly status: ActivityStatus;
    /** Bounded failure detail; never set for success rows. */
    readonly detail?: string;
    /** Creation order within the registry (stable tie-break for sorting). */
    readonly order: number;
    /** Epoch milliseconds of the most recent update (recency ordering). */
    readonly updatedAt: number;
};

/** Bounded, rendering-independent activity registry. */
export type ActivityState = {
    readonly operations: readonly ActivityOperation[];
    readonly nextOrder: number;
    readonly maxOperations: number;
};

export type ActivityStateOptions = {
    readonly maxOperations?: number;
};

/** Generic upsert input; callers own the id so rows replace instead of append. */
export type ActivityUpdate = {
    readonly id: string;
    readonly kind: ActivityKind;
    readonly label: string;
    readonly target?: string;
    readonly status: ActivityStatus;
    readonly detail?: string;
};

export type ActivityRenderOptions = {
    /** Terminal columns the row must fit into. Default 80. */
    readonly width?: number;
    /** Wrap each row in its status color after clipping. Default false. */
    readonly colors?: boolean;
    /** Maximum rows in a snapshot. Default {@link ACTIVITY_SNAPSHOT_ROWS}. */
    readonly maxRows?: number;
};

/** Snapshots render at most three physical rows. */
export const ACTIVITY_SNAPSHOT_ROWS = 3;
/** Registry retains at most this many operations before evicting the oldest settled one. */
export const ACTIVITY_REGISTRY_LIMIT = 12;
/** Failure details are capped at this many characters when stored. */
export const MAX_FAILURE_DETAIL_LENGTH = 60;

const SHORT_JSON_LIMIT = 80;
const THINKING_OPERATION_ID = "thinking";

const defaultClock: ActivityClock = () => Date.now();

export const createActivityState = (
    options: ActivityStateOptions = {},
): ActivityState => ({
    operations: [],
    nextOrder: 0,
    maxOperations: Math.max(
        1,
        options.maxOperations ?? ACTIVITY_REGISTRY_LIMIT,
    ),
});

export const findActivityOperation = (
    state: ActivityState,
    id: string,
): ActivityOperation | undefined => state.operations.find((op) => op.id === id);

/** Same redaction boundary as progress and transcript rendering. */
const sanitizeText = (text: string): string =>
    redactSensitiveText(
        stripTerminalControls(text).replace(/\s+/g, " ").trim(),
    );

const boundDetail = (detail: string): string => {
    const clean = sanitizeText(detail);
    const characters = Array.from(clean);
    return characters.length <= MAX_FAILURE_DETAIL_LENGTH
        ? clean
        : `${characters.slice(0, MAX_FAILURE_DETAIL_LENGTH).join("")}…`;
};

const clipToWidth = (text: string, width: number): string => {
    const available = Math.max(1, width);
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

const recordValue = (
    value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const evictOldest = (
    operations: readonly ActivityOperation[],
    keep: ActivityOperation,
): readonly ActivityOperation[] => {
    const others = operations.filter((op) => op.id !== keep.id);
    if (others.length === 0) return operations;
    const oldestSettled = others
        .filter((op) => op.status !== "running")
        .sort((a, b) => a.updatedAt - b.updatedAt || a.order - b.order);
    const victim =
        oldestSettled[0] ??
        others.sort(
            (a, b) => a.updatedAt - b.updatedAt || a.order - b.order,
        )[0];
    return victim === undefined
        ? operations
        : operations.filter((op) => op.id !== victim.id);
};

const upsert = (
    state: ActivityState,
    update: ActivityUpdate,
    now: ActivityClock,
): ActivityState => {
    const timestamp = now();
    const existingIndex = state.operations.findIndex(
        (op) => op.id === update.id,
    );
    const operation: ActivityOperation = {
        id: update.id,
        kind: update.kind,
        label: sanitizeText(update.label) || "working",
        target: sanitizeText(update.target ?? ""),
        status: update.status,
        ...(update.detail === undefined
            ? {}
            : { detail: boundDetail(update.detail) }),
        order:
            existingIndex >= 0
                ? (state.operations[existingIndex]?.order ?? state.nextOrder)
                : state.nextOrder,
        updatedAt: timestamp,
    };
    let operations: readonly ActivityOperation[];
    if (existingIndex >= 0) {
        operations = state.operations.map((op, index) =>
            index === existingIndex ? operation : op,
        );
    } else {
        operations = [...state.operations, operation];
        if (operations.length > state.maxOperations) {
            operations = evictOldest(operations, operation);
        }
    }
    return {
        operations,
        nextOrder: existingIndex >= 0 ? state.nextOrder : state.nextOrder + 1,
        maxOperations: state.maxOperations,
    };
};

export const reduceActivityUpdate = (
    state: ActivityState | undefined,
    update: ActivityUpdate,
    now: ActivityClock = defaultClock,
): ActivityState => upsert(state ?? createActivityState(), update, now);

/** Categorize a tool by name for the activity view. */
export const activityKindForTool = (toolName: string): ActivityKind => {
    switch (toolName) {
        case "bash":
            return "shell";
        case "read":
        case "grep":
        case "find":
        case "ls":
            return "read";
        default:
            return "tool";
    }
};

const shortJson = (value: unknown): string => {
    let text: string;
    try {
        text = JSON.stringify(redactSensitiveValue(value)) ?? "";
    } catch {
        return "[unserializable]";
    }
    if (text.length <= SHORT_JSON_LIMIT) return text;
    return `${Array.from(text).slice(0, SHORT_JSON_LIMIT).join("")}…`;
};

const pathTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
): string | undefined =>
    stringValue(record?.file_path) ?? stringValue(record?.path);

const readTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
): string => {
    const path = pathTarget(record);
    if (path === undefined) return "";
    const offset = numberValue(record?.offset);
    const limit = numberValue(record?.limit);
    const start = offset ?? 1;
    const range =
        offset === undefined && limit === undefined
            ? ""
            : `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
    return `${path}${range}`;
};

const writeTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
): string => {
    const path = pathTarget(record);
    if (path === undefined) return "";
    const content = stringValue(record?.content);
    const lines = content === undefined ? 0 : content.split("\n").length;
    return lines > 1 ? `${path} (${lines} lines)` : path;
};

const findTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
): string => {
    const pattern = stringValue(record?.pattern) ?? "*";
    return `${pattern} in ${pathTarget(record) ?? "."}`;
};

const grepTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
): string => {
    const pattern = stringValue(record?.pattern) ?? "";
    const path = pathTarget(record) ?? ".";
    return pattern === "" ? path : `/${pattern}/ in ${path}`;
};

const fallbackToolTarget = (
    record: Readonly<Record<string, unknown>> | undefined,
    args: unknown,
): string => {
    const preferred = [
        "file_path",
        "path",
        "command",
        "pattern",
        "filename",
        "query",
        "url",
    ]
        .map((key) => stringValue(record?.[key]))
        .find((value) => value !== undefined && value !== "");
    return preferred ?? shortJson(args);
};

const KNOWN_TOOL_TARGETS: Readonly<
    Record<
        string,
        (record: Readonly<Record<string, unknown>> | undefined) => string
    >
> = {
    bash: (record) => stringValue(record?.command) ?? "",
    read: readTarget,
    write: writeTarget,
    edit: (record) => pathTarget(record) ?? "",
    ls: (record) => pathTarget(record) ?? ".",
    find: findTarget,
    grep: grepTarget,
};

/** Derive the clipped-at-render target text for a tool call. */
export const activityTargetForTool = (
    toolName: string,
    args: unknown,
): string => {
    const record = recordValue(args);
    const formatter = KNOWN_TOOL_TARGETS[toolName];
    return formatter === undefined
        ? fallbackToolTarget(record, args)
        : formatter(record);
};

const resultText = (result: unknown): string | undefined => {
    if (typeof result === "string") return result;
    const record = recordValue(result);
    if (record === undefined) return undefined;
    const content = record.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts = content
            .map((part) => {
                const entry = recordValue(part);
                return entry?.type === "text"
                    ? stringValue(entry.text)
                    : undefined;
            })
            .filter((part): part is string => part !== undefined);
        return parts.join(" ");
    }
    return stringValue(record.error);
};

const failureDetail = (result: unknown): string | undefined => {
    const text = resultText(result);
    return text === undefined || text === "" ? undefined : text;
};

const toolCallFromMessageUpdate = (
    event: Extract<PiSessionEvent, { type: "message_update" }>,
):
    | { readonly id?: string; readonly name?: string; readonly args?: unknown }
    | undefined => {
    const view = recordValue(event.assistantMessageEvent);
    const direct = recordValue(view?.toolCall);
    if (direct !== undefined) {
        return {
            id: stringValue(direct.id),
            name: stringValue(direct.name),
            args: (direct as { readonly arguments?: unknown }).arguments,
        };
    }
    const content = recordValue(view?.partial)?.content;
    if (!Array.isArray(content)) return undefined;
    const contentIndex = numberValue(view?.contentIndex);
    const atIndex =
        contentIndex === undefined
            ? undefined
            : recordValue(content[contentIndex]);
    const part =
        atIndex?.type === "toolCall"
            ? atIndex
            : content
                  .map(recordValue)
                  .find((entry) => entry?.type === "toolCall");
    if (part === undefined) return undefined;
    return {
        id: stringValue(part.id),
        name: stringValue(part.name),
        args: (part as { readonly arguments?: unknown }).arguments,
    };
};

const reduceMessageUpdate = (
    state: ActivityState,
    event: Extract<PiSessionEvent, { type: "message_update" }>,
    now: ActivityClock,
): ActivityState => {
    const view = recordValue(event.assistantMessageEvent);
    const kind = stringValue(view?.type);
    if (kind === "thinking_start" || kind === "thinking_delta") {
        return upsert(
            state,
            {
                id: THINKING_OPERATION_ID,
                kind: "thinking",
                label: "Thinking",
                status: "running",
            },
            now,
        );
    }
    if (kind === "thinking_end") {
        return upsert(
            state,
            {
                id: THINKING_OPERATION_ID,
                kind: "thinking",
                label: "Thinking",
                status: "succeeded",
            },
            now,
        );
    }
    if (
        kind === "toolcall_start" ||
        kind === "toolcall_delta" ||
        kind === "toolcall_end"
    ) {
        const toolCall = toolCallFromMessageUpdate(event);
        if (toolCall === undefined || toolCall.id === undefined) return state;
        const name = toolCall.name ?? "tool";
        return upsert(
            state,
            {
                id: toolCall.id,
                kind: activityKindForTool(name),
                label: name,
                target: activityTargetForTool(name, toolCall.args),
                status: "running",
            },
            now,
        );
    }
    return state;
};

const reduceToolExecution = (
    state: ActivityState,
    event:
        | Extract<PiSessionEvent, { type: "tool_execution_start" }>
        | Extract<PiSessionEvent, { type: "tool_execution_update" }>
        | Extract<PiSessionEvent, { type: "tool_execution_end" }>,
    now: ActivityClock,
): ActivityState => {
    const name = event.toolName || "tool";
    if (event.type === "tool_execution_end") {
        const existing = findActivityOperation(state, event.toolCallId);
        return upsert(
            state,
            {
                id: event.toolCallId,
                kind: existing?.kind ?? activityKindForTool(name),
                label: existing?.label ?? name,
                target: existing?.target ?? "",
                status: event.isError ? "failed" : "succeeded",
                ...(event.isError
                    ? { detail: failureDetail(event.result) }
                    : {}),
            },
            now,
        );
    }
    const update: ActivityUpdate = {
        id: event.toolCallId,
        kind: activityKindForTool(name),
        label: name,
        target: activityTargetForTool(name, event.args),
        status: "running",
    };
    return upsert(state, update, now);
};

const reduceBashUpdate = (
    state: ActivityState,
    event: Extract<PiSessionEvent, { type: "bash_execution_update" }>,
    now: ActivityClock,
): ActivityState =>
    upsert(
        state,
        {
            id: `bash:${event.id ?? "bash"}`,
            kind: "shell",
            label: "bash",
            status: "running",
        },
        now,
    );

const lifecycleAgentAndTurn = (
    state: ActivityState,
    event: PiSessionEvent,
    now: ActivityClock,
): ActivityState => {
    switch (event.type) {
        case "agent_start":
            return upsert(
                state,
                {
                    id: "agent",
                    kind: "lifecycle",
                    label: "Agent",
                    status: "running",
                },
                now,
            );
        case "agent_end":
            return upsert(
                state,
                {
                    id: "agent",
                    kind: "lifecycle",
                    label: "Agent",
                    status: event.willRetry ? "failed" : "succeeded",
                    ...(event.willRetry ? { detail: "will retry" } : {}),
                },
                now,
            );
        case "agent_settled":
            return upsert(
                state,
                {
                    id: "agent",
                    kind: "lifecycle",
                    label: "Agent",
                    status: "succeeded",
                },
                now,
            );
        case "turn_start":
            return upsert(
                state,
                {
                    id: "turn",
                    kind: "lifecycle",
                    label: "Turn",
                    status: "running",
                },
                now,
            );
        case "turn_end":
            return upsert(
                state,
                {
                    id: "turn",
                    kind: "lifecycle",
                    label: "Turn",
                    status: "succeeded",
                },
                now,
            );
        default:
            return state;
    }
};

const lifecycleCompaction = (
    state: ActivityState,
    event: PiSessionEvent,
    now: ActivityClock,
): ActivityState => {
    switch (event.type) {
        case "compaction_start":
            return upsert(
                state,
                {
                    id: "compaction",
                    kind: "lifecycle",
                    label: "Compacting context",
                    target: event.reason,
                    status: "running",
                },
                now,
            );
        case "compaction_end":
            return upsert(
                state,
                {
                    id: "compaction",
                    kind: "lifecycle",
                    label: "Compacting context",
                    status:
                        event.aborted || event.errorMessage !== undefined
                            ? "failed"
                            : "succeeded",
                    ...(event.aborted
                        ? { detail: "aborted" }
                        : event.errorMessage === undefined
                          ? {}
                          : { detail: event.errorMessage }),
                },
                now,
            );
        default:
            return state;
    }
};

const lifecycleRetry = (
    state: ActivityState,
    event: PiSessionEvent,
    now: ActivityClock,
): ActivityState => {
    switch (event.type) {
        case "auto_retry_start":
            return upsert(
                state,
                {
                    id: "retry",
                    kind: "lifecycle",
                    label: "Retrying Pi request",
                    target: `attempt ${event.attempt}/${event.maxAttempts}`,
                    status: "running",
                },
                now,
            );
        case "auto_retry_end":
            return upsert(
                state,
                {
                    id: "retry",
                    kind: "lifecycle",
                    label: "Retrying Pi request",
                    status: event.success ? "succeeded" : "failed",
                    ...(event.success || event.finalError === undefined
                        ? {}
                        : { detail: event.finalError }),
                },
                now,
            );
        case "summarization_retry_scheduled":
            return upsert(
                state,
                {
                    id: "context-summary",
                    kind: "lifecycle",
                    label: "Retrying context summary",
                    target: `attempt ${event.attempt}/${event.maxAttempts}`,
                    status: "running",
                },
                now,
            );
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
            return upsert(
                state,
                {
                    id: "context-summary",
                    kind: "lifecycle",
                    label: "Retrying context summary",
                    status:
                        event.type === "summarization_retry_finished"
                            ? "succeeded"
                            : "running",
                },
                now,
            );
        default:
            return state;
    }
};

const reduceLifecycleEvent = (
    state: ActivityState,
    event: PiSessionEvent,
    now: ActivityClock,
): ActivityState => {
    switch (event.type) {
        case "agent_start":
        case "agent_end":
        case "agent_settled":
        case "turn_start":
        case "turn_end":
            return lifecycleAgentAndTurn(state, event, now);
        case "compaction_start":
        case "compaction_end":
            return lifecycleCompaction(state, event, now);
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
            return lifecycleRetry(state, event, now);
        default:
            return state;
    }
};

/**
 * Reduce a Pi session event into the activity registry.
 *
 * Tool calls are keyed by their call id, bash streams by their execution id,
 * and thinking/lifecycle work by a stable per-operation id, so repeated
 * updates replace the same row. Assistant response text (text deltas) and
 * lossless event payloads are deliberately ignored.
 */
export const reduceActivityEvent = (
    state: ActivityState | undefined,
    event: PiSessionEvent,
    now: ActivityClock = defaultClock,
): ActivityState => {
    const base = state ?? createActivityState();
    switch (event.type) {
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
            return reduceToolExecution(base, event, now);
        case "bash_execution_update":
            return reduceBashUpdate(base, event, now);
        case "message_update":
            return reduceMessageUpdate(base, event, now);
        case "agent_start":
        case "agent_end":
        case "agent_settled":
        case "turn_start":
        case "turn_end":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
            return reduceLifecycleEvent(base, event, now);
        default:
            return base;
    }
};

const progressStatus = (status: ProgressStatus): ActivityStatus => {
    switch (status) {
        case "started":
            return "running";
        case "failed":
        case "needs-attention":
            return "failed";
        default:
            return "succeeded";
    }
};

/** Map a workflow progress update onto the activity view as a "progress" row. */
export const updateActivityFromProgress = (
    state: ActivityState | undefined,
    update: ProgressUpdate,
    now: ActivityClock = defaultClock,
): ActivityState => {
    const id = `${update.stage}:${update.issue?.number ?? ""}:${update.attempt ?? ""}`;
    const status = progressStatus(update.status);
    return reduceActivityUpdate(
        state,
        {
            id,
            kind: "progress",
            label: PROGRESS_STAGE_LABELS[update.stage] ?? update.stage,
            target: status === "running" ? update.message : "",
            status,
            ...(status === "failed" ? { detail: update.message } : {}),
        },
        now,
    );
};

const statusSymbol = (status: ActivityStatus): string => {
    switch (status) {
        case "running":
            return "◐";
        case "succeeded":
            return "✓";
        case "failed":
            return "✗";
    }
};

const statusColor = (status: ActivityStatus, text: string): string => {
    switch (status) {
        case "running":
            return yellow(text);
        case "succeeded":
            return green(text);
        case "failed":
            return red(text);
    }
};

const operationText = (operation: ActivityOperation): string => {
    const segments = [operation.label];
    if (operation.target !== "") segments.push(operation.target);
    if (operation.status === "failed" && operation.detail !== undefined) {
        segments.push(`— ${operation.detail}`);
    }
    return segments.join(" ");
};

const resolvedWidth = (width: number | undefined): number => {
    const value = width ?? 80;
    const floored = Math.floor(value);
    return Number.isFinite(floored) ? Math.max(1, floored) : 80;
};

const resolvedMaxRows = (maxRows: number | undefined): number => {
    const value = maxRows ?? ACTIVITY_SNAPSHOT_ROWS;
    const floored = Math.floor(value);
    return Number.isFinite(floored)
        ? Math.max(1, floored)
        : ACTIVITY_SNAPSHOT_ROWS;
};

/** Render one operation as a single physical row: label, clipped target, status. */
export const formatActivityOperation = (
    operation: ActivityOperation,
    options: ActivityRenderOptions = {},
): string => {
    const width = resolvedWidth(options.width);
    const text = `${statusSymbol(operation.status)} ${operationText(operation)}`;
    const clipped = clipToWidth(text, width);
    return options.colors === true
        ? statusColor(operation.status, clipped)
        : clipped;
};

/** Select which operations a snapshot shows: running first, then recent settled. */
export const activitySnapshotOperations = (
    state: ActivityState,
    maxRows: number = ACTIVITY_SNAPSHOT_ROWS,
): readonly ActivityOperation[] => {
    const rows = Math.max(1, maxRows);
    const byRecency = (a: ActivityOperation, b: ActivityOperation): number =>
        b.updatedAt - a.updatedAt || b.order - a.order;
    const running = state.operations
        .filter((op) => op.status === "running")
        .sort(byRecency);
    const settled = state.operations
        .filter((op) => op.status !== "running")
        .sort(byRecency);
    return [...running, ...settled].slice(0, rows);
};

/** Render at most {@link ACTIVITY_SNAPSHOT_ROWS} one-line rows for the state. */
export const renderActivitySnapshot = (
    state: ActivityState,
    options: ActivityRenderOptions = {},
): readonly string[] =>
    activitySnapshotOperations(state, resolvedMaxRows(options.maxRows)).map(
        (operation) => formatActivityOperation(operation, options),
    );