/**
 * Provider-neutral agent session boundary.
 *
 * This module deliberately contains no provider types. The pi implementation
 * under `src/pi/` owns model resolution, tool policy, and event translation.
 */

import type { AgentModel } from "./model.ts";

export type { AgentModel, AgentSelection } from "./model.ts";

/** Profiles describe workflow intent; the runtime maps them to native behavior. */
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

/** Compatibility client shape shared by workflow code and the pi adapter. */
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
    readonly close?: () => void | Promise<void>;
};