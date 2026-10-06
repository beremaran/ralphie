import { z } from "zod";

import type { HarnessRole } from "../harness/ports.ts";
import {
    type ProgressStage,
    type ProgressIssue,
    type ProgressReporterService,
} from "../progress/ports.ts";
import { RalphieError } from "../shared/error.ts";
import {
    type AgentSessions,
    sessionFailure,
    sessionIdFor,
    sessionRequest,
} from "./sessions.ts";

export type AgentRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type AgentRepositoryInvariantVerifier = (
    repositoryPath: string,
    expected: AgentRepositoryInvariant,
    signal?: AbortSignal,
) => Promise<void>;

export type AgentTaskRequest = {
    readonly role: HarnessRole;
    readonly directory: string;
    readonly title: string;
    readonly prompt: string;
    readonly resumeSessionID?: string;
    readonly signal?: AbortSignal;
    readonly repositoryInvariant?: AgentRepositoryInvariant;
    readonly verifyRepositoryInvariant?: AgentRepositoryInvariantVerifier;
    readonly verifyAfter?: (signal?: AbortSignal) => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export const HAND_OFF_REASONS = [
    "outdated_premise",
    "conflicting_requirements",
    "missing_information",
    "external_dependency",
    "cannot_reproduce",
] as const;

export type HandOffReasonValue = (typeof HAND_OFF_REASONS)[number];

export const HAND_OFF_MESSAGE_LIMIT = 2_000;

/** A bounded request to defer work; this is not a final workflow decision. */
export const handOffRequestSchema = z
    .object({
        reason: z.enum(HAND_OFF_REASONS),
        message: z
            .string()
            .min(1)
            .max(HAND_OFF_MESSAGE_LIMIT)
            .refine((value) => value.trim().length > 0, {
                message: "Expected a non-blank message.",
            })
            .optional(),
    })
    .strict();

export type HandOffRequest = z.infer<typeof handOffRequestSchema>;

export type AgentTaskResult = {
    readonly sessionID: string;
    readonly text: string;
};

const causeMessage = (error: RalphieError): string | undefined => {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
        if (cause instanceof Error && cause.message !== error.message) {
            return cause.message;
        }
        if (
            typeof cause !== "object" ||
            cause === null ||
            !("cause" in cause)
        ) {
            return undefined;
        }
        cause = (cause as { readonly cause?: unknown }).cause;
    }
    return undefined;
};

export const reportAgentFailure = async (
    request: {
        readonly directory: string;
        readonly title: string;
        readonly progress?: ProgressReporterService;
        readonly progressStage?: ProgressStage;
        readonly progressIssue?: ProgressIssue;
    },
    error: RalphieError,
): Promise<void> => {
    if (request.progress === undefined) return;
    const cause = causeMessage(error);

    try {
        await request.progress.emit({
            stage: request.progressStage ?? "implementation",
            status: "failed",
            ...(request.progressIssue === undefined
                ? {}
                : { issue: request.progressIssue }),
            message: `Agent task failed: ${error.message}`,
            details: {
                directory: request.directory,
                title: request.title,
                ...(cause === undefined ? {} : { cause }),
                ...(request.progressStage === "grounding" ||
                request.progressStage === "preflight"
                    ? { agentWorkSkipped: false }
                    : {}),
            },
        });
    } catch {
        // Reporting must never hide the original failure.
    }
};

const verifyAgentTaskRequest = async (
    request: AgentTaskRequest,
): Promise<void> => {
    if (
        request.repositoryInvariant !== undefined &&
        request.verifyRepositoryInvariant !== undefined
    ) {
        await request.verifyRepositoryInvariant(
            request.directory,
            request.repositoryInvariant,
            request.signal,
        );
    }
    if (request.verifyAfter !== undefined) {
        await request.verifyAfter(request.signal);
    }
};

/** Run an ordinary text task in a new session. */
export const runAgentTask = async (
    sessions: AgentSessions,
    request: AgentTaskRequest,
): Promise<AgentTaskResult> => {
    try {
        const outcome = await sessions.harness.run(
            sessionRequest(sessions, request),
        );
        if (!outcome.ok) throw sessionFailure(request.role, outcome.failure);
        await verifyAgentTaskRequest(request);
        return {
            sessionID: sessionIdFor(outcome.harnessSessionID),
            text: outcome.text,
        };
    } catch (cause) {
        const error =
            cause instanceof RalphieError
                ? cause
                : new RalphieError({
                      message: `Failed to run the ${request.role} session.`,
                      cause,
                  });
        await reportAgentFailure(request, error);
        throw error;
    }
};