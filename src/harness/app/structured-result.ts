import { z } from "zod";

import type { JsonSchema } from "../ports.ts";

/** Why a reply did not carry a valid result; fed back to the session. */
type ResultProblem = { readonly problem: string };

type ParsedResult<T> =
    | { readonly ok: true; readonly value: T }
    | ({ readonly ok: false } & ResultProblem);

/**
 * The JSON Schema a harness sees for a result contract. The `$schema` keyword
 * is dropped because Claude Code rejects the draft URL zod emits.
 */
export const toJsonSchema = (schema: z.ZodType): JsonSchema => {
    const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<
        string,
        unknown
    >;
    return rest;
};

/** Prompt addition for harnesses with no native schema output. */
export const fallbackInstructions = (jsonSchema: JsonSchema): string =>
    [
        "When you are finished, end your final message with exactly one fenced JSON block containing your result, and nothing after it.",
        "The block must be valid JSON matching this JSON Schema:",
        "```json",
        JSON.stringify(jsonSchema, null, 2),
        "```",
        "Start the block with ```json on its own line.",
    ].join("\n");

/** Follow-up prompt that resumes a session after an invalid result. */
export const correctionPrompt = (
    problem: string,
    fallback: boolean,
    jsonSchema: JsonSchema,
): string =>
    [
        "Your previous result was rejected and was not used:",
        problem,
        fallback
            ? `Reply again with the corrected result.\n\n${fallbackInstructions(jsonSchema)}`
            : "Reply again with the corrected result.",
    ].join("\n\n");

const FENCED_JSON = /```json[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g;

/** Body of the last fenced `json` block in `text`, if any. */
const lastJsonBlock = (text: string): string | undefined => {
    let last: string | undefined;
    for (const match of text.matchAll(FENCED_JSON)) last = match[1];
    return last;
};

const validate = <T>(
    schema: z.ZodType<T>,
    candidate: unknown,
): ParsedResult<T> => {
    const parsed = schema.safeParse(candidate);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, problem: z.prettifyError(parsed.error) };
};

/** Validate the structured value a harness returned natively. */
export const parseNativeResult = <T>(
    schema: z.ZodType<T>,
    structured: unknown,
): ParsedResult<T> =>
    structured === undefined
        ? { ok: false, problem: "No structured result was produced." }
        : validate(schema, structured);

/** Extract and validate the final JSON block of a reply. */
export const parseFallbackResult = <T>(
    schema: z.ZodType<T>,
    text: string,
): ParsedResult<T> => {
    const block = lastJsonBlock(text);
    if (block === undefined) {
        return {
            ok: false,
            problem: "The reply did not end with a fenced JSON block.",
        };
    }
    let candidate: unknown;
    try {
        candidate = JSON.parse(block);
    } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return {
            ok: false,
            problem: `The JSON block could not be parsed: ${detail}`,
        };
    }
    return validate(schema, candidate);
};