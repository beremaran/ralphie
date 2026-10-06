import { expect, test } from "bun:test";
import { z } from "zod";

import { envelopeSchema } from "../../src/agent/structured-output.ts";
import {
    stripNullOptionals,
    toStrictJsonSchema,
} from "../../src/harness/adapters/codex-schema.ts";
import { toJsonSchema } from "../../src/harness/app/structured-result.ts";
import { implementationResultSchema } from "../../src/issues/app/implementation-executor.ts";
import {
    commitMessageDecisionSchema,
    handOffVerificationSchema,
    issueBreakdownDecisionSchema,
    preflightDecisionSchema,
    resolutionVerificationDecisionSchema,
    reviewDecisionSchema,
} from "../../src/issues/domain/decisions.ts";
import {
    specReviewSchema,
    standardsReviewSchema,
} from "../../src/issues/domain/review-gate.ts";
import { triageDecisionSchema } from "../../src/issues/domain/triage.ts";

/** Every result contract a role sends to a harness, before its envelope. */
export const roleSchemas: ReadonlyArray<readonly [string, z.ZodType]> = [
    ["preflight", preflightDecisionSchema],
    ["implementation", implementationResultSchema],
    ["standards review", standardsReviewSchema],
    ["spec review", specReviewSchema],
    ["decomposition breakdown", issueBreakdownDecisionSchema],
    ["triage", triageDecisionSchema],
    ["hand-off verification", handOffVerificationSchema],
    ["resolution verification", resolutionVerificationDecisionSchema],
    ["review decision", reviewDecisionSchema],
    ["commit message", commitMessageDecisionSchema],
];

const FORBIDDEN = new Set([
    "oneOf",
    "allOf",
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "default",
    "$schema",
]);

const walk = (
    node: unknown,
    visit: (node: Record<string, unknown>) => void,
): void => {
    if (Array.isArray(node)) {
        for (const item of node) walk(item, visit);
    } else if (typeof node === "object" && node !== null) {
        visit(node as Record<string, unknown>);
        for (const child of Object.values(node)) walk(child, visit);
    }
};

const checkNode = (node: Record<string, unknown>): number => {
    for (const key of Object.keys(node)) {
        expect(FORBIDDEN.has(key)).toBe(false);
    }
    const { properties } = node;
    if (node.type !== "object" || typeof properties !== "object") return 0;
    expect(node.additionalProperties).toBe(false);
    expect([...(node.required as string[])].sort()).toEqual(
        Object.keys(properties as object).sort(),
    );
    return 1;
};

for (const [name, schema] of roleSchemas) {
    test(`codex strict schema for ${name} is strict-mode compatible`, () => {
        const strict = toStrictJsonSchema(toJsonSchema(envelopeSchema(schema)));
        expect(strict.type).toBe("object");
        let objects = 0;
        walk(strict, (node) => {
            objects += checkNode(node);
        });
        expect(objects).toBeGreaterThan(0);
    });
}

test("optional properties become nullable and the original is untouched", () => {
    const original = toJsonSchema(
        z.object({ a: z.string(), b: z.string().optional() }),
    );
    const strict = toStrictJsonSchema(original) as {
        properties: Record<string, unknown>;
        required: string[];
    };
    expect(strict.required).toEqual(["a", "b"]);
    expect(strict.properties.b).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect((original as { required: string[] }).required).toEqual(["a"]);
});

test("nulls for optional fields are stripped before validation", () => {
    const schema = envelopeSchema(implementationResultSchema);
    const stripped = stripNullOptionals(toJsonSchema(schema), {
        result: {
            status: "done",
            summary: "x",
            commitMessage: { subject: "s", body: null },
            needsAttention: null,
        },
        handOff: null,
    });
    expect(stripped).toEqual({
        result: {
            status: "done",
            summary: "x",
            commitMessage: { subject: "s" },
        },
    });
    expect(schema.safeParse(stripped).success).toBe(true);
});

test("nulls are stripped inside arrays of objects", () => {
    const schema = envelopeSchema(reviewDecisionSchema);
    const stripped = stripNullOptionals(toJsonSchema(schema), {
        result: {
            verdict: "changes_requested",
            summary: "s",
            findings: [
                {
                    severity: "blocking",
                    description: "d",
                    file: null,
                    line: null,
                },
            ],
        },
        handOff: null,
    });
    expect(schema.safeParse(stripped).success).toBe(true);
});

test("nulls are stripped inside discriminated unions", () => {
    const schema = z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), x: z.string().optional() }),
        z.object({ kind: z.literal("b"), y: z.string().optional() }),
    ]);
    expect(
        stripNullOptionals(toJsonSchema(schema), { kind: "b", y: null }),
    ).toEqual({ kind: "b" });
});

test("a required nullable field keeps its null", () => {
    const schema = z.object({ a: z.string().nullable() });
    expect(stripNullOptionals(toJsonSchema(schema), { a: null })).toEqual({
        a: null,
    });
});