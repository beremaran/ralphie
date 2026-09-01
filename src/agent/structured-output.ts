import type { CodexClient, CodexPermissionRuleset } from "../codex/client.ts";
import { z } from "zod";

import { RalphieError } from "../shared/error.ts";
import type { CodexModel } from "./model.ts";
import {
    CODEX_DECISION_PERMISSION_POLICY,
    type CodexRepositoryInvariant,
    type CodexSessionDiagnostics,
    parseCodexNeedsAttentionRequest,
    reportCodexFailure,
    toCodexAssistantError,
    type CodexNeedsAttentionRequest,
} from "./task-session.ts";
import {
    type ProgressStage,
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
    readonly permission?: CodexPermissionRuleset;
    readonly model?: CodexModel;
    readonly variant?: string;
    readonly runId?: string;
    readonly diagnostics?: CodexSessionDiagnostics;
    readonly signal?: AbortSignal;
    readonly repositoryInvariant?: CodexRepositoryInvariant;
    readonly verifyRepositoryInvariant?: (
        repositoryPath: string,
        expected: CodexRepositoryInvariant,
    ) => Promise<void>;
    readonly verifyAfter?: () => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export type StructuredOutputResult<Output> = {
    readonly sessionID: string;
    readonly output: Output;
    readonly needsAttention?: CodexNeedsAttentionRequest;
};

const describeApiError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error !== "object" || error === null) return String(error);

    const candidate = error as {
        readonly name?: unknown;
        readonly data?: { readonly message?: unknown };
    };
    const name =
        typeof candidate.name === "string" ? candidate.name : "CodexError";
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
    sandbox: request.permission ?? CODEX_DECISION_PERMISSION_POLICY,
});

const validateStructuredOutput = <Output>(
    schema: z.ZodType<Output>,
    value: unknown,
): { readonly success: boolean; readonly error?: string } => {
    const parsed = schema.safeParse(
        normalizeStructuredOutput(value, z.toJSONSchema(schema)),
    );
    return parsed.success
        ? { success: true }
        : { success: false, error: z.prettifyError(parsed.error) };
};

type JsonSchema = Record<string, unknown>;

const isJsonSchema = (value: unknown): value is JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const schemaRequiredKeys = (schema: JsonSchema): ReadonlySet<string> =>
    new Set(
        Array.isArray(schema.required)
            ? schema.required.filter(
                  (key): key is string => typeof key === "string",
              )
            : [],
    );

const nullableSchema = (schema: unknown): unknown => {
    if (!isJsonSchema(schema)) return schema;
    const type = Array.isArray(schema.type)
        ? [...new Set([...schema.type, "null"])]
        : typeof schema.type === "string"
          ? [schema.type, "null"]
          : schema.type;
    if (schema.const !== undefined) {
        const { const: constant, ...rest } = schema;
        return { ...rest, type, enum: [constant, null] };
    }
    return {
        ...schema,
        ...(type === undefined ? {} : { type }),
        ...(Array.isArray(schema.enum)
            ? { enum: [...new Set([...schema.enum, null])] }
            : {}),
    };
};

const mergeVariantProperty = (schemas: ReadonlyArray<JsonSchema>): unknown => {
    const constants = schemas.map((schema) => schema.const);
    const type = schemas[0]?.type;
    if (
        constants.every((constant) => constant !== undefined) &&
        schemas.every((schema) => schema.type === type)
    ) {
        return { type, enum: [...new Set(constants)] };
    }
    return schemas[0];
};

const unionProperties = (
    variants: ReadonlyArray<JsonSchema>,
): Record<string, unknown> => {
    const propertyMaps = variants.map((variant) =>
        isJsonSchema(variant.properties) ? variant.properties : {},
    );
    const keys = [...new Set(propertyMaps.flatMap(Object.keys))];
    return Object.fromEntries(
        keys.map((key) => {
            const schemas = propertyMaps
                .map((properties) => properties[key])
                .filter(isJsonSchema);
            const requiredInEveryVariant = variants.every(
                (variant, index) =>
                    schemaRequiredKeys(variant).has(key) &&
                    propertyMaps[index]?.[key] !== undefined,
            );
            const merged = codexOutputSchema(mergeVariantProperty(schemas));
            return [
                key,
                requiredInEveryVariant ? merged : nullableSchema(merged),
            ];
        }),
    );
};

const normalizeObjectSchema = (schema: JsonSchema): JsonSchema => {
    if (!isJsonSchema(schema.properties)) return schema;
    const required = schemaRequiredKeys(schema);
    const properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, property]) => {
            const normalized = codexOutputSchema(property);
            return [
                key,
                required.has(key) ? normalized : nullableSchema(normalized),
            ];
        }),
    );
    return { ...schema, properties, required: Object.keys(properties) };
};

const normalizeObjectUnion = (schema: JsonSchema): JsonSchema => {
    const variants = Array.isArray(schema.oneOf)
        ? schema.oneOf.filter(isJsonSchema)
        : [];
    if (variants.length === 0) {
        throw new Error("Codex output schema contains an unsupported union.");
    }
    const { oneOf: _oneOf, ...metadata } = schema;
    const properties = unionProperties(variants);
    return {
        ...metadata,
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
};

/** Convert Zod JSON Schema to the strict subset accepted by Codex. */
const codexOutputSchema = (schema: unknown): unknown => {
    if (Array.isArray(schema)) return schema.map(codexOutputSchema);
    if (!isJsonSchema(schema)) return schema;
    if (Array.isArray(schema.oneOf)) return normalizeObjectUnion(schema);
    const normalized = Object.fromEntries(
        Object.entries(schema).map(([key, value]) => [
            key,
            codexOutputSchema(value),
        ]),
    );
    return normalized.type === "object"
        ? normalizeObjectSchema(normalized)
        : normalized;
};

const removeNullProperties = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(removeNullProperties);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, child]) => child !== null)
            .map(([key, child]) => [key, removeNullProperties(child)]),
    );
};

const matchesSchemaConstants = (
    value: Record<string, unknown>,
    schema: JsonSchema,
): boolean => {
    if (!isJsonSchema(schema.properties)) return false;
    return Object.entries(schema.properties).every((entry) => {
        const [key, property] = entry;
        return (
            !isJsonSchema(property) ||
            property.const === undefined ||
            value[key] === property.const
        );
    });
};

const selectedUnionVariant = (
    value: Record<string, unknown>,
    schema: JsonSchema,
): JsonSchema | undefined =>
    Array.isArray(schema.oneOf)
        ? schema.oneOf
              .filter(isJsonSchema)
              .find((variant) => matchesSchemaConstants(value, variant))
        : undefined;

const projectObjectToSchema = (
    value: Record<string, unknown>,
    schema: JsonSchema,
): Record<string, unknown> => {
    if (!isJsonSchema(schema.properties)) return value;
    return Object.fromEntries(
        Object.entries(schema.properties)
            .filter(([key]) => value[key] !== undefined)
            .map(([key, property]) => [
                key,
                normalizeStructuredOutput(value[key], property),
            ]),
    );
};

const normalizeObjectProperties = (
    value: Record<string, unknown>,
    schema: JsonSchema,
): Record<string, unknown> => {
    const properties = isJsonSchema(schema.properties) ? schema.properties : {};
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
            key,
            normalizeStructuredOutput(child, properties[key]),
        ]),
    );
};

const normalizeStructuredOutput = (
    value: unknown,
    schema: unknown,
): unknown => {
    const withoutNulls = removeNullProperties(value);
    if (Array.isArray(withoutNulls)) {
        const itemSchema = isJsonSchema(schema) ? schema.items : undefined;
        return withoutNulls.map((item) =>
            normalizeStructuredOutput(item, itemSchema),
        );
    }
    if (!isJsonSchema(withoutNulls) || !isJsonSchema(schema)) {
        return withoutNulls;
    }
    const selected = selectedUnionVariant(withoutNulls, schema);
    return selected === undefined
        ? normalizeObjectProperties(withoutNulls, schema)
        : projectObjectToSchema(withoutNulls, selected);
};

const promptInput = <Output>(
    request: StructuredOutputRequest<Output>,
    sessionID: string,
) => ({
    sessionID,
    directory: request.directory,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.variant === undefined ? {} : { variant: request.variant }),
    format: {
        type: "json_schema" as const,
        schema: codexOutputSchema(z.toJSONSchema(request.schema)),
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
    client: CodexClient,
    request: StructuredOutputRequest<Output>,
    sessionID: string,
): Promise<StructuredOutputResult<Output>> => {
    const response = await client.session.prompt(
        promptInput(request, sessionID),
        signalOptions(request.signal),
    );

    if (response.error !== undefined || response.data === undefined) {
        throw new Error(
            `Codex prompt failed: ${describeApiError(response.error)}`,
        );
    }

    if (response.data.info.error !== undefined) {
        const assistantError = toCodexAssistantError(response.data.info.error);
        throw new RalphieError({
            message: `Codex assistant failed (${assistantError.kind}): ${assistantError.message}`,
            cause: assistantError,
        });
    }

    const parsed = request.schema.safeParse(
        normalizeStructuredOutput(
            response.data.info.structured,
            z.toJSONSchema(request.schema),
        ),
    );
    if (!parsed.success) {
        throw new Error(
            `Codex returned invalid structured output: ${z.prettifyError(parsed.error)}`,
        );
    }

    await verifyStructuredOutputRequest(request);
    return {
        sessionID,
        output: parsed.data,
    };
};

export const requestStructuredOutput = async <Output>(
    client: CodexClient,
    request: StructuredOutputRequest<Output>,
): Promise<StructuredOutputResult<Output>> => {
    try {
        const session = await client.session.create(
            createSessionInput(request),
            signalOptions(request.signal),
        );

        if (session.error !== undefined || session.data === undefined) {
            throw new Error(
                `Could not create Codex session: ${describeApiError(session.error)}`,
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
                      message: "Failed to get structured output from Codex.",
                      cause,
                  });
        await reportCodexFailure(request, error);
        throw error;
    }
};