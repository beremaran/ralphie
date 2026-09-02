import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
    flattenDiscriminatedUnionForTool,
    normalizeEnumNullLiterals,
    stripExplicitNulls,
} from "../../src/agent/json-schema.ts";
import { groundingDecisionSchema } from "../../src/issues/decisions.ts";

const groundingWireSchema = () => z.toJSONSchema(groundingDecisionSchema);

describe("flattenDiscriminatedUnionForTool", () => {
    test("flattens the grounding decision union into a single object", () => {
        const flattened = flattenDiscriminatedUnionForTool(
            groundingWireSchema(),
        ) as Record<string, unknown>;

        expect(flattened.type).toBe("object");
        expect(flattened).not.toHaveProperty("oneOf");
        expect(flattened.required).toEqual(["disposition"]);
        expect(flattened.additionalProperties).toBe(false);
        expect(flattened.$schema).toBe(
            "https://json-schema.org/draft/2020-12/schema",
        );

        const properties = flattened.properties as Record<string, unknown>;
        expect(Object.keys(properties)).toEqual([
            "disposition",
            "reason",
            "summary",
            "evidence",
            "questions",
        ]);
        expect(properties.disposition).toEqual({
            type: "string",
            enum: ["actionable", "already_resolved", "needs_attention"],
        });
        expect(properties.reason).toMatchObject({
            anyOf: [
                {
                    type: "string",
                    enum: expect.arrayContaining(["missing_information"]),
                },
                { type: "null" },
            ],
        });
        expect(properties.summary).toMatchObject({
            anyOf: [{ type: "string" }, { type: "null" }],
        });
        expect(properties.evidence).toMatchObject({
            type: ["array", "null"],
            minItems: 1,
        });
        expect(properties.questions).toMatchObject({
            type: ["array", "null"],
            minItems: 1,
        });
    });

    test("keeps the discriminator required while optional properties admit null", () => {
        const flattened = flattenDiscriminatedUnionForTool(
            groundingWireSchema(),
        ) as Record<string, unknown>;

        expect(flattened.required).toEqual(["disposition"]);
        for (const name of ["reason", "summary", "evidence", "questions"]) {
            const property = (flattened.properties as Record<string, unknown>)[
                name
            ] as {
                readonly anyOf?: unknown[];
                readonly type?: unknown;
            };
            const admitsNull =
                (property.anyOf?.at(-1) as { type?: unknown } | undefined)
                    ?.type === "null" ||
                Array.isArray(property.type) ||
                property.type === "null";
            expect(admitsNull).toBe(true);
        }
        const disposition = (flattened.properties as Record<string, unknown>)[
            "disposition"
        ] as { readonly type?: unknown };
        expect(disposition.type).toBe("string");
    });

    test("annotates branch-only properties with their applicable dispositions", () => {
        const flattened = flattenDiscriminatedUnionForTool(
            groundingWireSchema(),
        ) as Record<string, unknown>;
        const properties = flattened.properties as Record<string, unknown>;

        for (const name of ["reason", "summary", "evidence", "questions"]) {
            expect(
                (properties[name] as { description?: string }).description,
            ).toBe(
                'Only applicable when disposition is "needs_attention"; omit this property or set it to null for the other options.',
            );
        }
        expect(
            (properties.disposition as { description?: string }).description,
        ).toBeUndefined();
    });

    test("describes properties shared by several branches with the full option list", () => {
        const schema = {
            oneOf: [
                {
                    type: "object",
                    properties: {
                        kind: { type: "string", const: "a" },
                        notes: { type: "string" },
                    },
                    required: ["kind", "notes"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: { kind: { type: "string", const: "b" } },
                    required: ["kind"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: {
                        kind: { type: "string", const: "c" },
                        notes: { type: "string" },
                        tags: { type: "array", items: { type: "string" } },
                    },
                    required: ["kind", "tags"],
                    additionalProperties: false,
                },
            ],
        };

        const flattened = flattenDiscriminatedUnionForTool(schema) as Record<
            string,
            unknown
        >;
        const properties = flattened.properties as Record<string, unknown>;

        expect((properties.notes as { description?: string }).description).toBe(
            'Only applicable when kind is "a" or "c"; omit this property or set it to null for the other options.',
        );
        expect((properties.tags as { description?: string }).description).toBe(
            'Only applicable when kind is "c"; omit this property or set it to null for the other options.',
        );
        expect(properties.tags).toMatchObject({ type: ["array", "null"] });
    });

    test("keeps a root description on the flattened schema", () => {
        const schema = {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            description: "A decision.",
            oneOf: [
                {
                    type: "object",
                    properties: { kind: { type: "string", const: "a" } },
                    required: ["kind"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: { kind: { type: "string", const: "b" } },
                    required: ["kind"],
                    additionalProperties: false,
                },
            ],
        };

        const flattened = flattenDiscriminatedUnionForTool(schema) as Record<
            string,
            unknown
        >;

        expect(flattened.description).toBe("A decision.");
        expect(flattened).not.toHaveProperty("oneOf");
    });

    test("returns plain object schemas untouched", () => {
        const schema = z.toJSONSchema(
            z.object({ decision: z.enum(["proceed", "stop"]) }),
        );
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });

    test("returns unions of non-object branches untouched", () => {
        const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });

    test("returns unions without a shared const discriminator untouched", () => {
        const schema = {
            oneOf: [
                {
                    type: "object",
                    properties: { a: { type: "string" } },
                    required: ["a"],
                },
                {
                    type: "object",
                    properties: { b: { type: "string" } },
                    required: ["b"],
                },
            ],
        };
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });

    test("returns unions with duplicate discriminator values untouched", () => {
        const schema = {
            oneOf: [
                {
                    type: "object",
                    properties: { kind: { const: "same" } },
                    required: ["kind"],
                },
                {
                    type: "object",
                    properties: { kind: { const: "same" } },
                    required: ["kind"],
                },
            ],
        };
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });

    test("returns unions with conflicting non-discriminator properties untouched", () => {
        const schema = {
            oneOf: [
                {
                    type: "object",
                    properties: {
                        kind: { const: "a" },
                        value: { type: "string" },
                    },
                    required: ["kind"],
                },
                {
                    type: "object",
                    properties: {
                        kind: { const: "b" },
                        value: { type: "number" },
                    },
                    required: ["kind"],
                },
            ],
        };
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });

    test("returns unions whose properties reference definitions untouched", () => {
        const schema = {
            $defs: { name: { type: "string" } },
            oneOf: [
                {
                    type: "object",
                    properties: {
                        kind: { const: "a" },
                        value: { $ref: "#/$defs/name" },
                    },
                    required: ["kind"],
                },
                {
                    type: "object",
                    properties: { kind: { const: "b" } },
                    required: ["kind"],
                },
            ],
        };
        expect(flattenDiscriminatedUnionForTool(schema)).toBe(schema);
    });
});

describe("stripExplicitNulls", () => {
    test("removes null-valued keys at every object level", () => {
        expect(
            stripExplicitNulls({
                a: null,
                b: { c: null, d: 1 },
                e: [{ f: null, g: "x" }],
            }),
        ).toEqual({ b: { d: 1 }, e: [{ g: "x" }] });
    });

    test("keeps falsy values and null array slots", () => {
        expect(
            stripExplicitNulls({ a: 0, b: "", c: false, d: [null, "x"] }),
        ).toEqual({ a: 0, b: "", c: false, d: [null, "x"] });
    });

    test("passes primitives through unchanged", () => {
        expect(stripExplicitNulls("value")).toBe("value");
        expect(stripExplicitNulls(0)).toBe(0);
        expect(stripExplicitNulls(null)).toBe(null);
    });
});

describe("normalizeEnumNullLiterals", () => {
    const decision = {
        type: "object",
        properties: {
            disposition: {
                type: "string",
                enum: ["actionable", "already_resolved", "needs_attention"],
            },
            reason: {
                anyOf: [
                    {
                        type: "string",
                        enum: [
                            "outdated_premise",
                            "missing_information",
                            "external_dependency",
                        ],
                    },
                    { type: "null" },
                ],
            },
            summary: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["disposition"],
    } as const;

    test("converts the literal string null only for enum-typed properties", () => {
        expect(
            normalizeEnumNullLiterals(decision, {
                disposition: "actionable",
                reason: "null",
                summary: "null",
            }),
        ).toEqual({
            disposition: "actionable",
            reason: null,
            summary: "null",
        });
    });

    test("leaves legitimate enum values and non-enum strings untouched", () => {
        const value = {
            disposition: "needs_attention",
            reason: "missing_information",
            summary: "A genuine summary.",
        };
        expect(normalizeEnumNullLiterals(decision, value)).toBe(value);
    });

    test("returns the same reference when nothing changes", () => {
        const value = { disposition: "actionable", reason: null };
        expect(normalizeEnumNullLiterals(decision, value)).toBe(value);
    });

    test("converts enum null literals inside arrays", () => {
        const schema = {
            type: "object",
            properties: {
                reasons: {
                    type: "array",
                    items: {
                        type: "string",
                        enum: ["a", "b"],
                    },
                },
            },
        } as const;
        expect(
            normalizeEnumNullLiterals(schema, { reasons: ["a", "null"] }),
        ).toEqual({ reasons: ["a", null] });
    });

    test("passes non-object values and unknown properties through", () => {
        expect(normalizeEnumNullLiterals(decision, "garbage")).toBe("garbage");
        expect(
            normalizeEnumNullLiterals(decision, {
                disposition: "actionable",
                extra: "null",
            }),
        ).toEqual({ disposition: "actionable", extra: "null" });
    });

    test("keeps the string null inside enum-typed fields that allow it", () => {
        const schema = {
            type: "object",
            properties: {
                option: { type: "string", enum: ["null", "yes"] },
            },
        } as const;
        expect(normalizeEnumNullLiterals(schema, { option: "null" })).toEqual({
            option: "null",
        });
    });
});