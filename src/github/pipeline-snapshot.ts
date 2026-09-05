import type { RateLimitMetadata } from "./rate-limit.ts";

/** JSON values are the boundary type for data returned by GitHub. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export type JsonObject = { readonly [key: string]: JsonValue };

export type ExactCommitSha = string;

export type PipelineSnapshotRequest = {
    readonly repository: string;
    readonly branch: string;
    readonly commitSha: ExactCommitSha;
};

export type PipelineObservationKind =
    | "check-run"
    | "check-suite"
    | "status-context"
    | "workflow-run";

export type PipelineRawState = {
    readonly status?: JsonValue;
    readonly state?: JsonValue;
    readonly conclusion?: JsonValue;
};

export type PipelineItemStatus =
    | "pending"
    | "passing"
    | "acceptable"
    | "failing"
    | "cancelled"
    | "unknown";
export type PipelineSnapshotReason =
    | "success"
    | "pending"
    | "failure"
    | "no-checks"
    | "timeout"
    | "unknown"
    | "cancelled"
    | "error";

export type PipelineProviderNameIdentity = {
    readonly provider: string;
    readonly name: string;
};

/** A raw observation is deliberately JSON-shaped so it can be kept in evidence. */
export type PipelineObservation = JsonObject & {
    readonly kind?: PipelineObservationKind;
    readonly type?: PipelineObservationKind;
    readonly provider?: JsonValue;
};

export type PipelineSourceError = {
    readonly source: string;
    readonly message: string;
    readonly rawValues?: JsonValue;
    readonly rateLimit?: RateLimitMetadata;
};

export type PipelineDiagnosticDisposition =
    | "selected"
    | "out-of-scope"
    | "incomplete";

export type PipelineIdentifier = string | number;

/**
 * IDs are copied only from the selected observation or a record with the same
 * workflow run identity. `rawValues` retains the complete source record.
 */
export type PipelineDiagnostic = {
    readonly source: PipelineObservationKind | "unknown";
    readonly disposition: PipelineDiagnosticDisposition;
    readonly provider?: string;
    readonly name?: string;
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly suiteId?: PipelineIdentifier;
    readonly checkRunId?: PipelineIdentifier;
    readonly jobId?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
    readonly runNumber?: PipelineIdentifier;
    readonly statusId?: PipelineIdentifier;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly rawState: PipelineRawState;
    readonly rawValues: JsonObject;
    readonly errors: ReadonlyArray<string>;
};

export type PipelineNormalizedItem = PipelineProviderNameIdentity & {
    readonly source: PipelineObservationKind;
    readonly status: PipelineItemStatus;
    readonly rawState: PipelineRawState;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly diagnostic: PipelineDiagnostic;
};

export type PipelineSnapshotState = "empty" | "non-empty";

export type PipelineSnapshot = PipelineSnapshotRequest & {
    readonly state: PipelineSnapshotState;
    readonly items: ReadonlyArray<PipelineNormalizedItem>;
    readonly sourceErrors: ReadonlyArray<PipelineSourceError>;
    readonly completenessErrors: ReadonlyArray<string>;
    readonly diagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly reason: PipelineSnapshotReason;
    readonly greenCandidate: boolean;
    readonly fingerprint: string;
};

export type PipelineSourceErrorInput =
    | PipelineSourceError
    | string
    | JsonObject;

export type PipelineSnapshotNormalizationInput =
    | (PipelineSnapshotRequest & {
          readonly observations?: ReadonlyArray<JsonValue>;
          readonly sourceErrors?: ReadonlyArray<PipelineSourceErrorInput>;
          readonly checkRuns?: ReadonlyArray<JsonValue>;
          readonly checkSuites?: ReadonlyArray<JsonValue>;
          readonly statusContexts?: ReadonlyArray<JsonValue>;
          readonly statuses?: ReadonlyArray<JsonValue>;
          readonly workflowRuns?: ReadonlyArray<JsonValue>;
      })
    | {
          readonly requested: PipelineSnapshotRequest;
          readonly observations?: ReadonlyArray<JsonValue>;
          readonly sourceErrors?: ReadonlyArray<PipelineSourceErrorInput>;
          readonly checkRuns?: ReadonlyArray<JsonValue>;
          readonly checkSuites?: ReadonlyArray<JsonValue>;
          readonly statusContexts?: ReadonlyArray<JsonValue>;
          readonly statuses?: ReadonlyArray<JsonValue>;
          readonly workflowRuns?: ReadonlyArray<JsonValue>;
      };

/** A suite ID is an identifier, not a stable check/context name. */
const CHECK_SUITE_FALLBACK_NAME = "(unnamed check suite)";

export const PIPELINE_CHECK_SUITE_FALLBACK_NAME = CHECK_SUITE_FALLBACK_NAME;

const defaultProvider: Record<PipelineObservationKind, string> = {
    "check-run": "github.check-run",
    "check-suite": "github.check-suite",
    "status-context": "github.status",
    "workflow-run": "github.workflow-run",
};

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const isObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const ownValue = (value: JsonObject, key: string): JsonValue | undefined =>
    hasOwn(value, key) ? value[key] : undefined;

const nestedObjects = (
    value: JsonObject,
    seen: Set<JsonObject> = new Set(),
): ReadonlyArray<JsonObject> => {
    if (seen.has(value)) return [];
    seen.add(value);
    const result: JsonObject[] = [value];
    for (const key of [
        "scope",
        "raw",
        "rawState",
        "checkSuite",
        "check_suite",
        "suite",
        "checkRun",
        "check_run",
        "workflowRun",
        "workflow_run",
        "run",
        "workflow",
        "job",
        "app",
    ]) {
        const nested = ownValue(value, key);
        if (isObject(nested)) result.push(...nestedObjects(nested, seen));
    }
    return result;
};

const valuesFor = (
    value: JsonObject,
    aliases: ReadonlyArray<string>,
): ReadonlyArray<JsonValue> =>
    nestedObjects(value).flatMap((source) =>
        aliases.flatMap((alias) => {
            const found = ownValue(source, alias);
            return found === undefined ? [] : [found];
        }),
    );

const firstValue = (
    value: JsonObject,
    aliases: ReadonlyArray<string>,
): JsonValue | undefined => valuesFor(value, aliases)[0];

const textValue = (value: JsonValue | undefined): string | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;

const normalizeToken = (value: JsonValue | undefined): string | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")
        : undefined;

type StateCategory =
    | "pending"
    | "passing"
    | "acceptable"
    | "failing"
    | "cancelled"
    | "complete";

const stateCategories: Record<string, StateCategory> = {
    queued: "pending",
    requested: "pending",
    waiting: "pending",
    pending: "pending",
    in_progress: "pending",
    success: "passing",
    neutral: "acceptable",
    skipped: "acceptable",
    failure: "failing",
    timed_out: "failing",
    error: "failing",
    action_required: "failing",
    startup_failure: "failing",
    cancelled: "cancelled",
    stale: "cancelled",
    superseded: "cancelled",
    completed: "complete",
};

const categoryFor = (
    value: JsonValue | undefined,
): StateCategory | "absent" | "unknown" => {
    if (value === undefined || value === null) return "absent";
    const token = normalizeToken(value);
    if (token === undefined) return "unknown";
    return hasOwn(stateCategories, token) ? stateCategories[token]! : "unknown";
};

type StateField = "status" | "state" | "conclusion";
type StateEntry = { readonly field: StateField; readonly value?: JsonValue };

const classifyEntries = (
    entries: ReadonlyArray<StateEntry>,
): PipelineItemStatus => {
    const categories = entries.map(({ value }) => categoryFor(value));
    if (categories.length === 0 || categories.includes("unknown"))
        return "unknown";
    if (
        entries.some(
            ({ field, value }) =>
                field === "conclusion" && categoryFor(value) === "complete",
        )
    )
        return "unknown";
    const present = categories.filter(
        (category): category is StateCategory => category !== "absent",
    );
    if (present.length === 0) return "unknown";

    const unique = [...new Set(present)];
    if (unique.includes("complete")) {
        if (unique.length === 1 || unique.includes("pending")) return "unknown";
        unique.splice(unique.indexOf("complete"), 1);
    }
    if (unique.length !== 1) return "unknown";
    return unique[0] === "pending" ||
        unique[0] === "passing" ||
        unique[0] === "acceptable" ||
        unique[0] === "failing" ||
        unique[0] === "cancelled"
        ? unique[0]
        : "unknown";
};

export const classifyPipelineState = (
    input: PipelineRawState,
): PipelineItemStatus => {
    const values = input as JsonObject;
    return classifyEntries([
        { field: "status", value: ownValue(values, "status") },
        { field: "state", value: ownValue(values, "state") },
        { field: "conclusion", value: ownValue(values, "conclusion") },
    ]);
};

export function classifyPipelineStatus(
    input: PipelineRawState,
): PipelineItemStatus;
export function classifyPipelineStatus(
    status: JsonValue | undefined,
    conclusion?: JsonValue,
    state?: JsonValue,
): PipelineItemStatus;
export function classifyPipelineStatus(
    inputOrStatus: PipelineRawState | JsonValue | undefined,
    conclusion?: JsonValue,
    state?: JsonValue,
): PipelineItemStatus {
    return isObject(inputOrStatus) &&
        (hasOwn(inputOrStatus, "status") ||
            hasOwn(inputOrStatus, "state") ||
            hasOwn(inputOrStatus, "conclusion"))
        ? classifyPipelineState(inputOrStatus)
        : classifyPipelineState({
              status: inputOrStatus,
              conclusion,
              state,
          });
}

const rawStateFor = (value: JsonObject): PipelineRawState => {
    const status = ownValue(value, "status");
    const state = ownValue(value, "state");
    const conclusion = ownValue(value, "conclusion");
    return {
        ...(status === undefined ? {} : { status }),
        ...(state === undefined ? {} : { state }),
        ...(conclusion === undefined ? {} : { conclusion }),
    };
};

const stateFor = (value: JsonObject): PipelineItemStatus =>
    classifyPipelineState(rawStateFor(value));

/** JSON-safe normalization shared by evidence budgeting and fingerprints. */
export const serializeJson = (
    value: unknown,
    seen: Set<object> = new Set(),
): JsonValue => {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : String(value);
    if (typeof value === "undefined") return null;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value))
        return value.map((entry) => serializeJson(entry, seen));

    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
        Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: serializeJson((value as Record<string, unknown>)[key], seen),
            writable: true,
        });
    }
    seen.delete(value);
    return result;
};

const serializedObject = (value: unknown): JsonObject => {
    const result = serializeJson(value);
    return isObject(result) ? result : { value: result };
};

type ScopeField = "repository" | "branch" | "sha";
type ScopeRead =
    | { readonly kind: "missing" }
    | { readonly kind: "invalid" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "value"; readonly value: string };

const scopeAliases: Record<ScopeField, ReadonlyArray<string>> = {
    repository: ["repository", "repo", "repositoryName"],
    branch: ["branch", "branchName", "headBranch", "head_branch"],
    sha: ["sha", "commitSha", "commit_sha", "headSha", "head_sha"],
};

const scopeEntries = (value: JsonValue): ReadonlyArray<JsonValue> =>
    value === null ? [] : Array.isArray(value) ? value : [value];

const normalizeScopeText = (value: string, field: ScopeField): string => {
    const text = value.trim();
    if (field === "branch") return text.replace(/^refs\/heads\//i, "");
    return text.toLowerCase();
};

const textValuesFor = (
    value: JsonValue,
    field: ScopeField,
): { readonly values: ReadonlyArray<string>; readonly invalid: boolean } => {
    const entries = scopeEntries(value);
    const valid = entries.filter(
        (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
    );
    return {
        values: valid.map((entry) => normalizeScopeText(entry, field)),
        invalid: entries.length > 0 && valid.length !== entries.length,
    };
};

const textValuesFrom = (
    values: ReadonlyArray<JsonValue>,
    field: ScopeField,
): { readonly values: ReadonlyArray<string>; readonly invalid: boolean } => {
    const parsed = values.map((value) => textValuesFor(value, field));
    return {
        values: parsed.flatMap((entry) => entry.values),
        invalid: parsed.some((entry) => entry.invalid),
    };
};

const readScopeField = (
    records: ReadonlyArray<JsonObject>,
    field: ScopeField,
): ScopeRead => {
    const values = records.flatMap((record) =>
        valuesFor(record, scopeAliases[field]),
    );
    const parsed = textValuesFrom(values, field);
    const unique = [...new Set(parsed.values)];
    if (parsed.invalid) return { kind: "invalid" };
    if (unique.length === 0) return { kind: "missing" };
    if (unique.length > 1) return { kind: "ambiguous" };
    return { kind: "value", value: unique[0]! };
};

const identifier = (
    value: JsonValue | undefined,
): PipelineIdentifier | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value
        : typeof value === "number" && Number.isFinite(value)
          ? value
          : undefined;

const identifierFrom = (
    value: JsonObject,
    aliases: ReadonlyArray<string>,
): PipelineIdentifier | undefined =>
    valuesFor(value, aliases)
        .map(identifier)
        .find((value): value is PipelineIdentifier => value !== undefined);

const nestedIdentifierFrom = (
    value: JsonObject,
    keys: ReadonlyArray<string>,
): PipelineIdentifier | undefined =>
    nestedObjects(value)
        .flatMap((record) => keys.map((key) => ownValue(record, key)))
        .filter(isObject)
        .map((nested) => identifierFrom(nested, ["id"]))
        .find((value): value is PipelineIdentifier => value !== undefined);

const kindOf = (
    value: JsonObject,
    fallback?: PipelineObservationKind,
): PipelineObservationKind | undefined => {
    const raw = firstValue(value, ["kind", "type"]);
    if (
        raw === "check-run" ||
        raw === "check-suite" ||
        raw === "status-context" ||
        raw === "workflow-run"
    )
        return raw;
    return fallback;
};

const firstTextValue = (
    value: JsonObject,
    aliases: ReadonlyArray<string>,
): string | undefined =>
    valuesFor(value, aliases)
        .map(textValue)
        .find((value): value is string => value !== undefined);

const providerOf = (
    value: JsonObject,
    kind: PipelineObservationKind,
): string => {
    const provider =
        firstTextValue(value, ["provider", "providerName", "provider_name"]) ??
        firstTextValue(value, ["slug"]);
    return provider ?? defaultProvider[kind];
};

const nameAliases: Record<PipelineObservationKind, ReadonlyArray<string>> = {
    "check-run": ["name", "checkName", "check_name", "context"],
    "check-suite": [
        "name",
        "workflowName",
        "workflow_name",
        "checkName",
        "check_name",
        "appName",
        "app_name",
    ],
    "status-context": ["context", "name", "checkName", "check_name"],
    "workflow-run": [
        "name",
        "workflowName",
        "workflow_name",
        "displayTitle",
        "display_title",
    ],
};

const nameOf = (
    value: JsonObject,
    kind: PipelineObservationKind,
): string | undefined =>
    firstTextValue(value, nameAliases[kind]) ??
    (kind === "check-suite" ? CHECK_SUITE_FALLBACK_NAME : undefined);

const metadataAliases = {
    runId: ["workflowRunId", "workflow_run_id", "runId", "run_id"],
    runAttempt: ["runAttempt", "run_attempt", "attempt"],
    suiteId: ["suiteId", "suite_id", "checkSuiteId", "check_suite_id"],
    checkRunId: ["checkRunId", "check_run_id"],
    jobId: ["jobId", "job_id"],
    workflowId: ["workflowId", "workflow_id"],
    runNumber: ["runNumber", "run_number"],
    statusId: ["statusId", "status_id"],
} as const;

type CandidateMetadata = {
    readonly runId?: PipelineIdentifier;
    readonly runAttempt?: PipelineIdentifier;
    readonly suiteId?: PipelineIdentifier;
    readonly checkRunId?: PipelineIdentifier;
    readonly jobId?: PipelineIdentifier;
    readonly workflowId?: PipelineIdentifier;
    readonly runNumber?: PipelineIdentifier;
    readonly statusId?: PipelineIdentifier;
    readonly createdAt?: string;
    readonly updatedAt?: string;
};

const timeValue = (value: JsonValue | undefined): string | undefined =>
    typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? value
        : undefined;

const metadataForRecord = (
    value: JsonObject,
    kind: PipelineObservationKind,
): CandidateMetadata => {
    const runId =
        identifierFrom(value, metadataAliases.runId) ??
        nestedIdentifierFrom(value, ["workflowRun", "workflow_run", "run"]) ??
        (kind === "workflow-run" ? identifierFrom(value, ["id"]) : undefined);
    const suiteId =
        identifierFrom(value, metadataAliases.suiteId) ??
        nestedIdentifierFrom(value, ["checkSuite", "check_suite", "suite"]) ??
        (kind === "check-suite" ? identifierFrom(value, ["id"]) : undefined);
    const checkRunId =
        identifierFrom(value, metadataAliases.checkRunId) ??
        nestedIdentifierFrom(value, ["checkRun", "check_run"]) ??
        (kind === "check-run" ? identifierFrom(value, ["id"]) : undefined);
    return {
        runId,
        runAttempt: identifierFrom(value, metadataAliases.runAttempt),
        suiteId,
        checkRunId,
        jobId:
            identifierFrom(value, metadataAliases.jobId) ??
            nestedIdentifierFrom(value, ["job"]),
        workflowId:
            identifierFrom(value, metadataAliases.workflowId) ??
            nestedIdentifierFrom(value, ["workflow"]),
        runNumber: identifierFrom(value, metadataAliases.runNumber),
        statusId:
            identifierFrom(value, metadataAliases.statusId) ??
            (kind === "status-context"
                ? identifierFrom(value, ["id"])
                : undefined),
        createdAt: timeValue(firstValue(value, ["createdAt", "created_at"])),
        updatedAt: timeValue(
            firstValue(value, ["updatedAt", "updated_at", "completedAt"]),
        ),
    };
};

const mergeMetadata = (
    records: ReadonlyArray<{
        readonly value: JsonObject;
        readonly kind: PipelineObservationKind;
    }>,
): CandidateMetadata => {
    const all = records.map(({ value, kind }) =>
        metadataForRecord(value, kind),
    );
    const first = <Key extends keyof CandidateMetadata>(
        key: Key,
    ): CandidateMetadata[Key] =>
        all
            .map((metadata) => metadata[key])
            .find((value) => value !== undefined);
    return {
        runId: first("runId"),
        runAttempt: first("runAttempt"),
        suiteId: first("suiteId"),
        checkRunId: first("checkRunId"),
        jobId: first("jobId"),
        workflowId: first("workflowId"),
        runNumber: first("runNumber"),
        statusId: first("statusId"),
        createdAt: first("createdAt"),
        updatedAt: first("updatedAt"),
    };
};

type Candidate = {
    readonly value: JsonObject;
    readonly kind: PipelineObservationKind;
    readonly provider: string;
    readonly name: string;
    readonly metadata: CandidateMetadata;
    readonly index: number;
};

const sameIdentifier = (
    left: PipelineIdentifier | undefined,
    right: PipelineIdentifier | undefined,
): boolean =>
    left !== undefined &&
    right !== undefined &&
    String(left).trim() === String(right).trim();

type ObservationIdentity = {
    readonly namespace: "workflow-run" | "check-suite";
    readonly value: PipelineIdentifier;
};

const runIdentity = (candidate: Candidate): ObservationIdentity | undefined => {
    if (candidate.metadata.runId !== undefined)
        return { namespace: "workflow-run", value: candidate.metadata.runId };
    if (
        (candidate.kind === "check-suite" || candidate.kind === "check-run") &&
        candidate.metadata.suiteId !== undefined
    )
        return {
            namespace: "check-suite",
            value: candidate.metadata.suiteId,
        };
    return undefined;
};

const sameIdentity = (
    left: ObservationIdentity | undefined,
    right: ObservationIdentity | undefined,
): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.namespace === right.namespace &&
    sameIdentifier(left.value, right.value);

const sameWorkflowRun = (left: Candidate, right: Candidate): boolean => {
    const leftIdentity = runIdentity(left);
    const rightIdentity = runIdentity(right);
    return (
        leftIdentity?.namespace === "workflow-run" &&
        rightIdentity?.namespace === "workflow-run" &&
        sameIdentifier(leftIdentity.value, rightIdentity.value)
    );
};

const sameRun = (left: Candidate, right: Candidate): boolean =>
    sameIdentity(runIdentity(left), runIdentity(right));

type CorrelatedRecord = {
    readonly value: JsonObject;
    readonly kind: PipelineObservationKind;
};

const correlationValues = (value: JsonObject): ReadonlyArray<JsonValue> =>
    ["correlated", "correlatedRecords", "correlation"].flatMap((key) => {
        const found = ownValue(value, key);
        return found === undefined ? [] : [found];
    });

const explicitCorrelations = (
    candidate: Candidate,
): ReadonlyArray<CorrelatedRecord> =>
    correlationValues(candidate.value).flatMap((value) => {
        const values = Array.isArray(value) ? value : [value];
        return values.flatMap((record) => {
            if (!isObject(record)) return [];
            const kind = kindOf(record, candidate.kind);
            return kind ? [{ value: record, kind }] : [];
        });
    });

const correlatedRecords = (
    candidate: Candidate,
    candidates: ReadonlyArray<Candidate>,
): ReadonlyArray<{
    readonly value: JsonObject;
    readonly kind: PipelineObservationKind;
}> => {
    const records = candidates
        .filter((other) => other !== candidate && sameRun(candidate, other))
        .map((other) => ({ value: other.value, kind: other.kind }));
    const candidateRun = runIdentity(candidate);
    return [
        ...records,
        ...explicitCorrelations(candidate).filter(({ value, kind }) =>
            sameIdentity(
                runIdentity({
                    value,
                    kind,
                    provider: providerOf(value, kind),
                    name: nameOf(value, kind) ?? "",
                    metadata: metadataForRecord(value, kind),
                    index: -1,
                }),
                candidateRun,
            ),
        ),
    ];
};

const scopeFor = (
    candidate: Candidate,
    candidates: ReadonlyArray<Candidate>,
): Readonly<Record<ScopeField, ScopeRead>> => {
    const records = [
        { value: candidate.value, kind: candidate.kind },
        ...correlatedRecords(candidate, candidates),
    ].map(({ value }) => value);
    return {
        repository: readScopeField(records, "repository"),
        branch: readScopeField(records, "branch"),
        sha: readScopeField(records, "sha"),
    };
};

type ScopeDisposition =
    | { readonly kind: "target" }
    | { readonly kind: "out-of-scope"; readonly reason: string }
    | { readonly kind: "incomplete"; readonly reasons: ReadonlyArray<string> };

const scopeMismatch = (
    scope: Readonly<Record<ScopeField, ScopeRead>>,
    request: PipelineSnapshotRequest,
): string | undefined => {
    if (
        scope.repository.kind === "value" &&
        scope.repository.value !== request.repository.trim().toLowerCase()
    )
        return "repository does not match";
    if (
        scope.branch.kind === "value" &&
        scope.branch.value !==
            request.branch.trim().replace(/^refs\/heads\//i, "")
    )
        return "branch does not match";
    if (
        scope.sha.kind === "value" &&
        scope.sha.value !== request.commitSha.toLowerCase()
    )
        return "commit SHA does not match";
    return undefined;
};

const scopeReasons = (
    scope: Readonly<Record<ScopeField, ScopeRead>>,
): ReadonlyArray<string> =>
    (["sha", "branch"] as const).flatMap((field) => {
        const result = scope[field];
        if (result.kind === "missing")
            return [
                `missing ${field === "sha" ? "exact commit SHA" : "branch"}`,
            ];
        if (result.kind === "invalid") return [`malformed ${field}`];
        if (result.kind === "ambiguous") return [`ambiguous ${field}`];
        return [];
    });

const scopeDisposition = (
    scope: Readonly<Record<ScopeField, ScopeRead>>,
    request: PipelineSnapshotRequest,
): ScopeDisposition => {
    const reasons = scopeReasons(scope);
    if (
        reasons.length > 0 ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(request.commitSha)
    )
        return {
            kind: "incomplete",
            reasons:
                reasons.length > 0
                    ? reasons
                    : ["requested commit SHA is not an exact Git object ID"],
        };
    const mismatch = scopeMismatch(scope, request);
    return mismatch === undefined
        ? { kind: "target" }
        : { kind: "out-of-scope", reason: mismatch };
};

const numericIdentifier = (
    value: PipelineIdentifier | undefined,
): bigint | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "number")
        return Number.isFinite(value) && Number.isInteger(value)
            ? BigInt(value)
            : undefined;
    const text = value.trim();
    return /^\d+$/.test(text) ? BigInt(text) : undefined;
};

const compareOptionalNumbers = (
    left: PipelineIdentifier | undefined,
    right: PipelineIdentifier | undefined,
): number => {
    const leftNumber = numericIdentifier(left);
    const rightNumber = numericIdentifier(right);
    if (leftNumber === undefined && rightNumber === undefined) return 0;
    if (leftNumber === undefined) return -1;
    if (rightNumber === undefined) return 1;
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
};

const compareTimes = (
    left: string | undefined,
    right: string | undefined,
): number => {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    return leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1;
};

const compareText = (
    left: PipelineIdentifier | undefined,
    right: PipelineIdentifier | undefined,
): number => {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftText = String(left);
    const rightText = String(right);
    return leftText === rightText ? 0 : leftText > rightText ? 1 : -1;
};

const compareIdentifiers = (
    left: PipelineIdentifier | undefined,
    right: PipelineIdentifier | undefined,
): number => {
    const numeric = compareOptionalNumbers(left, right);
    return numeric === 0 ? compareText(left, right) : numeric;
};

const compareObservationIdentities = (
    left: ObservationIdentity | undefined,
    right: ObservationIdentity | undefined,
): number => {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const namespaces = compareText(left.namespace, right.namespace);
    return namespaces === 0
        ? compareIdentifiers(left.value, right.value)
        : namespaces;
};

const compareDistinctRuns = (left: Candidate, right: Candidate): number => {
    const created = compareTimes(
        left.metadata.createdAt,
        right.metadata.createdAt,
    );
    if (created !== 0) return created;

    const sameWorkflow = sameIdentifier(
        left.metadata.workflowId,
        right.metadata.workflowId,
    );
    if (sameWorkflow) {
        const runNumbers = compareOptionalNumbers(
            left.metadata.runNumber,
            right.metadata.runNumber,
        );
        if (runNumbers !== 0) return runNumbers;
    }
    return compareObservationIdentities(runIdentity(left), runIdentity(right));
};

const compareCandidateTie = (left: Candidate, right: Candidate): number => {
    const updated = compareTimes(
        left.metadata.updatedAt,
        right.metadata.updatedAt,
    );
    if (updated !== 0) return updated;
    const checkRuns = compareIdentifiers(
        left.metadata.checkRunId,
        right.metadata.checkRunId,
    );
    if (checkRuns !== 0) return checkRuns;
    const statuses = compareIdentifiers(
        left.metadata.statusId,
        right.metadata.statusId,
    );
    if (statuses !== 0) return statuses;
    const raw = compareText(
        JSON.stringify(serializedObject(left.value)),
        JSON.stringify(serializedObject(right.value)),
    );
    if (raw !== 0) return raw;
    return left.index === right.index ? 0 : left.index > right.index ? 1 : -1;
};

const compareCandidates = (left: Candidate, right: Candidate): number => {
    const recency = sameWorkflowRun(left, right)
        ? compareOptionalNumbers(
              left.metadata.runAttempt,
              right.metadata.runAttempt,
          )
        : compareDistinctRuns(left, right);
    return recency === 0 ? compareCandidateTie(left, right) : recency;
};

const selectedCandidate = (candidates: ReadonlyArray<Candidate>): Candidate =>
    candidates.reduce((selected, candidate) =>
        compareCandidates(candidate, selected) > 0 ? candidate : selected,
    );

const metadataForCandidate = (
    candidate: Candidate,
    candidates: ReadonlyArray<Candidate>,
): CandidateMetadata =>
    mergeMetadata([
        { value: candidate.value, kind: candidate.kind },
        ...correlatedRecords(candidate, candidates),
    ]);

const rawStateError = (status: PipelineItemStatus): ReadonlyArray<string> =>
    status === "unknown"
        ? [
              "State, status, or conclusion is unknown, malformed, or contradictory.",
          ]
        : [];

const diagnosticFor = (input: {
    readonly candidate?: Candidate;
    readonly disposition: PipelineDiagnosticDisposition;
    readonly errors: ReadonlyArray<string>;
    readonly candidates: ReadonlyArray<Candidate>;
}): PipelineDiagnostic => {
    if (input.candidate === undefined) {
        return {
            source: "unknown",
            disposition: input.disposition,
            rawState: {},
            rawValues: {},
            errors: input.errors,
        };
    }
    const metadata = metadataForCandidate(input.candidate, input.candidates);
    return {
        source: input.candidate.kind,
        disposition: input.disposition,
        provider: input.candidate.provider,
        name: input.candidate.name,
        ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
        ...(metadata.runAttempt === undefined
            ? {}
            : { runAttempt: metadata.runAttempt }),
        ...(metadata.suiteId === undefined
            ? {}
            : { suiteId: metadata.suiteId }),
        ...(metadata.checkRunId === undefined
            ? {}
            : { checkRunId: metadata.checkRunId }),
        ...(metadata.jobId === undefined ? {} : { jobId: metadata.jobId }),
        ...(metadata.workflowId === undefined
            ? {}
            : { workflowId: metadata.workflowId }),
        ...(metadata.runNumber === undefined
            ? {}
            : { runNumber: metadata.runNumber }),
        ...(metadata.statusId === undefined
            ? {}
            : { statusId: metadata.statusId }),
        ...(metadata.createdAt === undefined
            ? {}
            : { createdAt: metadata.createdAt }),
        ...(metadata.updatedAt === undefined
            ? {}
            : { updatedAt: metadata.updatedAt }),
        rawState: rawStateFor(input.candidate.value),
        rawValues: serializedObject(input.candidate.value),
        errors: input.errors,
    };
};

const finiteNumber = (value: JsonValue | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value);

const numericRateLimitField = <Key extends string>(
    value: JsonObject,
    key: Key,
): Record<Key, number> | Record<never, never> => {
    const field = ownValue(value, key);
    return finiteNumber(field) ? ({ [key]: field } as Record<Key, number>) : {};
};

const textNumberRateLimitField = <Key extends string>(
    value: JsonObject,
    key: Key,
): Record<Key, string | number> | Record<never, never> => {
    const field = ownValue(value, key);
    return typeof field === "string" || typeof field === "number"
        ? ({ [key]: field } as Record<Key, string | number>)
        : {};
};

const rateLimitFor = (
    value: JsonValue | undefined,
): RateLimitMetadata | undefined => {
    if (!isObject(value)) return undefined;
    const metadata = {
        ...numericRateLimitField(value, "resetAtMs"),
        ...numericRateLimitField(value, "retryAfterMs"),
        ...textNumberRateLimitField(value, "retryAfter"),
        ...textNumberRateLimitField(value, "resetAt"),
        ...(() => {
            const headers = ownValue(value, "headers");
            return isObject(headers) ? { headers } : {};
        })(),
        ...numericRateLimitField(value, "remaining"),
    };
    return Object.keys(metadata).length === 0 ? undefined : metadata;
};

const sourceErrorFor = (
    value: PipelineSourceErrorInput,
): PipelineSourceError => {
    if (typeof value === "string") return { source: "unknown", message: value };
    if (!isObject(value)) {
        return {
            source: "unknown",
            message: "Unspecified source error.",
            rawValues: serializeJson(value),
        };
    }
    const source = textValue(ownValue(value, "source")) ?? "unknown";
    const message =
        textValue(ownValue(value, "message")) ?? "Unspecified source error.";
    const rawValues = ownValue(value, "rawValues") ?? ownValue(value, "raw");
    const rateLimit = rateLimitFor(ownValue(value, "rateLimit"));
    return {
        source,
        message,
        ...(rawValues === undefined
            ? {}
            : { rawValues: serializeJson(rawValues) }),
        ...(rateLimit === undefined ? {} : { rateLimit }),
    };
};

const requestText = (value: unknown): string =>
    typeof value === "string" ? value : "";

const requestFor = (
    input: PipelineSnapshotNormalizationInput,
): PipelineSnapshotRequest => {
    const requestedInput = "requested" in input ? input.requested : input;
    const requested = isObject(requestedInput) ? requestedInput : {};
    return {
        repository: requestText(ownValue(requested, "repository")),
        branch: requestText(ownValue(requested, "branch")),
        commitSha: requestText(ownValue(requested, "commitSha")),
    };
};

const arrayWithKind = (
    values: ReadonlyArray<JsonValue> | undefined,
    kind: PipelineObservationKind,
): ReadonlyArray<JsonValue> =>
    (values ?? []).map((value) => {
        if (!isObject(value) || hasOwn(value, "kind") || hasOwn(value, "type"))
            return value;
        return { ...value, kind };
    });

const observationsFor = (
    input: PipelineSnapshotNormalizationInput,
): ReadonlyArray<JsonValue> => [
    ...(input.observations ?? []),
    ...arrayWithKind(input.checkRuns, "check-run"),
    ...arrayWithKind(input.checkSuites, "check-suite"),
    ...arrayWithKind(input.statusContexts, "status-context"),
    ...arrayWithKind(input.statuses, "status-context"),
    ...arrayWithKind(input.workflowRuns, "workflow-run"),
];

const candidateFor = (
    value: JsonValue,
    index: number,
): Candidate | undefined => {
    if (!isObject(value)) return undefined;
    const kind = kindOf(value);
    if (kind === undefined) return undefined;
    const name = nameOf(value, kind);
    if (name === undefined) return undefined;
    return {
        value,
        kind,
        provider: providerOf(value, kind),
        name,
        metadata: metadataForRecord(value, kind),
        index,
    };
};

const malformedDiagnostic = (
    value: JsonValue,
    message: string,
): PipelineDiagnostic => ({
    source: "unknown",
    disposition: "incomplete",
    rawState: isObject(value) ? rawStateFor(value) : {},
    rawValues: serializedObject(value),
    errors: [message],
});

const requestErrors = (
    request: PipelineSnapshotRequest,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    if (request.repository.trim().length === 0)
        errors.push("requested repository is missing");
    if (request.branch.trim().length === 0)
        errors.push("requested branch is missing");
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(request.commitSha))
        errors.push("requested commit SHA is not an exact Git object ID");
    return errors;
};

type ParsedObservations = {
    readonly candidates: ReadonlyArray<Candidate>;
    readonly diagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly completenessErrors: ReadonlyArray<string>;
};

const parseObservations = (
    values: ReadonlyArray<JsonValue>,
): ParsedObservations => {
    const candidates: Candidate[] = [];
    const diagnostics: PipelineDiagnostic[] = [];
    const completenessErrors: string[] = [];
    for (const [index, value] of values.entries()) {
        const candidate = candidateFor(value, index);
        if (candidate) {
            candidates.push(candidate);
            continue;
        }
        const message = isObject(value)
            ? "Observation has an unknown kind or no stable name."
            : "Observation is not a JSON object.";
        diagnostics.push(malformedDiagnostic(value, message));
        completenessErrors.push(message);
    }
    return { candidates, diagnostics, completenessErrors };
};

type ScopedGroups = {
    readonly groups: ReadonlyArray<ReadonlyArray<Candidate>>;
    readonly diagnostics: ReadonlyArray<PipelineDiagnostic>;
    readonly completenessErrors: ReadonlyArray<string>;
};

const scopedGroupsFor = (
    candidates: ReadonlyArray<Candidate>,
    request: PipelineSnapshotRequest,
): ScopedGroups => {
    const grouped = new Map<string, Candidate[]>();
    const diagnostics: PipelineDiagnostic[] = [];
    const completenessErrors: string[] = [];
    for (const candidate of candidates) {
        const scope = scopeDisposition(
            scopeFor(candidate, candidates),
            request,
        );
        if (scope.kind === "out-of-scope") {
            diagnostics.push(
                diagnosticFor({
                    candidate,
                    disposition: "out-of-scope",
                    errors: [scope.reason],
                    candidates,
                }),
            );
            continue;
        }
        if (scope.kind === "incomplete") {
            diagnostics.push(
                diagnosticFor({
                    candidate,
                    disposition: "incomplete",
                    errors: scope.reasons,
                    candidates,
                }),
            );
            completenessErrors.push(...scope.reasons);
            continue;
        }
        const key = JSON.stringify([
            candidate.kind,
            candidate.provider,
            candidate.name,
        ]);
        const group = grouped.get(key) ?? [];
        group.push(candidate);
        grouped.set(key, group);
    }
    return {
        groups: [...grouped.values()],
        diagnostics,
        completenessErrors,
    };
};

const itemsForGroups = (
    groups: ReadonlyArray<ReadonlyArray<Candidate>>,
    candidates: ReadonlyArray<Candidate>,
): {
    readonly items: ReadonlyArray<PipelineNormalizedItem>;
    readonly diagnostics: ReadonlyArray<PipelineDiagnostic>;
} => {
    const items: PipelineNormalizedItem[] = [];
    const diagnostics: PipelineDiagnostic[] = [];
    for (const group of groups) {
        const candidate = selectedCandidate(group);
        const status = stateFor(candidate.value);
        const diagnostic = diagnosticFor({
            candidate,
            disposition: "selected",
            errors: rawStateError(status),
            candidates,
        });
        items.push({
            source: candidate.kind,
            provider: candidate.provider,
            name: candidate.name,
            status,
            rawState: diagnostic.rawState,
            ...(diagnostic.createdAt === undefined
                ? {}
                : { createdAt: diagnostic.createdAt }),
            ...(diagnostic.updatedAt === undefined
                ? {}
                : { updatedAt: diagnostic.updatedAt }),
            diagnostic,
        });
        diagnostics.push(diagnostic);
    }
    items.sort((left, right) =>
        `${left.source}\u0000${left.provider}\u0000${left.name}`.localeCompare(
            `${right.source}\u0000${right.provider}\u0000${right.name}`,
        ),
    );
    return { items, diagnostics };
};

const inputForCall = (
    inputOrRequest:
        | PipelineSnapshotNormalizationInput
        | PipelineSnapshotRequest,
    observations: ReadonlyArray<JsonValue>,
    sourceErrors: ReadonlyArray<PipelineSourceErrorInput>,
): PipelineSnapshotNormalizationInput =>
    "observations" in inputOrRequest ||
    "requested" in inputOrRequest ||
    "checkRuns" in inputOrRequest ||
    "checkSuites" in inputOrRequest ||
    "statusContexts" in inputOrRequest ||
    "statuses" in inputOrRequest ||
    "workflowRuns" in inputOrRequest
        ? (inputOrRequest as PipelineSnapshotNormalizationInput)
        : { ...inputOrRequest, observations, sourceErrors };

export const isPipelineGreenCandidate = (
    snapshot: Pick<
        PipelineSnapshot,
        "items" | "sourceErrors" | "completenessErrors"
    >,
): boolean =>
    snapshot.items.length > 0 &&
    snapshot.sourceErrors.length === 0 &&
    snapshot.completenessErrors.length === 0 &&
    snapshot.items.every((item) => item.status === "passing");

const rawTokensFor = (item: PipelineNormalizedItem): ReadonlyArray<string> =>
    [item.rawState.status, item.rawState.state, item.rawState.conclusion]
        .map(normalizeToken)
        .filter((value): value is string => value !== undefined);

const hasRawToken = (
    items: ReadonlyArray<PipelineNormalizedItem>,
    token: string,
): boolean => items.some((item) => rawTokensFor(item).includes(token));

/**
 * Reduce every effective context. Known terminal non-success results outrank
 * pending work. Neutral and skipped are deliberately classified as failure:
 * they are terminal but do not prove that the requested SHA passed.
 */
export const pipelineSnapshotReason = (
    snapshot: Pick<
        PipelineSnapshot,
        "items" | "sourceErrors" | "completenessErrors"
    >,
): PipelineSnapshotReason => {
    if (snapshot.sourceErrors.length > 0)
        return snapshot.sourceErrors.every(({ message }) =>
            /time(?:d)?[ -]?out/i.test(message),
        )
            ? "timeout"
            : "error";
    if (snapshot.completenessErrors.length > 0) return "unknown";
    if (snapshot.items.length === 0) return "no-checks";
    if (snapshot.items.some(({ status }) => status === "unknown"))
        return "unknown";
    if (hasRawToken(snapshot.items, "error")) return "error";
    if (hasRawToken(snapshot.items, "timed_out")) return "timeout";
    if (snapshot.items.some(({ status }) => status === "failing"))
        return "failure";
    if (snapshot.items.some(({ status }) => status === "cancelled"))
        return "cancelled";
    if (snapshot.items.some(({ status }) => status === "acceptable"))
        return "failure";
    if (snapshot.items.some(({ status }) => status === "pending"))
        return "pending";
    return "success";
};

const canonicalJson = (value: JsonValue): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (isObject(value))
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`,
            )
            .join(",")}}`;
    return JSON.stringify(value);
};

type PipelineFingerprintInput = Pick<
    PipelineSnapshot,
    | "repository"
    | "branch"
    | "commitSha"
    | "state"
    | "items"
    | "sourceErrors"
    | "completenessErrors"
    | "reason"
>;

/** A canonical, order-independent identity for stable-snapshot confirmation. */
export const pipelineSnapshotFingerprint = (
    snapshot: PipelineFingerprintInput,
): string =>
    canonicalJson(
        serializeJson({
            repository: snapshot.repository,
            branch: snapshot.branch,
            commitSha: snapshot.commitSha,
            state: snapshot.state,
            reason: snapshot.reason,
            items: [...snapshot.items],
            sourceErrors: [...snapshot.sourceErrors].sort((left, right) =>
                canonicalJson(serializeJson(left)).localeCompare(
                    canonicalJson(serializeJson(right)),
                ),
            ),
            completenessErrors: [...snapshot.completenessErrors].sort(),
        }),
    );

export const haveSamePipelineSnapshot = (
    left: Pick<PipelineSnapshot, "fingerprint">,
    right: Pick<PipelineSnapshot, "fingerprint">,
): boolean => left.fingerprint === right.fingerprint;

export function normalizePipelineSnapshot(
    input: PipelineSnapshotNormalizationInput,
): PipelineSnapshot;
export function normalizePipelineSnapshot(
    request: PipelineSnapshotRequest,
    observations: ReadonlyArray<JsonValue>,
    sourceErrors?: ReadonlyArray<PipelineSourceErrorInput>,
): PipelineSnapshot;
export function normalizePipelineSnapshot(
    inputOrRequest:
        | PipelineSnapshotNormalizationInput
        | PipelineSnapshotRequest,
    observations: ReadonlyArray<JsonValue> = [],
    sourceErrors: ReadonlyArray<PipelineSourceErrorInput> = [],
): PipelineSnapshot {
    const input = inputForCall(inputOrRequest, observations, sourceErrors);
    const request = requestFor(input);
    const parsed = parseObservations(observationsFor(input));
    const scoped = scopedGroupsFor(parsed.candidates, request);
    const normalized = itemsForGroups(scoped.groups, parsed.candidates);
    const completenessErrors = [
        ...requestErrors(request),
        ...parsed.completenessErrors,
        ...scoped.completenessErrors,
    ];
    const diagnostics = [
        ...parsed.diagnostics,
        ...scoped.diagnostics,
        ...normalized.diagnostics,
    ];
    const normalizedSourceErrors = (input.sourceErrors ?? sourceErrors).map(
        sourceErrorFor,
    );
    const snapshotBase = {
        ...request,
        state:
            normalized.items.length === 0
                ? ("empty" as const)
                : ("non-empty" as const),
        items: normalized.items,
        sourceErrors: normalizedSourceErrors,
        completenessErrors,
        diagnostics,
    };
    const reason = pipelineSnapshotReason(snapshotBase);
    const withReason = { ...snapshotBase, reason };
    return {
        ...withReason,
        greenCandidate: reason === "success",
        fingerprint: pipelineSnapshotFingerprint(withReason),
    };
}