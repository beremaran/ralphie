/**
 * Provider-neutral harness boundary.
 *
 * Every harness adapter translates its native event stream into the one
 * session event shape defined here. Progress output (interactive, plain and
 * JSON Lines) consumes only these types, so it never depends on which harness
 * ran a session. This module deliberately contains no vendor or process types.
 */

/** Identifies the session an event belongs to. */
export type SessionEventContext = {
    /** Ralphie's id for the session. */
    readonly sessionID: string;
    /** Working directory the session runs in. */
    readonly directory: string;
    /** Name of the harness running the session, such as `pi`. */
    readonly harness: string;
    /** Human-readable label for the session, such as its task. */
    readonly title?: string;
};

/** The session began producing work. */
type SessionStarted = {
    readonly type: "session_started";
};

/** The session stopped producing work; failures arrive as `error` events. */
type SessionFinished = {
    readonly type: "session_finished";
};

/**
 * A fragment of assistant output.
 *
 * Fragments of one `kind` concatenate into a block until a fragment arrives
 * with `done: true`, which closes the block. A harness that reports whole
 * blocks sends one fragment with `done: true`; a streaming harness may close
 * the block with an empty fragment. `text` is never the accumulated block.
 */
type AssistantText = {
    readonly type: "assistant_text";
    readonly kind: "text" | "thinking";
    readonly text: string;
    readonly done: boolean;
};

/** The assistant started a tool. */
type ToolCall = {
    readonly type: "tool_call";
    /** Pairs the call with its `tool_result`. */
    readonly callId: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
};

/** A tool finished; `output` is its text rendering, empty when it has none. */
type ToolResult = {
    readonly type: "tool_result";
    readonly callId: string;
    readonly name: string;
    readonly output: string;
    readonly isError: boolean;
};

/** The harness or model reported a failure. */
type SessionError = {
    readonly type: "error";
    readonly message: string;
};

/**
 * Tokens, and cost where the harness reports it, consumed since the session's
 * previous `usage` event. Consumers sum the events; none is a running total.
 */
type SessionUsage = {
    readonly type: "usage";
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly costUsd?: number;
};

export type SessionEvent =
    | SessionStarted
    | SessionFinished
    | AssistantText
    | ToolCall
    | ToolResult
    | SessionError
    | SessionUsage;

export type SessionEventListener = (
    event: SessionEvent,
    context: SessionEventContext,
) => void;