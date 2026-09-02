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
 *
 * Flattened branch-only properties are optional, so strict constrained
 * samplers materialize every property of the flattened object (OpenAI-style
 * strict mode treats an optional property without a null admission as
 * required). The flattener therefore declares each combined property
 * explicitly nullable: scalar properties become `anyOf` unions with a null
 * variant (Pi's strict-schema conversion rejects object/array unions inside
 * `anyOf`, and TypeBox rejects `null` for a type-array whose `enum` does not
 * contain it), while object/array properties widen their `type` array with
 * `"null"`. The tool boundary treats "present but null" as "absent" before
 * the Zod validation runs.
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
):
    | {
          readonly merged: JsonObject;
          readonly memberOf: Map<string, ReadonlyArray<number>>;
      }
    | undefined => {
    const merged: JsonObject = {};
    const memberOf = new Map<string, number[]>();
    for (const [index, branch] of branches.entries()) {
        const properties = objectBranchProperties(branch);
        if (properties === undefined) return undefined;
        for (const [key, schema] of Object.entries(properties)) {
            if (!mergeBranchProperty(merged, discriminatorKey, key, schema)) {
                return undefined;
            }
            const members = memberOf.get(key);
            if (members === undefined) memberOf.set(key, [index]);
            else members.push(index);
        }
    }
    return { merged, memberOf };
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

const propertyTypesOf = (schema: JsonObject): readonly string[] | undefined => {
    const type = schema.type;
    if (typeof type === "string") return [type];
    if (
        Array.isArray(type) &&
        type.every((entry) => typeof entry === "string")
    ) {
        return type as readonly string[];
    }
    return undefined;
};

/**
 * Declare an optional merged property explicitly nullable.
 *
 * Scalar properties become `anyOf` unions because TypeBox rejects `null` for
 * a type-array whose `enum` does not contain it, and Pi's strict-schema
 * conversion rejects object and array unions inside `anyOf`, so object and
 * array properties widen their `type` array with `"null"` instead.
 */
const nullablePropertySchema = (schema: JsonObject): JsonObject | undefined => {
    const types = propertyTypesOf(schema);
    if (types === undefined) return undefined;
    if (types.includes("null")) return schema;
    if (types.some((entry) => entry === "object" || entry === "array")) {
        return { ...schema, type: [...types, "null"] };
    }
    return { anyOf: [schema, { type: "null" }] };
};

const describeBranchApplicability = (
    discriminator: Discriminator,
    memberOf: readonly number[],
    branchCount: number,
): string | undefined => {
    if (memberOf.length === 0 || memberOf.length === branchCount) {
        return undefined;
    }
    const options = memberOf
        .map((index) => discriminator.values[index])
        .map((value) => `"${value}"`)
        .join(" or ");
    return `Only applicable when ${discriminator.key} is ${options}; omit this property or set it to null for the other options.`;
};

const combinedProperties = (
    branches: readonly JsonObject[],
    discriminator: Discriminator,
    merged: JsonObject,
    memberOf: Map<string, ReadonlyArray<number>>,
): JsonObject => {
    const properties: JsonObject = {
        [discriminator.key]: discriminatorProperty(branches, discriminator),
    };
    for (const [name, rawSchema] of Object.entries(merged)) {
        const description = describeBranchApplicability(
            discriminator,
            memberOf.get(name) ?? [],
            branches.length,
        );
        const propertySchema = isJsonObject(rawSchema) ? rawSchema : {};
        const property =
            nullablePropertySchema(propertySchema) ?? propertySchema;
        properties[name] =
            description === undefined ? property : { ...property, description };
    }
    return properties;
};

/**
 * Flatten a root-level discriminated union into a single object schema.
 *
 * The union's shared `const` discriminator becomes a string enum, every other
 * branch property is declared optional and explicitly nullable, and only the
 * discriminator stays required: JSON Schema cannot express the per-branch
 * requirements without constructs (`if`/`then`, conditional `required`) that
 * providers handle even less reliably than unions. Branch-specific rules keep
 * being enforced by the request's Zod validation. Anything the flattener
 * cannot express with confidence is returned unchanged.
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
    const mergedStatus = mergeBranchProperties(branches, discriminator.key);
    if (mergedStatus === undefined) return schema;
    const root = schema as JsonObject;
    return {
        ...(typeof root.$schema === "string" ? { $schema: root.$schema } : {}),
        ...(typeof root.description === "string"
            ? { description: root.description }
            : {}),
        type: "object",
        properties: combinedProperties(
            branches,
            discriminator,
            mergedStatus.merged,
            mergedStatus.memberOf,
        ),
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

const enumValuesOf = (
    schema: JsonObject,
): ReadonlyArray<string> | undefined => {
    const candidates: unknown[] = [schema];
    if (Array.isArray(schema.anyOf)) candidates.push(...schema.anyOf);
    if (Array.isArray(schema.oneOf)) candidates.push(...schema.oneOf);
    for (const candidate of candidates) {
        if (!isJsonObject(candidate)) continue;
        if (
            !Array.isArray(candidate.enum) ||
            !candidate.enum.every(
                (value): value is string => typeof value === "string",
            )
        ) {
            continue;
        }
        return candidate.enum;
    }
    return undefined;
};

/**
 * Replace the literal string `"null"` with a real `null` for enum-typed
 * properties.
 *
 * A constrained sampler that must materialize every flattened property has no
 * way to express "not applicable" for an enum-typed field whose schema only
 * admits enum strings, and some of them emit the literal string `"null"`
 * instead. The string can never be a legitimate enum member, so the tool
 * boundary converts it to the sanctioned null representation before the
 * provider-side tool validation runs.
 */
export const normalizeEnumNullLiterals = (
    schema: unknown,
    value: unknown,
): unknown => {
    if (!isJsonObject(schema)) return value;
    if (Array.isArray(value)) return normalizeEnumNullArray(schema, value);
    if (isJsonObject(value)) return normalizeEnumNullObject(schema, value);
    return normalizeEnumNullScalar(schema, value);
};

const normalizeEnumNullArray = (
    schema: JsonObject,
    value: unknown[],
): unknown[] => {
    const items = isJsonObject(schema.items) ? schema.items : {};
    const mapped = value.map((entry) =>
        normalizeEnumNullLiterals(items, entry),
    );
    return mapped.every((entry, index) => entry === value[index])
        ? value
        : mapped;
};

const normalizeEnumNullObject = (
    schema: JsonObject,
    value: JsonObject,
): JsonObject => {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    let changed = false;
    const normalized: JsonObject = {};
    for (const [name, entry] of Object.entries(value)) {
        const propertySchema = isJsonObject(properties[name])
            ? properties[name]
            : undefined;
        const nested = normalizeEnumNullLiterals(propertySchema ?? {}, entry);
        normalized[name] = nested;
        if (nested !== entry) changed = true;
    }
    return changed ? normalized : value;
};

const normalizeEnumNullScalar = (
    schema: JsonObject,
    value: unknown,
): unknown =>
    value === "null"
        ? normalizeEnumNullLiteral(value, enumValuesOf(schema))
        : value;

const normalizeEnumNullLiteral = (
    value: string,
    options: ReadonlyArray<string> | undefined,
): unknown =>
    options !== undefined && !options.includes("null") ? null : value;