/**
 * The one session event shape shared by every progress adapter.
 *
 * Harness adapters translate their native event streams into these events;
 * the TUI, plain and JSON Lines presentations consume nothing else. The
 * shape is documented as the JSON Lines `agent_event` payload in
 * `docs/operations-and-recovery.md`.
 */

/** Which stream of assistant output a text event belongs to. */
export type SessionTextChannel = "assistant" | "thinking";

/** Token and cost accounting for one assistant message; absent fields are unknown. */
export type SessionUsage = {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
};

export type SessionEvent =
    | {
          readonly type: "session_started";
          /** Name of the harness that runs the session, such as `pi`. */
          readonly harness?: string;
      }
    | { readonly type: "session_finished" }
    | {
          readonly type: "text_delta";
          readonly channel: SessionTextChannel;
          readonly text: string;
      }
    | { readonly type: "text_end"; readonly channel: SessionTextChannel }
    | {
          readonly type: "tool_call";
          readonly toolCallId?: string;
          readonly toolName: string;
          readonly args?: unknown;
      }
    | {
          readonly type: "tool_result";
          readonly toolCallId?: string;
          readonly toolName: string;
          readonly isError: boolean;
          /** Plain text of the result, when it has any. */
          readonly text?: string;
      }
    | { readonly type: "error"; readonly message: string }
    | { readonly type: "usage"; readonly usage: SessionUsage };

export type SessionEventType = SessionEvent["type"];