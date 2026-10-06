import type { z } from "zod";

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

/** The parts a session plays in the workflow. */
export const HARNESS_ROLES = [
    "triager",
    "preflight",
    "implementer",
    "fixer",
    "standards-reviewer",
    "spec-reviewer",
    "resolution-verifier",
    "decomposer",
] as const;

export type HarnessRole = (typeof HARNESS_ROLES)[number];

/** Roles whose sessions edit the checkout and so need an approval mode. */
export const EDITING_ROLES: ReadonlyArray<HarnessRole> = [
    "implementer",
    "fixer",
];

/** Names of the harnesses a configuration may assign to a role. */
export const HARNESS_NAMES = ["claude", "codex", "pi", "opencode"] as const;

export type HarnessName = (typeof HARNESS_NAMES)[number];

/**
 * What a session may do to the working tree.
 *
 * - `read-only`: inspect only; the harness's own read-only mode.
 * - `safe`: edit under the harness's safest unattended mode.
 * - `yolo`: edit with every approval and sandbox check bypassed.
 */
export type SessionAccess = "read-only" | "safe" | "yolo";

/** Everything needed to start, or resume, one harness session. */
export type SessionRequest = {
    readonly role: HarnessRole;
    /** Name of the adapter that runs the session, such as `claude`. */
    readonly harness: string;
    readonly prompt: string;
    readonly directory: string;
    readonly access: SessionAccess;
    /** Hard wall-clock limit for each harness invocation. */
    readonly timeoutMs: number;
    /**
     * Environment overlaid on the live one. A value of `undefined` removes
     * the variable from the session.
     */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly model?: string;
    readonly effort?: string;
    /** Spend cap in US dollars, applied only where the harness has one. */
    readonly maxBudgetUsd?: number;
    /** Human-readable label carried on every event of the session. */
    readonly title?: string;
    /** The harness's own id of an earlier session to continue. */
    readonly resumeSessionID?: string;
    /** Cancels the session; the failure kind is `aborted`. */
    readonly signal?: AbortSignal;
};

/** Why a session ended without a usable result. */
export type HarnessFailureKind =
    /** The harness is not configured, installed or runnable. */
    | "unavailable"
    /** The wall-clock limit passed and the session was killed. */
    | "timeout"
    /** The caller cancelled the session. */
    | "aborted"
    /** The harness exited unsuccessfully without reporting a cause. */
    | "exit"
    /** The model is unknown or unavailable to the user. */
    | "model"
    /** The spend cap was reached. */
    | "budget"
    /** The harness did not grant the requested access mode. */
    | "access"
    /**
     * A rate, usage, session or quota limit, an overloaded provider or an
     * unreachable network. It clears by itself and says nothing about the
     * issue.
     */
    | "transient"
    /** Credentials are missing or expired; only the operator can fix this. */
    | "auth"
    /** The harness itself reported an error. */
    | "harness"
    /** The structured result stayed invalid after every correction. */
    | "invalid_result";

export type HarnessFailure = {
    readonly kind: HarnessFailureKind;
    readonly message: string;
    /** Resumable id of the session, when the harness reported one. */
    readonly harnessSessionID?: string;
    /** When a `transient` limit clears, as the harness worded it. */
    readonly resetHint?: string;
};

export type HarnessCapabilities = {
    /** The harness validates results against a JSON Schema it is given. */
    readonly nativeSchema: boolean;
    /** The harness enforces `maxBudgetUsd`. */
    readonly budgetCap: boolean;
};

/** A harness-neutral JSON Schema document. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Events an adapter reports; the service adds started, finished and error. */
export type TurnEvent = Exclude<
    SessionEvent,
    { readonly type: "session_started" | "session_finished" | "error" }
>;

/** One harness invocation: a new session, or a resumed one. */
export type TurnRequest = Omit<SessionRequest, "role" | "harness" | "title"> & {
    /** Set only when the adapter declares native schema output. */
    readonly jsonSchema?: JsonSchema;
    readonly onEvent: (event: TurnEvent) => void;
};

export type TurnOutcome =
    | {
          readonly ok: true;
          readonly harnessSessionID: string | undefined;
          /** The assistant's final message. */
          readonly text: string;
          /** The harness's native structured output, when it produced one. */
          readonly structured?: unknown;
      }
    | { readonly ok: false; readonly failure: HarnessFailure };

/**
 * One harness the service can drive.
 *
 * An adapter turns a {@link TurnRequest} into the harness's command line,
 * runs it through the process port, normalizes the native event stream and
 * detects failure. It never retries and never validates result contracts.
 */
export type HarnessAdapter = {
    readonly name: string;
    readonly capabilities: HarnessCapabilities;
    readonly runTurn: (turn: TurnRequest) => Promise<TurnOutcome>;
};

/** A session that must end in a value matching `resultSchema`. */
export type StructuredSessionRequest<T> = SessionRequest & {
    readonly resultSchema: z.ZodType<T>;
};

export type HarnessOutcome<T> =
    | {
          readonly ok: true;
          /** Resumable id for a follow-up session in the same harness. */
          readonly harnessSessionID: string | undefined;
          readonly text: string;
          readonly value: T;
      }
    | { readonly ok: false; readonly failure: HarnessFailure };

/**
 * Inbound port for running sessions.
 *
 * With a `resultSchema` the outcome carries the validated value, or a typed
 * failure. Without one it carries the final text. Prose never counts as a
 * structured result.
 */
export type HarnessService = {
    readonly run: {
        <T>(request: StructuredSessionRequest<T>): Promise<HarnessOutcome<T>>;
        (request: SessionRequest): Promise<HarnessOutcome<undefined>>;
    };
};

/** Outcome of one startup probe. */
export type ProbeResult =
    | { readonly ok: true; readonly warning?: string }
    | { readonly ok: false; readonly message: string };

/**
 * Outbound port for the checks Ralphie runs before any work starts. Probes
 * are cheap and bounded: they never begin a model turn.
 */
export type HarnessProbe = {
    /** What the named harness's adapter supports, if it is known. */
    readonly capabilities: (name: string) => HarnessCapabilities | undefined;
    /** The harness's executable starts. */
    readonly installed: (name: string) => Promise<ProbeResult>;
    /** The harness grants its `safe` editing access mode. */
    readonly safeAccess: (name: string) => Promise<ProbeResult>;
};

/** An empty directory that lives for one session. */
export type ScratchDirectory = {
    readonly path: string;
    readonly remove: () => Promise<void>;
};

export type ScratchDirectoryProvider = {
    readonly create: () => Promise<ScratchDirectory>;
};

/** A digest of the tracked, staged and untracked state of a checkout. */
export type WorkingTreeFingerprint = (
    directory: string,
    signal?: AbortSignal,
) => Promise<string>;