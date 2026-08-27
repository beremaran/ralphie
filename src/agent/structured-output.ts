import type { PiClient } from "../pi/client.ts";
import { z } from "zod";

import { withPiAgentPermit } from "./concurrency.ts";
import { RalphieError } from "../shared/error.ts";
import type { PiModel } from "./model.ts";
import {
    PI_DECISION_PERMISSION_POLICY,
    type PiRepositoryInvariant,
    type PiSessionDiagnostics,
    reportPiFailure,
    toPiAssistantError,
} from "./task-session.ts";
import {
    ProgressStage,
    type ProgressIssue,
    type ProgressReporterService,
} from "../progress/progress.ts";

export type StructuredOutputRequest<Output> = {
    readonly directory: string;
    readonly title: string;
    readonly prompt: string;
    readonly schema: z.ZodType<Output>;
    readonly retryCount?: number;
    readonly agent?: string;
    readonly model?: PiModel;
    readonly variant?: string;
    readonly runId?: string;
    readonly diagnostics?: PiSessionDiagnostics;
    readonly signal?: AbortSignal;
    readonly repositoryInvariant?: PiRepositoryInvariant;
    readonly verifyRepositoryInvariant?: (
        repositoryPath: string,
        expected: PiRepositoryInvariant,
    ) => Promise<void>;
    readonly verifyAfter?: () => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export type StructuredOutputResult<Output> = {
    readonly sessionID: string;
    readonly output: Output;
};

const describeApiError = (error: unknown): string => {
    if (typeof error !== "object" || error === null) return String(error);

    const candidate = error as {
        readonly name?: unknown;
        readonly data?: { readonly message?: unknown };
    };
    const name =
        typeof candidate.name === "string" ? candidate.name : "PiError";
    const message =
        typeof candidate.data?.message === "string"
            ? candidate.data.message
            : JSON.stringify(error);

    return `${name}: ${message}`;
};

const signalOptions = (signal: AbortSignal | undefined) =>
    signal === undefined ? undefined : { signal };

const createSessionInput = <Output>(
    request: StructuredOutputRequest<Output>,
) => ({
    directory: request.directory,
    title: request.title,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    permission: PI_DECISION_PERMISSION_POLICY,
});

const validateStructuredOutput = <Output>(
    schema: z.ZodType<Output>,
    value: unknown,
): { readonly success: boolean; readonly error?: string } => {
    const parsed = schema.safeParse(value);
    return parsed.success
        ? { success: true }
        : { success: false, error: z.prettifyError(parsed.error) };
};

const promptInput = <Output>(
    request: StructuredOutputRequest<Output>,
    sessionID: string,
) => ({
    sessionID,
    directory: request.directory,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.variant === undefined ? {} : { variant: request.variant }),
    format: {
        type: "json_schema" as const,
        schema: z.toJSONSchema(request.schema),
        retryCount: request.retryCount ?? 2,
        validate: (value: unknown) =>
            validateStructuredOutput(request.schema, value),
    },
    parts: [{ type: "text" as const, text: request.prompt }],
});

const recordSessionDiagnostics = <Output>(
    request: StructuredOutputRequest<Output>,
    sessionID: string,
): void => {
    if (request.runId === undefined || request.diagnostics === undefined) {
        return;
    }
    request.diagnostics.record(request.runId, {
        sessionID,
        directory: request.directory,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.variant === undefined ? {} : { variant: request.variant }),
    });
};

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
        );
    }
    if (request.verifyAfter !== undefined) await request.verifyAfter();
};

const promptForStructuredOutput = async <Output>(
    client: PiClient,
    request: StructuredOutputRequest<Output>,
    sessionID: string,
): Promise<StructuredOutputResult<Output>> => {
    const response = await client.session.prompt(
        promptInput(request, sessionID),
        signalOptions(request.signal),
    );

    if (response.error !== undefined || response.data === undefined) {
        throw new Error(
            `Pi prompt failed: ${describeApiError(response.error)}`,
        );
    }

    if (response.data.info.error !== undefined) {
        const assistantError = toPiAssistantError(response.data.info.error);
        throw new RalphieError({
            message: `Pi assistant failed (${assistantError.kind}): ${assistantError.message}`,
            cause: assistantError,
        });
    }

    const parsed = request.schema.safeParse(response.data.info.structured);
    if (!parsed.success) {
        throw new Error(
            `Pi returned invalid structured output: ${z.prettifyError(parsed.error)}`,
        );
    }

    await verifyStructuredOutputRequest(request);
    return { sessionID, output: parsed.data };
};

export const requestStructuredOutput = async <Output>(
    client: PiClient,
    request: StructuredOutputRequest<Output>,
): Promise<StructuredOutputResult<Output>> =>
    withPiAgentPermit(client, async () => {
        try {
            const session = await client.session.create(
                createSessionInput(request),
                signalOptions(request.signal),
            );

            if (session.error !== undefined || session.data === undefined) {
                throw new Error(
                    `Could not create Pi session: ${describeApiError(session.error)}`,
                );
            }

            recordSessionDiagnostics(request, session.data.id);

            return await promptForStructuredOutput(
                client,
                request,
                session.data.id,
            );
        } catch (cause) {
            const error =
                cause instanceof RalphieError
                    ? cause
                    : new RalphieError({
                          message: "Failed to get structured output from Pi.",
                          cause,
                      });
            await reportPiFailure(request, error);
            throw error;
        }
    });