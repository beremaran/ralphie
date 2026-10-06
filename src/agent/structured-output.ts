import { z } from "zod";

import type { HarnessRole, SessionAccess } from "../harness/ports.ts";
import { RalphieError } from "../shared/error.ts";
import {
    type AgentSessions,
    sessionFailure,
    sessionIdFor,
    sessionRequest,
} from "./sessions.ts";
import {
    type AgentRepositoryInvariant,
    handOffRequestSchema,
    reportAgentFailure,
    type HandOffRequest,
} from "./task-session.ts";
import {
    type ProgressStage,
    type ProgressIssue,
    type ProgressReporterService,
} from "../progress/ports.ts";

export type StructuredOutputRequest<Output> = {
    readonly role: HarnessRole;
    readonly access?: SessionAccess;
    readonly directory: string;
    readonly title: string;
    readonly prompt: string;
    readonly schema: z.ZodType<Output>;
    readonly signal?: AbortSignal;
    readonly repositoryInvariant?: AgentRepositoryInvariant;
    readonly verifyRepositoryInvariant?: (
        repositoryPath: string,
        expected: AgentRepositoryInvariant,
        signal?: AbortSignal,
    ) => Promise<void>;
    readonly verifyAfter?: (signal?: AbortSignal) => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export type StructuredOutputResult<Output> = {
    readonly sessionID: string;
    readonly output: Output;
    readonly handOff?: HandOffRequest;
};

/**
 * The result contract every structured session returns: the task's own result
 * plus an optional bounded request to defer the work.
 */
export const envelopeSchema = <Output>(schema: z.ZodType<Output>) =>
    z.object({
        result: schema,
        handOff: handOffRequestSchema.optional(),
    });

const verifyStructuredOutputRequest = async <Output>(
    request: StructuredOutputRequest<Output>,
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

const describeFailureCause = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

const runStructuredSession = async <Output>(
    sessions: AgentSessions,
    request: StructuredOutputRequest<Output>,
): Promise<StructuredOutputResult<Output>> => {
    request.signal?.throwIfAborted();
    const outcome = await sessions.harness.run({
        ...sessionRequest(sessions, {
            ...request,
            prompt: `${request.prompt}\n\nPut the task result in the \`result\` field of your structured result.`,
        }),
        resultSchema: envelopeSchema(request.schema),
    });
    if (!outcome.ok) throw sessionFailure(request.role, outcome.failure);
    await verifyStructuredOutputRequest(request);
    const { result, handOff } = outcome.value;
    return {
        sessionID: sessionIdFor(outcome.harnessSessionID),
        output: result,
        ...(handOff === undefined ? {} : { handOff }),
    };
};

export const requestStructuredOutput = async <Output>(
    sessions: AgentSessions,
    request: StructuredOutputRequest<Output>,
): Promise<StructuredOutputResult<Output>> => {
    try {
        return await runStructuredSession(sessions, request);
    } catch (cause) {
        const error =
            cause instanceof RalphieError
                ? cause
                : new RalphieError({
                      message: `Failed to get structured output from the ${request.role} session. Cause: ${describeFailureCause(cause)}`,
                      cause,
                  });
        await reportAgentFailure(request, error);
        throw error;
    }
};