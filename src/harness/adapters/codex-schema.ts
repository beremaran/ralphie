import type { JsonSchema } from "../ports.ts";

/**
 * Codex sends `--output-schema` to OpenAI structured outputs in strict mode,
 * which accepts only a subset of JSON Schema: `anyOf` instead of `oneOf`,
 * `additionalProperties: false` on every object, every property listed in
 * `required` (optional ones must be nullable), and no value-constraint
 * keywords. The original zod schema still validates the result, so the
 * constraints dropped here are enforced after the reply.
 */

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const UNSUPPORTED_KEYWORDS = new Set([
    "$schema",
    "allOf",
    "default",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "format",
    "maxLength",
    "maximum",
    "minLength",
    "minimum",
    "multipleOf",
    "pattern",
    "propertyNames",
]);

const mapValues = (
    record: Node,
    transform: (value: unknown) => unknown,
): Node =>
    Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, transform(value)]),
    );

const nullable = (schema: unknown): Node => ({
    anyOf: [schema, { type: "null" }],
});

const strictObject = (node: Node, properties: Node): Node => {
    const required = new Set(
        Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    return {
        ...node,
        properties: Object.fromEntries(
            Object.entries(properties).map(([key, schema]) => [
                key,
                required.has(key) ? schema : nullable(schema),
            ]),
        ),
        required: Object.keys(properties),
        additionalProperties: false,
    };
};

const strictKeyword = (key: string, value: unknown): unknown => {
    if (key === "properties" && isNode(value)) {
        return mapValues(value, strictSchema);
    }
    if (key === "$defs" && isNode(value)) return mapValues(value, strictSchema);
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
        return value.map(strictSchema);
    }
    return key === "items" ? strictSchema(value) : value;
};

const strictSchema = (schema: unknown): unknown => {
    if (!isNode(schema)) return schema;
    const kept: Node = {};
    for (const [key, value] of Object.entries(schema)) {
        if (UNSUPPORTED_KEYWORDS.has(key)) continue;
        kept[key === "oneOf" ? "anyOf" : key] = strictKeyword(key, value);
    }
    if (kept.type !== "object") return kept;
    return strictObject(kept, isNode(kept.properties) ? kept.properties : {});
};

/** The strict-mode form of a JSON Schema, for the schema file only. */
export const toStrictJsonSchema = (schema: JsonSchema): JsonSchema =>
    strictSchema(schema) as JsonSchema;

const resolveReference = (schema: Node, root: Node): Node => {
    const reference = schema.$ref;
    if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) {
        return schema;
    }
    const target = (root.$defs as Node | undefined)?.[
        reference.slice("#/$defs/".length)
    ];
    return isNode(target) ? target : schema;
};

const matchesConstants = (branch: Node, value: Node): boolean => {
    const properties = isNode(branch.properties) ? branch.properties : {};
    return Object.entries(properties).every(
        ([key, schema]) =>
            !isNode(schema) ||
            !("const" in schema) ||
            value[key] === schema.const,
    );
};

const pickBranch = (schema: Node, value: Node, root: Node): Node => {
    const branches = (schema.anyOf ?? schema.oneOf) as unknown;
    if (!Array.isArray(branches)) return schema;
    const resolved = branches
        .filter(isNode)
        .map((branch) => resolveReference(branch, root));
    return resolved.find((branch) => matchesConstants(branch, value)) ?? schema;
};

const stripObject = (schema: Node, value: Node, root: Node): Node => {
    const properties = isNode(schema.properties) ? schema.properties : {};
    const required = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    const result: Node = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === null && !required.has(key)) continue;
        result[key] = strip(properties[key], item, root);
    }
    return result;
};

const strip = (schema: unknown, value: unknown, root: Node): unknown => {
    if (!isNode(schema)) return value;
    const resolved = resolveReference(schema, root);
    if (Array.isArray(value)) {
        return value.map((item) => strip(resolved.items, item, root));
    }
    if (!isNode(value)) return value;
    return stripObject(pickBranch(resolved, value, root), value, root);
};

/**
 * Remove the nulls Codex returns for fields the original schema made
 * optional, so the original zod schema accepts the value.
 */
export const stripNullOptionals = (
    original: JsonSchema,
    value: unknown,
): unknown => strip(original, value, original);