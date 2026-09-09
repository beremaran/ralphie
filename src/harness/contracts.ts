/**
 * Provider-neutral boundary for agent harnesses.
 *
 * This module deliberately contains no provider types. Adapters own discovery,
 * validation, and translation of native protocol values.
 */

import type { AgentModel } from "../agent/model.ts";

export type { AgentModel, AgentSelection } from "../agent/model.ts";

/** Profiles describe workflow intent; adapters map them to native values. */
export const AgentSessionProfile = {
    Default: "default",
    Review: "review",
} as const;

export type AgentSessionProfile =
    (typeof AgentSessionProfile)[keyof typeof AgentSessionProfile];

export const AGENT_REVIEW_SESSION_PROFILE = AgentSessionProfile.Review;

export type AgentAssistantError = {
    readonly name: string;
    readonly data?: {
        readonly message?: string;
        readonly retries?: number;
    };
};

export type AgentAssistantMessage = {
    readonly id: string;
    readonly role: "assistant";
    readonly error?: AgentAssistantError;
    readonly structured?: unknown;
    readonly text?: string;
    readonly [key: string]: unknown;
};

export type AgentPart = {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
};

/** Native event payloads stay opaque to shared presentation code. */
export type AgentSessionEvent = any;

export type AgentEventContext = {
    readonly sessionID: string;
    readonly directory: string;
    readonly title?: string;
};

export type AgentEventListener = (
    event: AgentSessionEvent,
    context: AgentEventContext,
) => void;

export type AgentSessionCreateInput = {
    readonly directory: string;
    readonly title?: string;
    readonly agent?: string;
    readonly model?:
        | AgentModel
        | {
              readonly providerID: string;
              readonly id: string;
          };
    readonly variant?: string;
    readonly profile?: AgentSessionProfile;
};

export type AgentPromptFormat = {
    readonly type: "json_schema";
    readonly schema: unknown;
    readonly retryCount?: number;
    readonly validate?: (value: unknown) => {
        readonly success: boolean;
        readonly error?: string;
    };
};

export type AgentPromptInput = {
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: AgentModel;
    readonly variant?: string;
    readonly profile?: AgentSessionProfile;
    readonly parts: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
    }>;
    readonly format?: AgentPromptFormat;
};

export type AgentApiResult<Result> = {
    readonly data?: Result;
    readonly error?: unknown;
};

/** Compatibility client shape shared by workflow code and harness adapters. */
export type AgentClient = {
    readonly session: {
        readonly create: (
            input: AgentSessionCreateInput,
            options?: { readonly signal?: AbortSignal },
        ) => Promise<
            AgentApiResult<{
                readonly id: string;
            }>
        >;
        readonly prompt: (
            input: AgentPromptInput,
            options?: { readonly signal?: AbortSignal },
        ) => Promise<
            AgentApiResult<{
                readonly info: AgentAssistantMessage;
                readonly parts: ReadonlyArray<AgentPart>;
                readonly needsAttention?: unknown;
            }>
        >;
    };
    readonly close?: () => void;
};

export const HARNESS_KINDS = [
    "opencode",
    "codex",
    "claude-code",
    "cursor",
    "grok-build",
    "google-antigravity",
] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Operations whose support can differ between harnesses. */
export type HarnessCapability =
    | "resume"
    | "structured-output"
    | "model-catalog"
    | "variants"
    | "events"
    | "permissions";

/** A false capability means the adapter must not emulate that operation. */
export type HarnessCapabilities = Readonly<Record<HarnessCapability, boolean>>;

/** Model and variant values belong to the adapter, not to orchestration. */
export type HarnessSelection = {
    readonly model?: unknown;
    readonly variant?: unknown;
};

export type HarnessProbeInput = {
    readonly directory?: string;
    readonly signal?: AbortSignal;
};

export type HarnessStatus = {
    readonly kind: HarnessKind;
    readonly available: boolean;
    readonly authenticated: boolean;
    readonly version?: string;
    readonly message?: string;
};

export type HarnessProbe = (
    input?: HarnessProbeInput,
) => Promise<HarnessStatus>;

export type HarnessEvent = {
    readonly type: string;
    readonly [key: string]: unknown;
};

export type HarnessTurnFormat = {
    readonly type: "json_schema";
    readonly schema: unknown;
    readonly retryCount?: number;
};

export type HarnessTurnInput = HarnessSelection & {
    readonly prompt: string;
    readonly format?: HarnessTurnFormat;
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: HarnessEvent) => void;
};

export type HarnessTurnResult = {
    readonly text?: string;
    readonly structured?: unknown;
    readonly events?: ReadonlyArray<HarnessEvent>;
    readonly resumeCursor?: string;
};

export type HarnessSessionInput = HarnessSelection & {
    readonly directory: string;
    readonly title?: string;
    readonly signal?: AbortSignal;
};

export type HarnessSessionReference = {
    readonly sessionID: string;
    readonly resumeCursor?: string;
};

export type HarnessResumeInput = HarnessSessionReference & {
    readonly directory?: string;
    readonly signal?: AbortSignal;
};

export type HarnessSession = HarnessSessionReference & {
    readonly kind: HarnessKind;
    readonly sendTurn: (input: HarnessTurnInput) => Promise<HarnessTurnResult>;
    readonly interrupt: () => Promise<void>;
    readonly close: () => Promise<void>;
};

export type HarnessDriver = {
    readonly kind: HarnessKind;
    readonly capabilities: HarnessCapabilities;
    readonly probe: HarnessProbe;
    /** Adapters validate opaque model and variant values here. */
    readonly validateSelection: (
        selection: HarnessSelection,
        signal?: AbortSignal,
    ) => Promise<void>;
    readonly createSession: (
        input: HarnessSessionInput,
    ) => Promise<HarnessSession>;
    /** Absent when `capabilities.resume` is false. */
    readonly resumeSession?: (
        input: HarnessResumeInput,
    ) => Promise<HarnessSession>;
};

export type HarnessFactoryInput = {
    readonly kind: HarnessKind;
    /** Provider-specific setup is passed through to the selected adapter. */
    readonly config?: unknown;
    readonly signal?: AbortSignal;
};

export type HarnessDriverFactory = (
    input: HarnessFactoryInput,
) => Promise<HarnessDriver>;

export type HarnessFactory = {
    readonly create: HarnessDriverFactory;
};