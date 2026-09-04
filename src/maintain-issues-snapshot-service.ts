/**
 * Immutable maintenance snapshot assembly.
 *
 * The GitHub reader and checkout grounding reader each own one read-only
 * source. This module is the integration boundary used by the future
 * maintenance planner: it invokes both sources once, applies the configured
 * prompt budgets, copies every value into a frozen read model, and computes a
 * fingerprint over the fields that can invalidate a plan. Capture timestamps
 * and run identities are deliberately metadata only; two equivalent sources
 * must have the same fingerprint even when they were captured at different
 * times.
 */
import { createHash } from "node:crypto";
import type { Octokit } from "octokit";

import { type GitHubClientService } from "./github/client.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import {
    loadMaintainabilitySnapshot,
    type MaintainSelectionInput,
    type MaintainableSnapshot,
} from "./maintain/github-reader.ts";
import type { MaintainableIssueSummary } from "./maintain/github-reader/lists.ts";
import {
    DEFAULT_GUIDANCE_AGGREGATE_BYTE_LIMIT,
    DEFAULT_GUIDANCE_PER_FILE_BYTE_LIMIT,
    MaintainIssuesGroundingReaderLive,
    normalizeGroundingSkipReason,
    type GroundingReadOutcome,
    type GroundingReaderService,
    type GroundingSkip,
    type GuidanceBundle,
    type GuidanceFile,
    type GuidanceReadOptions,
    type RepositoryGrounding,
    validateGuidanceLimit,
} from "./maintain-issues-grounding-reader.ts";
import {
    createMaintainableIssue,
    createMaintainableSkip,
    normalizeMaintainableActor,
    normalizeMaintainableAvailability,
    normalizeMaintainableIssueState,
    normalizeMaintainableLabel,
    normalizeMaintainableSkip,
    type MaintainableActor,
    type MaintainableAvailability,
    type MaintainableComment,
    type MaintainableIssue,
    type MaintainableLabel,
    type MaintainableSelectedThread,
    type MaintainableSkip,
} from "./maintain-issues-snapshot.ts";
import {
    DEFAULT_MAINTAIN_AGGREGATE_PROMPT_LIMIT,
    DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT,
    DEFAULT_MAINTAIN_THREAD_PROMPT_LIMIT,
    type MaintainReaderDetailOptions,
} from "./maintain/github-reader/details.ts";
import {
    projectThreadPrompt,
    validateThreadPromptLimit,
    type ThreadPromptProjectionResult,
} from "./maintain-thread-projection.ts";
import { RalphieError } from "./shared/error.ts";
import { throwIfAborted } from "./maintain/github-reader/diagnostics.ts";

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

const nullableText = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

const nonNegativeInteger = (value: unknown, fallback = 0): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : fallback;

const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

/**
 * Clone JSON-like API evidence into plain frozen values. The maintenance
 * contract does not expose raw API objects, but the existing reader retains a
 * bounded `raw` evidence copy for diagnostics. Treating class instances as
 * plain records keeps this boundary safe for test doubles as well as Octokit.
 */
const cloneDeepFrozen = (
    value: unknown,
    seen = new WeakMap<object, unknown>(),
): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        seen.set(value, copy);
        for (const entry of value) copy.push(cloneDeepFrozen(entry, seen));
        return Object.freeze(copy);
    }
    const copy: RecordLike = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
        copy[key] = cloneDeepFrozen((value as RecordLike)[key], seen);
    }
    return Object.freeze(copy);
};

const frozenRecord = (value: unknown): Readonly<RecordLike> => {
    const copy = cloneDeepFrozen(value);
    return isRecord(copy) ? copy : Object.freeze({});
};

const markerValue = (value: unknown): unknown =>
    value === undefined ? null : cloneDeepFrozen(value);

const digestText = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

const bodyFingerprint = (body: string | null): RecordLike => ({
    present: body !== null,
    length: body === null ? 0 : body.length,
    digest: body === null ? null : digestText(body),
});

/** Canonical JSON with sorted object keys and explicit cycle handling. */
export const canonicalMaintenanceJson = (
    value: unknown,
    seen = new Set<object>(),
): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value !== "object") return canonicalScalar(value);
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const result = Array.isArray(value)
        ? canonicalArray(value, seen)
        : canonicalObject(value, seen);
    seen.delete(value);
    return result;
};

const canonicalScalar = (value: unknown): string => {
    if (typeof value === "number" && !Number.isFinite(value)) {
        return JSON.stringify(String(value));
    }
    if (typeof value === "string" || typeof value === "number") {
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    return JSON.stringify(String(value));
};

const canonicalArray = (
    value: ReadonlyArray<unknown>,
    seen: Set<object>,
): string =>
    `[${value.map((entry) => canonicalMaintenanceJson(entry, seen)).join(",")}]`;

const canonicalObject = (value: object, seen: Set<object>): string =>
    `{${Object.keys(value)
        .sort(compareText)
        .map(
            (key) =>
                `${JSON.stringify(key)}:${canonicalMaintenanceJson((value as RecordLike)[key], seen)}`,
        )
        .join(",")}}`;

const compareCanonical = (left: unknown, right: unknown): number =>
    compareText(
        canonicalMaintenanceJson(left),
        canonicalMaintenanceJson(right),
    );

export type MaintenanceSnapshotBudgets = {
    readonly commentPromptLimit: number;
    readonly threadPromptLimit: number;
    readonly aggregatePromptLimit: number;
    readonly guidancePerFileByteLimit: number;
    readonly guidanceAggregateByteLimit: number;
};

export type MaintenanceSnapshotBudgetOverrides =
    Partial<MaintenanceSnapshotBudgets>;

export const DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS: MaintenanceSnapshotBudgets =
    Object.freeze({
        commentPromptLimit: DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT,
        threadPromptLimit: DEFAULT_MAINTAIN_THREAD_PROMPT_LIMIT,
        aggregatePromptLimit: DEFAULT_MAINTAIN_AGGREGATE_PROMPT_LIMIT,
        guidancePerFileByteLimit: DEFAULT_GUIDANCE_PER_FILE_BYTE_LIMIT,
        guidanceAggregateByteLimit: DEFAULT_GUIDANCE_AGGREGATE_BYTE_LIMIT,
    });

export const DEFAULT_MAINTENANCE_SNAPSHOT_LIMITS =
    DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS;

const normalizeSelection = (
    input: MaintainSelectionInput = {},
): MaintainSelectionInput => {
    if (
        input.maxIssues !== undefined &&
        (!Number.isSafeInteger(input.maxIssues) || input.maxIssues < 0)
    ) {
        throw new RangeError("maxIssues must be a non-negative integer.");
    }
    const labels = [...(input.issueLabels ?? [])].sort((left, right) => {
        const insensitive = compareText(
            left.toLowerCase(),
            right.toLowerCase(),
        );
        return insensitive === 0 ? compareText(left, right) : insensitive;
    });
    if (
        input.issueSort !== undefined &&
        !Object.values(IssueSort).includes(input.issueSort)
    ) {
        throw new RangeError(
            `Unsupported maintenance issue sort: ${String(input.issueSort)}.`,
        );
    }
    if (
        input.issueOrder !== undefined &&
        !Object.values(IssueOrder).includes(input.issueOrder)
    ) {
        throw new RangeError(
            `Unsupported maintenance issue order: ${String(input.issueOrder)}.`,
        );
    }
    return Object.freeze({
        ...(input.maxIssues === undefined
            ? {}
            : { maxIssues: input.maxIssues }),
        issueLabels: Object.freeze(labels),
        issueSort: input.issueSort ?? IssueSort.Created,
        issueOrder: input.issueOrder ?? IssueOrder.Ascending,
    });
};

const normalizeBudgets = (
    request: MaintenanceSnapshotRequest,
): MaintenanceSnapshotBudgets => {
    const override = request.budgets ?? request.limits ?? {};
    const detailOptions = request.detailOptions ?? {};
    const guidanceOptions = request.guidanceOptions ?? {};
    const commentPromptLimit = validateThreadPromptLimit(
        "comment prompt limit",
        request.commentPromptLimit ??
            override.commentPromptLimit ??
            detailOptions.commentPromptLimit ??
            DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS.commentPromptLimit,
    );
    const threadPromptLimit = validateThreadPromptLimit(
        "thread prompt limit",
        request.threadPromptLimit ??
            override.threadPromptLimit ??
            detailOptions.threadPromptLimit ??
            DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS.threadPromptLimit,
    );
    const aggregatePromptLimit = validateThreadPromptLimit(
        "aggregate prompt limit",
        request.aggregatePromptLimit ??
            override.aggregatePromptLimit ??
            detailOptions.aggregatePromptLimit ??
            DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS.aggregatePromptLimit,
    );
    const guidancePerFileByteLimit = validateGuidanceLimit(
        "per-file guidance byte limit",
        request.guidancePerFileByteLimit ??
            override.guidancePerFileByteLimit ??
            guidanceOptions.perFileByteLimit ??
            DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS.guidancePerFileByteLimit,
    );
    const guidanceAggregateByteLimit = validateGuidanceLimit(
        "aggregate guidance byte limit",
        request.guidanceAggregateByteLimit ??
            override.guidanceAggregateByteLimit ??
            guidanceOptions.aggregateByteLimit ??
            DEFAULT_MAINTENANCE_SNAPSHOT_BUDGETS.guidanceAggregateByteLimit,
    );
    return Object.freeze({
        commentPromptLimit,
        threadPromptLimit,
        aggregatePromptLimit,
        guidancePerFileByteLimit,
        guidanceAggregateByteLimit,
    });
};

export type MaintenanceSnapshotRequest = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    /** Optional when the service has a GitHub client dependency. */
    readonly client?: Octokit;
    readonly signal?: AbortSignal;
    readonly runId?: string;
    /** Test/replay seam for deterministic capture metadata. */
    readonly capturedAt?: string;
    readonly selection?: MaintainSelectionInput;
    readonly budgets?: MaintenanceSnapshotBudgetOverrides;
    readonly limits?: MaintenanceSnapshotBudgetOverrides;
    readonly detailOptions?: MaintainReaderDetailOptions;
    readonly guidanceOptions?: GuidanceReadOptions;
    readonly commentPromptLimit?: number;
    readonly threadPromptLimit?: number;
    readonly aggregatePromptLimit?: number;
    readonly guidancePerFileByteLimit?: number;
    readonly guidanceAggregateByteLimit?: number;
};

export type MaintenanceSnapshotInput = MaintenanceSnapshotRequest;
export type MaintenanceSnapshotCaptureInput = MaintenanceSnapshotRequest;

export type MaintenanceSnapshotGitHubReaderInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly selection: MaintainSelectionInput;
    readonly signal?: AbortSignal;
    readonly detailOptions: MaintainReaderDetailOptions;
};

export type MaintenanceSnapshotGitHubReader = {
    readonly read: (
        input: MaintenanceSnapshotGitHubReaderInput,
    ) => Promise<MaintainableSnapshot>;
};

export type MaintenanceSnapshotGitHubReaderFunction = (
    input: MaintenanceSnapshotGitHubReaderInput,
) => Promise<MaintainableSnapshot>;

export type MaintenanceGitHubSnapshotReader = MaintenanceSnapshotGitHubReader;
export type MaintenanceGitHubReaderService = MaintenanceSnapshotGitHubReader;

export type MaintenanceSnapshotCaptureMetadata = {
    readonly schemaVersion: number;
    readonly capturedAt: string;
    readonly runId: string | null;
    readonly repository: string;
    readonly branch: string;
    readonly selection: MaintainSelectionInput;
    readonly budgets: MaintenanceSnapshotBudgets;
    readonly sources: {
        readonly github: "complete";
        readonly grounding: GroundingReadOutcome["status"];
        readonly guidance: "available" | "unavailable";
    };
    readonly counts: {
        readonly labelCount: number;
        readonly openIssueSummaryCount: number;
        readonly selectedIssueCount: number;
        readonly fetchedCommentCount: number;
        readonly issueSkipCount: number;
        readonly guidanceFileCount: number;
        readonly guidanceByteCount: number;
    };
};

export const MAINTENANCE_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAINTENANCE_SNAPSHOT_VERSION = MAINTENANCE_SNAPSHOT_SCHEMA_VERSION;

export type MaintenanceSnapshot = MaintainableSnapshot & {
    readonly schemaVersion: number;
    readonly fingerprint: string;
    readonly capturedAt: string;
    readonly runId: string | null;
    readonly metadata: MaintenanceSnapshotCaptureMetadata;
    /** Alias kept for callers that name the capture record directly. */
    readonly capture: MaintenanceSnapshotCaptureMetadata;
    readonly grounding: RepositoryGrounding | undefined;
    readonly groundingOutcome: GroundingReadOutcome;
    readonly groundingSkip: GroundingSkip | undefined;
    readonly groundingStatus: GroundingReadOutcome["status"];
    readonly guidance: GuidanceBundle | undefined;
};

export type MaintainableMaintenanceSnapshot = MaintenanceSnapshot;
export type ImmutableMaintenanceSnapshot = MaintenanceSnapshot;

export type MaintenanceSnapshotServiceDependencies = {
    readonly githubClient?: Pick<GitHubClientService, "initialize">;
    readonly githubReader?:
        | MaintenanceSnapshotGitHubReader
        | MaintenanceSnapshotGitHubReaderFunction;
    readonly groundingReader?: GroundingReaderService;
    readonly clock?: () => string;
};

export type MaintenanceSnapshotService = {
    readonly capture: (
        input: MaintenanceSnapshotRequest,
    ) => Promise<MaintenanceSnapshot>;
    readonly read: (
        input: MaintenanceSnapshotRequest,
    ) => Promise<MaintenanceSnapshot>;
};

const liveGithubReader: MaintenanceSnapshotGitHubReader = {
    read: (input) =>
        loadMaintainabilitySnapshot(
            input.client,
            input.repository,
            input.selection,
            input.signal,
            input.detailOptions,
        ),
};

const invokeGithubReader = (
    reader:
        | MaintenanceSnapshotGitHubReader
        | MaintenanceSnapshotGitHubReaderFunction,
    input: MaintenanceSnapshotGitHubReaderInput,
): Promise<MaintainableSnapshot> =>
    typeof reader === "function" ? reader(input) : reader.read(input);

const cloneRepository = (
    value: MaintainableSnapshot["repository"],
): MaintainableSnapshot["repository"] => {
    const source = (value ?? {}) as RecordLike;
    return Object.freeze({
        fullName: text(source.fullName ?? source.full_name),
        defaultBranch: text(source.defaultBranch ?? source.default_branch),
        htmlUrl: text(source.htmlUrl ?? source.html_url),
        rawDefaultBranch: cloneDeepFrozen(
            source.rawDefaultBranch !== undefined
                ? source.rawDefaultBranch
                : source.default_branch,
        ),
        raw: frozenRecord(source.raw),
    });
};

const cloneLabels = (value: unknown): ReadonlyArray<MaintainableLabel> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const labels = value.map((entry) => normalizeMaintainableLabel(entry));
    labels.sort(
        (left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.description ?? "", right.description ?? "") ||
            compareText(left.color ?? "", right.color ?? ""),
    );
    return Object.freeze(labels);
};

const cloneActor = (value: unknown): MaintainableActor | null =>
    normalizeMaintainableActor(value);

const cloneAssignees = (value: unknown): ReadonlyArray<MaintainableActor> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const assignees = value
        .map((entry) => cloneActor(entry))
        .filter((entry): entry is MaintainableActor => entry !== null);
    assignees.sort(compareCanonical);
    return Object.freeze(assignees);
};

const cloneSummary = (value: unknown): MaintainableIssueSummary => {
    const source = isRecord(value) ? value : {};
    const state = normalizeMaintainableIssueState(source.state);
    return Object.freeze({
        number: nonNegativeInteger(source.number),
        nodeId: text(source.nodeId ?? source.node_id),
        title: text(source.title),
        url: text(source.url ?? source.htmlUrl ?? source.html_url),
        htmlUrl: text(source.htmlUrl ?? source.html_url ?? source.url),
        labels: cloneLabels(source.labels),
        author: cloneActor(source.author ?? source.user ?? null),
        createdAt: text(source.createdAt ?? source.created_at),
        updatedAt: text(source.updatedAt ?? source.updated_at),
        commentCount: nonNegativeInteger(
            source.commentCount ?? source.comments,
        ),
        state,
        isOpen: state === "open",
        raw: frozenRecord(source.raw ?? source),
    });
};

const cloneAvailability = (value: unknown): MaintainableAvailability => {
    return normalizeMaintainableAvailability(value);
};

const cloneIssue = (
    value: unknown,
    threadOverride?: unknown,
): MaintainableIssue => {
    const source = isRecord(value) ? value : {};
    const selectedThread =
        threadOverride ??
        source.selectedThread ??
        source.thread ??
        source.commentThread;
    return createMaintainableIssue({
        ...source,
        labels: cloneLabels(source.labels),
        assignees: cloneAssignees(source.assignees),
        selectedThread:
            isRecord(selectedThread) || Array.isArray(selectedThread)
                ? selectedThread
                : {},
        availability: cloneAvailability(source.availability),
        ...(source.skip === undefined
            ? {}
            : { skip: normalizeMaintainableSkip(source.skip) }),
    });
};

const cloneProjection = (
    thread: MaintainableSelectedThread,
    budgets: MaintenanceSnapshotBudgets,
): ThreadPromptProjectionResult =>
    projectThreadPrompt({
        thread,
        commentPromptLimit: budgets.commentPromptLimit,
        threadPromptLimit: budgets.threadPromptLimit,
        aggregatePromptLimit: budgets.aggregatePromptLimit,
    });

const detailFor = (
    value: unknown,
    budgets: MaintenanceSnapshotBudgets,
): MaintainableSnapshot["selectedDetails"][number] => {
    const source = isRecord(value) ? value : {};
    const sourceIssue = isRecord(source.issue) ? source.issue : source;
    const sourceThread =
        source.thread ??
        source.selectedThread ??
        source.commentThread ??
        sourceIssue.selectedThread ??
        sourceIssue.thread ??
        sourceIssue.commentThread;
    const issue = cloneIssue(sourceIssue, sourceThread);
    const thread = issue.selectedThread;
    return Object.freeze({
        issue,
        thread,
        threadProjection: cloneProjection(thread, budgets),
    });
};

const selectedNumberFor = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;

const uniqueSelectedNumbers = (value: unknown): ReadonlyArray<number> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const numbers: number[] = [];
    const seen = new Set<number>();
    for (const entry of value) {
        const number = selectedNumberFor(entry);
        if (number === undefined || seen.has(number)) continue;
        seen.add(number);
        numbers.push(number);
    }
    return Object.freeze(numbers);
};

const missingDetail = (
    issueNumber: number,
    budgets: MaintenanceSnapshotBudgets,
): MaintainSnapshotDetail => {
    const skip = createMaintainableSkip({
        reason: "unavailable",
        detail: "selected issue detail was not returned by the GitHub reader",
        issueNumber,
    });
    if (skip === undefined) throw new Error("Could not create a detail skip.");
    const issue = cloneIssue({ number: issueNumber, skip });
    const thread = issue.selectedThread;
    return Object.freeze({
        issue,
        thread,
        threadProjection: cloneProjection(thread, budgets),
    });
};

type MaintainSnapshotDetail = MaintainableSnapshot["selectedDetails"][number];

const skipKey = (skip: MaintainableSkip): string =>
    canonicalMaintenanceJson({
        reason: skip.reason,
        detail: skip.detail,
        issueNumber: skip.issueNumber,
    });

const detailMapFor = (
    source: RecordLike,
    budgets: MaintenanceSnapshotBudgets,
): Map<number, MaintainSnapshotDetail> => {
    const detailByNumber = new Map<number, MaintainSnapshotDetail>();
    const add = (detail: unknown): void => {
        const normalized = detailFor(detail, budgets);
        if (!detailByNumber.has(normalized.issue.number)) {
            detailByNumber.set(normalized.issue.number, normalized);
        }
    };
    if (Array.isArray(source.selectedDetails)) {
        for (const detail of source.selectedDetails) add(detail);
    }
    if (Array.isArray(source.selectedIssues)) {
        for (const issue of source.selectedIssues) {
            const normalizedIssue = cloneIssue(issue);
            if (detailByNumber.has(normalizedIssue.number)) continue;
            const thread = normalizedIssue.selectedThread;
            detailByNumber.set(
                normalizedIssue.number,
                Object.freeze({
                    issue: normalizedIssue,
                    thread,
                    threadProjection: cloneProjection(thread, budgets),
                }),
            );
        }
    }
    return detailByNumber;
};

const detailsForNumbers = (
    numbers: ReadonlyArray<number>,
    detailByNumber: Map<number, MaintainSnapshotDetail>,
    budgets: MaintenanceSnapshotBudgets,
): ReadonlyArray<MaintainSnapshotDetail> =>
    Object.freeze(
        numbers.map(
            (number) =>
                detailByNumber.get(number) ?? missingDetail(number, budgets),
        ),
    );

const summariesFor = (
    source: RecordLike,
): ReadonlyArray<MaintainableIssueSummary> => {
    const summaryByNumber = new Map<number, MaintainableIssueSummary>();
    if (!Array.isArray(source.openIssueSummaries)) {
        return Object.freeze([]);
    }
    for (const summary of source.openIssueSummaries) {
        const normalized = cloneSummary(summary);
        const existing = summaryByNumber.get(normalized.number);
        if (
            existing === undefined ||
            compareCanonical(normalized, existing) < 0
        ) {
            summaryByNumber.set(normalized.number, normalized);
        }
    }
    return Object.freeze(
        [...summaryByNumber.values()].sort(
            (left, right) => left.number - right.number,
        ),
    );
};

const skipsFor = (
    source: RecordLike,
    issues: ReadonlyArray<MaintainableIssue>,
): ReadonlyArray<MaintainableSkip> => {
    const skipByKey = new Map<string, MaintainableSkip>();
    const add = (value: unknown): void => {
        const skip = normalizeMaintainableSkip(value);
        if (skip === undefined) return;
        const key = skipKey(skip);
        if (!skipByKey.has(key)) skipByKey.set(key, skip);
    };
    if (Array.isArray(source.skips)) {
        for (const skip of source.skips) add(skip);
    }
    for (const issue of issues) add(issue.skip);
    return Object.freeze([...skipByKey.values()].sort(compareCanonical));
};

const cloneGithubSnapshot = (
    value: MaintainableSnapshot,
    budgets: MaintenanceSnapshotBudgets,
): {
    readonly repository: MaintainableSnapshot["repository"];
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly openIssueSummaries: ReadonlyArray<MaintainableIssueSummary>;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly selectedDetails: ReadonlyArray<MaintainSnapshotDetail>;
    readonly selectedIssues: ReadonlyArray<MaintainableIssue>;
    readonly skips: ReadonlyArray<MaintainableSkip>;
} => {
    const source = (value ?? {}) as unknown as RecordLike;
    const selectedIssueNumbers = uniqueSelectedNumbers(
        source.selectedIssueNumbers,
    );
    const detailByNumber = detailMapFor(source, budgets);
    const details = detailsForNumbers(
        selectedIssueNumbers,
        detailByNumber,
        budgets,
    );
    const issues = Object.freeze(details.map((detail) => detail.issue));

    return {
        repository: cloneRepository(value.repository),
        labels: cloneLabels(source.labels),
        openIssueSummaries: summariesFor(source),
        selectedIssueNumbers,
        selectedDetails: details,
        selectedIssues: issues,
        skips: skipsFor(source, issues),
    };
};

const cloneGuidanceFile = (
    value: unknown,
    limits: MaintenanceSnapshotBudgets,
): GuidanceFile => {
    const source = isRecord(value) ? value : {};
    const state =
        source.state === "available" ||
        source.state === "absent" ||
        source.state === "omitted" ||
        source.state === "unavailable"
            ? source.state
            : "unavailable";
    const content = state === "available" ? text(source.content) : "";
    const byteLength = nonNegativeInteger(source.byteLength);
    const originalByteLength =
        source.originalByteLength === null ||
        source.originalByteLength === undefined
            ? null
            : nonNegativeInteger(source.originalByteLength);
    return Object.freeze({
        path: text(source.path),
        state,
        content,
        byteLength,
        truncated: source.truncated === true,
        omitted: source.omitted === true,
        marker: nullableText(source.marker),
        detail: nullableText(source.detail),
        originalByteLength,
        limit: limits.guidancePerFileByteLimit,
    });
};

const cloneGuidance = (
    value: GuidanceBundle,
    limits: MaintenanceSnapshotBudgets,
): GuidanceBundle => {
    const source = (value ?? {}) as unknown as RecordLike;
    const files = Array.isArray(source.files)
        ? source.files.map((file) => cloneGuidanceFile(file, limits))
        : [];
    files.sort(
        (left, right) =>
            compareText(left.path, right.path) || compareCanonical(left, right),
    );
    const frozenFiles = Object.freeze(files);
    return Object.freeze({
        files: frozenFiles,
        totalByteLength: frozenFiles.reduce(
            (total, file) => total + file.byteLength,
            0,
        ),
        truncated: frozenFiles.some((file) => file.truncated),
        omitted: frozenFiles.some((file) => file.omitted),
        perFileByteLimit: limits.guidancePerFileByteLimit,
        aggregateByteLimit: limits.guidanceAggregateByteLimit,
    });
};

const cloneGroundingOutcome = (
    value: GroundingReadOutcome,
    limits: MaintenanceSnapshotBudgets,
): GroundingReadOutcome => {
    const source = (value ?? {}) as unknown as RecordLike;
    if (source.status === "grounded" && isRecord(source.grounding)) {
        const grounding: RepositoryGrounding = Object.freeze({
            branch: text(source.grounding.branch),
            head: text(source.grounding.head),
            clean: true,
            readOnly: true,
        });
        const guidance = cloneGuidance(
            source.guidance as GuidanceBundle,
            limits,
        );
        return Object.freeze({ status: "grounded", grounding, guidance });
    }
    const sourceSkip = isRecord(source.skip) ? source.skip : {};
    const skip: GroundingSkip = Object.freeze({
        reason: normalizeGroundingSkipReason(sourceSkip.reason),
        detail: text(sourceSkip.detail) || "grounding was skipped",
    });
    return Object.freeze({ status: "skipped", skip });
};

const actorFingerprint = (actor: MaintainableActor | null): unknown =>
    actor === null
        ? null
        : {
              login: actor.login,
              type: actor.type,
              nodeId: actor.nodeId,
          };

const labelFingerprint = (label: MaintainableLabel): RecordLike => ({
    name: label.name,
    description: label.description,
    color: label.color,
});

const availabilityFingerprint = (
    availability: MaintainableAvailability,
): RecordLike => ({
    kind: availability.kind,
    reason: availability.reason,
    detail: availability.detail,
});

const skipFingerprint = (skip: MaintainableSkip | undefined): unknown =>
    skip === undefined
        ? null
        : {
              reason: skip.reason,
              detail: skip.detail,
              issueNumber: skip.issueNumber,
          };

const commentFingerprint = (comment: MaintainableComment): RecordLike => ({
    id: comment.id,
    databaseId: comment.databaseId,
    nodeId: comment.nodeId,
    url: comment.url,
    htmlUrl: comment.htmlUrl,
    author: actorFingerprint(comment.author),
    authorAssociation: comment.authorAssociation,
    body: bodyFingerprint(comment.body),
    content: bodyFingerprint(comment.content),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    isRalphieManaged: comment.isRalphieManaged,
    marker: markerValue(comment.marker),
});

const threadFingerprint = (thread: MaintainableSelectedThread): RecordLike => ({
    comments: thread.comments.map(commentFingerprint),
    fetchedCount: thread.fetchedCount,
    totalCount: thread.totalCount,
    complete: thread.complete,
    availability: availabilityFingerprint(thread.availability),
});

const projectionFingerprint = (
    projection: ThreadPromptProjectionResult,
): RecordLike => ({
    fetchedThread: threadFingerprint(projection.fetchedThread),
    comments: projection.comments.map((comment) => ({
        id: comment.id,
        state: comment.state,
        limit: comment.limit,
        contentDigest: digestText(comment.content),
        marker: comment.marker,
        originalLength: comment.originalLength,
        retainedLength: comment.retainedLength,
        omittedLength: comment.omittedLength,
        truncatedLength: comment.truncatedLength,
    })),
    thread: {
        limit: projection.thread.limit,
        textDigest: digestText(projection.thread.text),
        marker: projection.thread.marker,
        originalCount: projection.thread.originalCount,
        includedCount: projection.thread.includedCount,
        omittedCount: projection.thread.omittedCount,
        originalLength: projection.thread.originalLength,
        retainedLength: projection.thread.retainedLength,
        omittedLength: projection.thread.omittedLength,
        truncatedLength: projection.thread.truncatedLength,
        omittedIds: [...projection.thread.omittedIds],
    },
    aggregate: {
        limit: projection.aggregate.limit,
        textDigest: digestText(projection.aggregate.text),
        marker: projection.aggregate.marker,
        truncated: projection.aggregate.truncated,
        omitted: projection.aggregate.omitted,
        originalLength: projection.aggregate.originalLength,
        retainedLength: projection.aggregate.retainedLength,
        omittedLength: projection.aggregate.omittedLength,
        truncatedLength: projection.aggregate.truncatedLength,
        originalCount: projection.aggregate.originalCount,
        retainedCount: projection.aggregate.retainedCount,
        truncatedCount: projection.aggregate.truncatedCount,
        omittedCount: projection.aggregate.omittedCount,
        emptyCount: projection.aggregate.emptyCount,
        unavailableCount: projection.aggregate.unavailableCount,
    },
    commentLimit: projection.commentLimit,
    threadLimit: projection.threadLimit,
    aggregateLimit: projection.aggregateLimit,
});

const issueFingerprint = (issue: MaintainableIssue): RecordLike => ({
    number: issue.number,
    nodeId: issue.nodeId,
    title: issue.title,
    body: bodyFingerprint(issue.body),
    url: issue.url,
    htmlUrl: issue.htmlUrl,
    state: issue.state,
    isOpen: issue.isOpen,
    open: issue.open,
    author: actorFingerprint(issue.author),
    authorAssociation: issue.authorAssociation,
    labels: issue.labels.map(labelFingerprint),
    assignees: issue.assignees.map(actorFingerprint),
    milestone: markerValue(issue.milestone),
    locked: issue.locked,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    selectedThread: threadFingerprint(issue.selectedThread),
    marker: markerValue(issue.marker),
    isRalphieManaged: issue.isRalphieManaged,
    availability: availabilityFingerprint(issue.availability),
    skip: skipFingerprint(issue.skip),
});

const summaryFingerprint = (summary: MaintainableIssueSummary): RecordLike => ({
    number: summary.number,
    nodeId: summary.nodeId,
    title: summary.title,
    url: summary.url,
    htmlUrl: summary.htmlUrl,
    labels: summary.labels.map(labelFingerprint),
    author: actorFingerprint(summary.author),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    commentCount: summary.commentCount,
    state: summary.state,
    isOpen: summary.isOpen,
});

const guidanceFingerprint = (guidance: GuidanceBundle | undefined): unknown =>
    guidance === undefined
        ? null
        : {
              files: guidance.files.map((file) => ({
                  path: file.path,
                  state: file.state,
                  contentDigest: digestText(file.content),
                  byteLength: file.byteLength,
                  truncated: file.truncated,
                  omitted: file.omitted,
                  marker: file.marker,
                  detail: file.detail,
                  originalByteLength: file.originalByteLength,
                  limit: file.limit,
              })),
              totalByteLength: guidance.totalByteLength,
              truncated: guidance.truncated,
              omitted: guidance.omitted,
              perFileByteLimit: guidance.perFileByteLimit,
              aggregateByteLimit: guidance.aggregateByteLimit,
          };

const groundingFingerprint = (outcome: GroundingReadOutcome): RecordLike =>
    outcome.status === "grounded"
        ? {
              status: outcome.status,
              grounding: {
                  branch: outcome.grounding.branch,
                  head: outcome.grounding.head,
                  clean: outcome.grounding.clean,
                  readOnly: outcome.grounding.readOnly,
              },
          }
        : {
              status: outcome.status,
              skip: {
                  reason: outcome.skip.reason,
                  detail: outcome.skip.detail,
              },
          };

const fingerprintPayload = (
    snapshot: Omit<MaintenanceSnapshot, "fingerprint" | "metadata" | "capture">,
): RecordLike => ({
    schemaVersion: snapshot.schemaVersion,
    repository: {
        fullName: snapshot.repository.fullName,
        defaultBranch: snapshot.repository.defaultBranch,
        htmlUrl: snapshot.repository.htmlUrl,
        rawDefaultBranch: snapshot.repository.rawDefaultBranch,
    },
    labels: [...snapshot.labels].map(labelFingerprint).sort(compareCanonical),
    openIssueSummaries: [...snapshot.openIssueSummaries]
        .map(summaryFingerprint)
        .sort(compareCanonical),
    selectedIssueNumbers: [...snapshot.selectedIssueNumbers],
    selectedIssues: [...snapshot.selectedIssues]
        .map(issueFingerprint)
        .sort(compareCanonical),
    selectedDetails: [...snapshot.selectedDetails]
        .map((detail) => ({
            issueNumber: detail.issue.number,
            thread: threadFingerprint(detail.thread),
            projection: projectionFingerprint(detail.threadProjection),
        }))
        .sort(compareCanonical),
    skips: [...snapshot.skips]
        .map((skip) => skipFingerprint(skip))
        .sort(compareCanonical),
    selection: snapshot.selection,
    grounding: groundingFingerprint(snapshot.groundingOutcome),
    guidance: guidanceFingerprint(snapshot.guidance),
});

export const maintenanceSnapshotFingerprint = (
    snapshot: Omit<MaintenanceSnapshot, "fingerprint" | "metadata" | "capture">,
): string => digestText(canonicalMaintenanceJson(fingerprintPayload(snapshot)));

export const fingerprintMaintenanceSnapshot = maintenanceSnapshotFingerprint;
export const computeMaintenanceSnapshotFingerprint =
    maintenanceSnapshotFingerprint;

const assembleSnapshot = (
    github: MaintainableSnapshot,
    groundingOutcome: GroundingReadOutcome,
    request: MaintenanceSnapshotRequest,
    selection: MaintainSelectionInput,
    budgets: MaintenanceSnapshotBudgets,
    clock: () => string,
): MaintenanceSnapshot => {
    const normalizedGithub = cloneGithubSnapshot(github, budgets);
    const normalizedGrounding = cloneGroundingOutcome(
        groundingOutcome,
        budgets,
    );
    const grounding =
        normalizedGrounding.status === "grounded"
            ? normalizedGrounding.grounding
            : undefined;
    const groundingSkip =
        normalizedGrounding.status === "skipped"
            ? normalizedGrounding.skip
            : undefined;
    const guidance =
        normalizedGrounding.status === "grounded"
            ? normalizedGrounding.guidance
            : undefined;
    const capturedAt = request.capturedAt ?? clock();
    const runId = request.runId ?? null;
    const counts = Object.freeze({
        labelCount: normalizedGithub.labels.length,
        openIssueSummaryCount: normalizedGithub.openIssueSummaries.length,
        selectedIssueCount: normalizedGithub.selectedIssues.length,
        fetchedCommentCount: normalizedGithub.selectedDetails.reduce(
            (total, detail) => total + detail.thread.fetchedCount,
            0,
        ),
        issueSkipCount: normalizedGithub.skips.length,
        guidanceFileCount: guidance?.files.length ?? 0,
        guidanceByteCount: guidance?.totalByteLength ?? 0,
    });
    const metadata: MaintenanceSnapshotCaptureMetadata = Object.freeze({
        schemaVersion: MAINTENANCE_SNAPSHOT_SCHEMA_VERSION,
        capturedAt,
        runId,
        repository: request.repository,
        branch: request.branch,
        selection,
        budgets,
        sources: Object.freeze({
            github: "complete",
            grounding: normalizedGrounding.status,
            guidance:
                guidance === undefined
                    ? ("unavailable" as const)
                    : ("available" as const),
        }),
        counts,
    });
    const base = {
        ...normalizedGithub,
        schemaVersion: MAINTENANCE_SNAPSHOT_SCHEMA_VERSION,
        capturedAt,
        runId,
        metadata,
        capture: metadata,
        grounding,
        groundingOutcome: normalizedGrounding,
        groundingSkip,
        groundingStatus: normalizedGrounding.status,
        guidance,
    } as Omit<MaintenanceSnapshot, "fingerprint">;
    const fingerprint = maintenanceSnapshotFingerprint(base);
    return Object.freeze({ ...base, fingerprint });
};

const validateRequest = (request: MaintenanceSnapshotRequest): void => {
    if (request.repository.trim().length === 0) {
        throw new RangeError("Maintenance snapshot repository is required.");
    }
    if (request.repositoryPath.trim().length === 0) {
        throw new RangeError(
            "Maintenance snapshot repositoryPath is required.",
        );
    }
    if (request.branch.trim().length === 0) {
        throw new RangeError("Maintenance snapshot branch is required.");
    }
};

/** Create the read-only maintenance snapshot assembler. */
export const makeMaintenanceSnapshotService = (
    dependencies: MaintenanceSnapshotServiceDependencies = {},
): MaintenanceSnapshotService => {
    const githubReader = dependencies.githubReader ?? liveGithubReader;
    const groundingReader =
        dependencies.groundingReader ?? MaintainIssuesGroundingReaderLive;
    const clock = dependencies.clock ?? (() => new Date().toISOString());

    const capture = async (
        request: MaintenanceSnapshotRequest,
    ): Promise<MaintenanceSnapshot> => {
        validateRequest(request);
        const selection = normalizeSelection(request.selection);
        const budgets = normalizeBudgets(request);
        throwIfAborted(request.signal);
        const client =
            request.client ??
            (dependencies.githubClient === undefined
                ? undefined
                : await dependencies.githubClient.initialize());
        if (client === undefined) {
            throw new RalphieError({
                message:
                    "Maintenance snapshot capture requires a GitHub client or a GitHub client service dependency.",
            });
        }
        throwIfAborted(request.signal);
        const github = await invokeGithubReader(githubReader, {
            client,
            repository: request.repository,
            selection,
            signal: request.signal,
            detailOptions: {
                commentPromptLimit: budgets.commentPromptLimit,
                threadPromptLimit: budgets.threadPromptLimit,
                aggregatePromptLimit: budgets.aggregatePromptLimit,
            },
        });
        throwIfAborted(request.signal);
        const grounding = await groundingReader.read(
            {
                repositoryPath: request.repositoryPath,
                branch: request.branch,
                signal: request.signal,
            },
            {
                perFileByteLimit: budgets.guidancePerFileByteLimit,
                aggregateByteLimit: budgets.guidanceAggregateByteLimit,
            },
        );
        throwIfAborted(request.signal);
        return assembleSnapshot(
            github,
            grounding,
            request,
            selection,
            budgets,
            clock,
        );
    };

    return Object.freeze({ capture, read: capture });
};

export const makeMaintainIssuesSnapshotService = makeMaintenanceSnapshotService;
export const makeMaintainabilitySnapshotService =
    makeMaintenanceSnapshotService;
export const MaintenanceSnapshotLive = makeMaintenanceSnapshotService();
export const MaintainIssuesSnapshotLive = MaintenanceSnapshotLive;