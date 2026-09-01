/**
 * Wire-format helpers for the JSON schemas Ralphie hands to Pi tools.
 *
 * Pi validates every tool call against the tool's parameter schema and sends
 * that same schema to the model provider. Providers disagree on how much JSON
 * Schema they honor for tool parameters: some models and relays silently
 * mishandle root-level `oneOf` unions and emit tool calls with empty
 * arguments. The flattener below reshapes discriminated unions into a single
 * flat object so the widest set of providers can comply; the authoritative
 * Zod validation still runs on arrival, so branch-strict requirements are
 * enforced exactly as before (violations are reported back to the model).
 */

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const stableJson = (value: unknown): string =>
    JSON.stringify(value, (_key, entry: unknown) => {
        if (!isJsonObject(entry)) return entry;
        return Object.fromEntries(
            Object.keys(entry)
                .sort()
                .map((name) => [name, entry[name]]),
        );
    });

const containsRef = (value: unknown): boolean => {
    if (Array.isArray(value)) {
        return value.some((entry) => containsRef(entry));
    }
    if (!isJsonObject(value)) return false;
    return Object.entries(value).some(
        ([key, entry]) => key === "$ref" || containsRef(entry),
    );
};

const constStringOf = (schema: unknown): string | undefined => {
    if (!isJsonObject(schema)) return undefined;
    const value = schema.const;
    return typeof value === "string" ? value : undefined;
};

const unionBranchesOf = (
    schema: unknown,
): readonly JsonObject[] | undefined => {
    if (!isJsonObject(schema)) return undefined;
    const variants = schema.oneOf ?? schema.anyOf;
    if (!Array.isArray(variants) || variants.length < 2) return undefined;
    if (
        !variants.every((variant): variant is JsonObject =>
            isJsonObject(variant),
        )
    ) {
        return undefined;
    }
    return variants;
};

const objectBranchProperties = (
    branch: JsonObject | undefined,
): JsonObject | undefined => {
    if (branch === undefined || branch.type !== "object") return undefined;
    const properties = branch.properties;
    return isJsonObject(properties) ? properties : undefined;
};

const discriminatorValues = (
    branches: readonly JsonObject[],
    key: string,
): readonly string[] | undefined => {
    const values: string[] = [];
    for (const branch of branches) {
        const value = constStringOf(objectBranchProperties(branch)?.[key]);
        if (value === undefined) return undefined;
        values.push(value);
    }
    return new Set(values).size === branches.length ? values : undefined;
};

type Discriminator = {
    readonly key: string;
    readonly values: readonly string[];
};

const findDiscriminator = (
    branches: readonly JsonObject[],
): Discriminator | undefined => {
    const first = objectBranchProperties(branches[0]);
    if (first === undefined) return undefined;
    for (const key of Object.keys(first)) {
        const values = discriminatorValues(branches, key);
        if (values !== undefined) return { key, values };
    }
    return undefined;
};

const mergeBranchProperty = (
    merged: JsonObject,
    discriminatorKey: string,
    key: string,
    schema: unknown,
): boolean => {
    if (key === discriminatorKey) return true;
    if (containsRef(schema)) return false;
    const existing = merged[key];
    if (existing !== undefined && stableJson(existing) !== stableJson(schema)) {
        return false;
    }
    merged[key] = schema;
    return true;
};

const mergeBranchProperties = (
    branches: readonly JsonObject[],
    discriminatorKey: string,
): JsonObject | undefined => {
    const merged: JsonObject = {};
    for (const branch of branches) {
        const properties = objectBranchProperties(branch);
        if (properties === undefined) return undefined;
        for (const [key, schema] of Object.entries(properties)) {
            if (!mergeBranchProperty(merged, discriminatorKey, key, schema)) {
                return undefined;
            }
        }
    }
    return merged;
};

const discriminatorProperty = (
    branches: readonly JsonObject[],
    discriminator: Discriminator,
): JsonObject => {
    const property: JsonObject = {
        type: "string",
        enum: [...discriminator.values],
    };
    const firstSchema = objectBranchProperties(branches[0])?.[
        discriminator.key
    ];
    if (
        isJsonObject(firstSchema) &&
        typeof firstSchema.description === "string"
    ) {
        property.description = firstSchema.description;
    }
    return property;
};

/**
 * Flatten a root-level discriminated union into a single object schema.
 *
 * The union's shared `const` discriminator becomes a string enum, every other
 * branch property is declared optional, and only the discriminator stays
 * required: JSON Schema cannot express the per-branch requirements without
 * constructs (`if`/`then`, conditional `required`) that providers handle even
 * less reliably than unions. Branch-specific rules keep being enforced by the
 * request's Zod validation. Anything the flattener cannot express with
 * confidence is returned unchanged.
 */
export const flattenDiscriminatedUnionForTool = (schema: unknown): unknown => {
    const branches = unionBranchesOf(schema);
    if (branches === undefined) return schema;
    if (
        branches.some((branch) => objectBranchProperties(branch) === undefined)
    ) {
        return schema;
    }
    const discriminator = findDiscriminator(branches);
    if (discriminator === undefined) return schema;
    const merged = mergeBranchProperties(branches, discriminator.key);
    if (merged === undefined) return schema;
    const root = schema as JsonObject;
    return {
        ...(typeof root.$schema === "string" ? { $schema: root.$schema } : {}),
        ...(typeof root.description === "string"
            ? { description: root.description }
            : {}),
        type: "object",
        properties: {
            [discriminator.key]: discriminatorProperty(branches, discriminator),
            ...merged,
        },
        required: [discriminator.key],
        additionalProperties: false,
    };
};

/**
 * Remove keys whose value is explicitly `null` at every object level.
 *
 * Strict provider-side constrained sampling must materialize optional
 * properties, so compliant models may answer with `null` for fields that only
 * one union branch allows. The Zod decision schemas reject explicit nulls, so
 * the tool boundary treats "present but null" as "absent" before validation.
 */
export const stripExplicitNulls = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((entry) => stripExplicitNulls(entry));
    }
    if (!isJsonObject(value)) return value;
    const stripped: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === null) continue;
        stripped[key] = stripExplicitNulls(entry);
    }
    return stripped;
};