import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
    flattenDiscriminatedUnionForTool,
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
            type: "string",
            enum: expect.arrayContaining(["missing_information"]),
        });
        expect(properties.evidence).toMatchObject({
            type: "array",
            minItems: 1,
        });
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