import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import type { CodexClient } from "../../src/codex/client.ts";
import {
    GroundingDisposition,
    commitMessageDecisionSchema,
    groundingDecisionSchema,
} from "../../src/issues/decisions.ts";

const capturingClient = (structured: unknown) => {
    let prompt: Record<string, unknown> | undefined;
    const client = {
        session: {
            create: async () => ({ data: { id: "session-1" } }),
            prompt: async (input: Record<string, unknown>) => {
                prompt = input;
                return {
                    data: {
                        info: {
                            id: "thread-1",
                            role: "assistant" as const,
                            structured,
                        },
                        parts: [],
                    },
                };
            },
        },
    } as unknown as CodexClient;
    return { client, prompt: () => prompt };
};

describe("Codex output-schema compatibility", () => {
    test("flattens a discriminated union and restores its selected branch", async () => {
        const fixture = capturingClient({
            disposition: GroundingDisposition.Actionable,
            reason: null,
            summary: "This belongs only to another branch.",
            evidence: ["Likewise."],
            questions: null,
        });

        const result = await requestStructuredOutput(fixture.client, {
            directory: "/workspace",
            title: "Ground issue",
            prompt: "Ground it.",
            schema: groundingDecisionSchema,
        });

        expect(result.output).toEqual({
            disposition: GroundingDisposition.Actionable,
        });
        const schema = (
            fixture.prompt()?.format as { schema: Record<string, unknown> }
        ).schema;
        expect(schema).not.toHaveProperty("oneOf");
        expect(schema).toMatchObject({
            type: "object",
            required: [
                "disposition",
                "reason",
                "summary",
                "evidence",
                "questions",
            ],
            properties: {
                disposition: {
                    type: "string",
                    enum: [
                        GroundingDisposition.Actionable,
                        GroundingDisposition.AlreadyResolved,
                        GroundingDisposition.NeedsAttention,
                    ],
                },
                reason: {
                    type: ["string", "null"],
                    enum: expect.arrayContaining([null]),
                },
            },
        });
    });

    test("represents optional object properties as required and nullable", async () => {
        const fixture = capturingClient({
            subject: "Fix the schema",
            body: null,
        });

        const result = await requestStructuredOutput(fixture.client, {
            directory: "/workspace",
            title: "Commit message",
            prompt: "Write it.",
            schema: commitMessageDecisionSchema,
        });

        expect(result.output).toEqual({ subject: "Fix the schema" });
        expect(fixture.prompt()).toMatchObject({
            format: {
                schema: {
                    required: ["subject", "body"],
                    properties: {
                        body: { type: ["string", "null"] },
                    },
                },
            },
        });
    });

    test("keeps authoritative strict-schema validation after normalization", async () => {
        const fixture = capturingClient({ value: "valid", unexpected: true });

        expect(
            requestStructuredOutput(fixture.client, {
                directory: "/workspace",
                title: "Strict output",
                prompt: "Return it.",
                schema: z.object({ value: z.string() }).strict(),
            }),
        ).rejects.toThrow("Failed to get structured output from Codex");
    });
});