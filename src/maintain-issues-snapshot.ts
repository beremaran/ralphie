/**
 * Maintenance-only immutable read-model value types.
 *
 * This module is a pure value boundary: it declares readonly snapshot shapes
 * for maintenance planning and centralizes exact recognition of the managed
 * markers used by this contract. It performs no network or filesystem reads
 * and no mutations. All nested arrays and records are readonly and are
 * deep-copied at the boundary so callers can neither mutate a snapshot nor
 * retain a mutable source object through it. Future or unknown enum and actor
 * values are represented explicitly instead of throwing.
 */

export type MaintainableUnknownValue = {
    readonly kind: "unknown";
    readonly value: string;
};

export type UnknownValue = MaintainableUnknownValue;
export type MaintainableUnknown = MaintainableUnknownValue;
export type UnknownEnumValue = MaintainableUnknownValue;
export type SafeUnknownValue = MaintainableUnknownValue;

export const isMaintainableUnknownValue = (
    value: unknown,
): value is MaintainableUnknownValue =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly kind?: unknown }).kind === "unknown" &&
    typeof (value as { readonly value?: unknown }).value === "string";

export const isUnknownValue = isMaintainableUnknownValue;
export const isUnknownEnumValue = isMaintainableUnknownValue;

export const createUnknownValue = (
    value: unknown,
): MaintainableUnknownValue => {
    if (isMaintainableUnknownValue(value)) {
        return Object.freeze({ kind: "unknown", value: value.value });
    }
    if (typeof value === "string") {
        return Object.freeze({ kind: "unknown", value });
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return Object.freeze({ kind: "unknown", value: String(value) });
    }
    if (value === null || value === undefined) {
        return Object.freeze({ kind: "unknown", value: "missing" });
    }
    try {
        return Object.freeze({ kind: "unknown", value: String(value) });
    } catch {
        return Object.freeze({ kind: "unknown", value: "unknown" });
    }
};

export const unknownValue = createUnknownValue;
export const asUnknownValue = createUnknownValue;
export const toUnknownValue = createUnknownValue;

export type MaintainableIssueState =
    | "open"
    | "closed"
    | MaintainableUnknownValue;
export type IssueState = MaintainableIssueState;
export type MaintainableState = MaintainableIssueState;

const KNOWN_ISSUE_STATES: ReadonlyArray<string> = ["open", "closed"];

export const normalizeMaintainableIssueState = (
    value: unknown,
): MaintainableIssueState => {
    if (value === "open" || value === "closed") return value;
    if (isMaintainableUnknownValue(value)) return createUnknownValue(value);
    if (typeof value === "string") return createUnknownValue(value);
    if (value === null || value === undefined) {
        return createUnknownValue(value);
    }
    return createUnknownValue(String(value));
};

export const normalizeIssueState = normalizeMaintainableIssueState;
export const normalizeState = normalizeMaintainableIssueState;

export const isMaintainableIssueOpen = (
    state: MaintainableIssueState,
): boolean => state === "open";

export const isIssueOpen = isMaintainableIssueOpen;

export type MaintainableMilestoneState =
    | "open"
    | "closed"
    | MaintainableUnknownValue;
export type MilestoneState = MaintainableMilestoneState;

export const normalizeMaintainableMilestoneState = (
    value: unknown,
): MaintainableMilestoneState => {
    if (value === "open" || value === "closed") return value;
    if (isMaintainableUnknownValue(value)) return createUnknownValue(value);
    if (typeof value === "string") return createUnknownValue(value);
    if (value === null || value === undefined) {
        return createUnknownValue(value);
    }
    return createUnknownValue(String(value));
};

export const normalizeMilestoneState = normalizeMaintainableMilestoneState;

export type MaintainableActorType =
    | "User"
    | "Bot"
    | "Organization"
    | "Mannequin"
    | MaintainableUnknownValue;
export type ActorType = MaintainableActorType;
export type MaintainableActorKind = MaintainableActorType;

const KNOWN_ACTOR_TYPES: ReadonlyArray<string> = [
    "User",
    "Bot",
    "Organization",
    "Mannequin",
];

export const normalizeMaintainableActorType = (
    value: unknown,
): MaintainableActorType => {
    if (
        value === "User" ||
        value === "Bot" ||
        value === "Organization" ||
        value === "Mannequin"
    ) {
        return value;
    }
    if (isMaintainableUnknownValue(value)) return createUnknownValue(value);
    if (typeof value === "string") return createUnknownValue(value);
    if (value === null || value === undefined) {
        return createUnknownValue(value);
    }
    return createUnknownValue(String(value));
};

export const normalizeActorType = normalizeMaintainableActorType;
export const normalizeActorKind = normalizeMaintainableActorType;

export type MaintainableActor = {
    readonly login: string;
    readonly type: MaintainableActorType;
    readonly nodeId: string | null;
};

export type IssueActor = MaintainableActor;
export type MaintainableAssigneeActor = MaintainableActor;
export type AssigneeActor = MaintainableActor;
export type Actor = MaintainableActor;

export type MaintainableActorInput = {
    readonly login?: unknown;
    readonly type?: unknown;
    readonly nodeId?: unknown;
    readonly node_id?: unknown;
};

const textOrNull = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    return value;
};

const textOrEmpty = (value: unknown): string =>
    typeof value === "string" ? value : "";

const timestampOrEmpty = (value: unknown): string =>
    typeof value === "string" ? value : "";

const actorFromString = (value: string): MaintainableActor | null => {
    const login = value.trim();
    if (login.length === 0) return null;
    return Object.freeze({
        login,
        type: createUnknownValue("missing") as MaintainableActorType,
        nodeId: null,
    });
};

const actorFromNonRecord = (value: unknown): MaintainableActor =>
    Object.freeze({
        login: "unknown",
        type: createUnknownValue(String(value)) as MaintainableActorType,
        nodeId: null,
    });

const actorFromRecord = (
    record: Record<string, unknown>,
): MaintainableActor => {
    const rawLogin = record.login ?? record.name ?? record.username;
    if (typeof rawLogin !== "string" || rawLogin.trim().length === 0) {
        // Preserve explicitly unknown actor shapes instead of throwing.
        const fallback = record.type ?? record.kind ?? "unknown";
        return Object.freeze({
            login: "unknown",
            type: normalizeMaintainableActorType(fallback),
            nodeId: textOrNull(record.nodeId ?? record.node_id),
        });
    }
    return Object.freeze({
        login: rawLogin.trim(),
        type: normalizeMaintainableActorType(
            record.type ?? record.kind ?? record.actorType,
        ),
        nodeId: textOrNull(record.nodeId ?? record.node_id),
    });
};

export const normalizeMaintainableActor = (
    value: unknown,
): MaintainableActor | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return actorFromString(value);
    if (typeof value !== "object" || Array.isArray(value)) {
        return actorFromNonRecord(value);
    }
    return actorFromRecord(value as Record<string, unknown>);
};

export const normalizeActor = normalizeMaintainableActor;
export const createMaintainableActor = normalizeMaintainableActor;
export const toMaintainableActor = normalizeMaintainableActor;

export type MaintainableAuthorAssociation =
    | "COLLABORATOR"
    | "CONTRIBUTOR"
    | "FIRST_TIMER"
    | "FIRST_TIME_CONTRIBUTOR"
    | "MANNEQUIN"
    | "MEMBER"
    | "NONE"
    | "OWNER"
    | MaintainableUnknownValue;

export type AuthorAssociation = MaintainableAuthorAssociation;
export type IssueAuthorAssociation = MaintainableAuthorAssociation;

const KNOWN_AUTHOR_ASSOCIATIONS: ReadonlyArray<string> = [
    "COLLABORATOR",
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "MANNEQUIN",
    "MEMBER",
    "NONE",
    "OWNER",
];

export const normalizeMaintainableAuthorAssociation = (
    value: unknown,
): MaintainableAuthorAssociation => {
    if (
        typeof value === "string" &&
        (KNOWN_AUTHOR_ASSOCIATIONS as ReadonlyArray<string>).includes(value)
    ) {
        return value as MaintainableAuthorAssociation;
    }
    if (isMaintainableUnknownValue(value)) return createUnknownValue(value);
    if (typeof value === "string") return createUnknownValue(value);
    if (value === null || value === undefined) {
        return createUnknownValue(value);
    }
    return createUnknownValue(String(value));
};

export const normalizeAuthorAssociation =
    normalizeMaintainableAuthorAssociation;
export const normalizeIssueAuthorAssociation =
    normalizeMaintainableAuthorAssociation;

export type MaintainableLabel = {
    readonly name: string;
    readonly description: string | null;
    readonly color: string | null;
};

export type IssueLabel = MaintainableLabel;
export type MaintenanceLabel = MaintainableLabel;
export type LabelMetadata = MaintainableLabel;

export type MaintainableLabelInput = {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly color?: unknown;
};

export const normalizeMaintainableLabel = (
    value: unknown,
): MaintainableLabel => {
    if (typeof value === "string") {
        return Object.freeze({
            name: value,
            description: null,
            color: null,
        });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Object.freeze({
            name: "unknown",
            description: null,
            color: null,
        });
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "unknown";
    return Object.freeze({
        name,
        description: textOrNull(record.description),
        color: textOrNull(record.color),
    });
};

export const normalizeLabel = normalizeMaintainableLabel;
export const createMaintainableLabel = normalizeMaintainableLabel;
export const toMaintainableLabel = normalizeMaintainableLabel;

export const maintainableLabelNames = (
    labels: ReadonlyArray<MaintainableLabel>,
): ReadonlyArray<string> => {
    const names = labels.map((label) => label.name);
    return Object.freeze([...names]);
};

export const labelNames = maintainableLabelNames;

export type MaintainableAssignee = MaintainableActor;
export type Assignee = MaintainableAssignee;
export type IssueAssignee = MaintainableAssignee;

export const normalizeMaintainableAssignee = (
    value: unknown,
): MaintainableAssignee | null => normalizeMaintainableActor(value);

export const normalizeAssignee = normalizeMaintainableAssignee;

export type MaintainableMilestone = {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly description: string | null;
    readonly state: MaintainableMilestoneState;
    readonly url: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly dueOn: string | null;
};

export type IssueMilestone = MaintainableMilestone;
export type MilestoneMetadata = MaintainableMilestone;

export type MaintainableMilestoneInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly node_id?: unknown;
    readonly title?: unknown;
    readonly description?: unknown;
    readonly state?: unknown;
    readonly url?: unknown;
    readonly html_url?: unknown;
    readonly htmlUrl?: unknown;
    readonly createdAt?: unknown;
    readonly created_at?: unknown;
    readonly updatedAt?: unknown;
    readonly updated_at?: unknown;
    readonly dueOn?: unknown;
    readonly due_on?: unknown;
};

const numberOrZero = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : 0;

export const normalizeMaintainableMilestone = (
    value: unknown,
): MaintainableMilestone | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const milestone: MaintainableMilestone = {
        number: numberOrZero(record.number),
        nodeId: textOrEmpty(record.nodeId ?? record.node_id),
        title: textOrEmpty(record.title),
        description: textOrNull(record.description),
        state: normalizeMaintainableMilestoneState(record.state),
        url: textOrEmpty(record.url ?? record.html_url ?? record.htmlUrl),
        createdAt: timestampOrEmpty(record.createdAt ?? record.created_at),
        updatedAt: timestampOrEmpty(record.updatedAt ?? record.updated_at),
        dueOn: textOrNull(record.dueOn ?? record.due_on),
    };
    return Object.freeze(milestone);
};

export const normalizeMilestone = normalizeMaintainableMilestone;
export const createMaintainableMilestone = normalizeMaintainableMilestone;
export const toMaintainableMilestone = normalizeMaintainableMilestone;

export type RalphieMarkerKind =
    | "decomposition"
    | "decomposition-original"
    | "needs-attention"
    | "pr-review"
    | "review-attempt"
    | "maintain";

export type MarkerKind = RalphieMarkerKind;
export type MaintainableMarkerKind = RalphieMarkerKind;
export type ManagedMarkerKind = RalphieMarkerKind;

export type RalphieMarker = {
    readonly kind: RalphieMarkerKind;
    readonly normalized: string;
    readonly rootIssueNumber?: number;
    readonly parentIssueNumber?: number;
    readonly key?: string;
    readonly depth?: number;
    readonly original?: number;
    readonly issue?: number;
    readonly pullRequest?: number;
    readonly head?: string;
    readonly attempt?: number;
};

export type MaintainableMarker = RalphieMarker;
export type ManagedMarker = RalphieMarker;
export type MarkerMetadata = RalphieMarker;
export type RalphieMarkerMetadata = RalphieMarker;
export type MaintainableMarkerMetadata = RalphieMarker;

export const RALPHIE_MAINTAIN_MARKER = "ralphie:maintain";
export const MAINTAIN_MARKER_PREFIX = RALPHIE_MAINTAIN_MARKER;
export const RALPHIE_MAINTENANCE_MARKER = "ralphie:maintain";
export const MAINTAIN_ISSUES_MARKER = RALPHIE_MAINTAIN_MARKER;
export const RALPHIE_DECOMPOSITION_MARKER = "ralphie:decomposition";
export const RALPHIE_NEEDS_ATTENTION_MARKER = "ralphie:needs-attention";
export const RALPHIE_PR_REVIEW_MARKER = "ralphie:pr-review";
export const RALPHIE_REVIEW_ATTEMPT_MARKER = "ralphie:review-attempt";

export const maintainMarker = (issueNumber: number): string =>
    `<!-- ${RALPHIE_MAINTAIN_MARKER} issue=${issueNumber} -->`;

export const ralphieMaintainMarker = maintainMarker;
export const createMaintainMarker = maintainMarker;
export const renderMaintainMarker = maintainMarker;

const DECOMPOSITION_PATTERN =
    /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/;
const DECOMPOSITION_ORIGINAL_PATTERN =
    /<!-- ralphie:decomposition original=(\d+) depth=(\d+) -->/;
const NEEDS_ATTENTION_PATTERN = /<!-- ralphie:needs-attention issue=(\d+) -->/;
const PR_REVIEW_PATTERN =
    /<!-- ralphie:pr-review pr=(\d+) head=([0-9a-f]{40}(?:[0-9a-f]{24})?) attempt=(\d+) -->/;
const REVIEW_ATTEMPT_PATTERN = /<!-- ralphie:review-attempt=(\d+) -->/;
const MAINTAIN_PATTERN = /<!-- ralphie:maintain issue=(\d+) -->/;

const safeInteger = (text: string): number | undefined => {
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseDecompositionMarker = (body: string): RalphieMarker | undefined => {
    const decomposition = DECOMPOSITION_PATTERN.exec(body);
    if (decomposition === null) return undefined;
    let key: string;
    try {
        const parsed: unknown = JSON.parse(decomposition[3] ?? "");
        if (typeof parsed !== "string" || parsed.length === 0) {
            return undefined;
        }
        key = parsed;
    } catch {
        return undefined;
    }
    const root = safeInteger(decomposition[1] ?? "");
    const parent = safeInteger(decomposition[2] ?? "");
    const depth = safeInteger(decomposition[4] ?? "");
    if (root === undefined || parent === undefined || depth === undefined) {
        return undefined;
    }
    return Object.freeze({
        kind: "decomposition",
        normalized: decomposition[0],
        rootIssueNumber: root,
        parentIssueNumber: parent,
        key,
        depth,
    });
};

const parseDecompositionOriginalMarker = (
    body: string,
): RalphieMarker | undefined => {
    const original = DECOMPOSITION_ORIGINAL_PATTERN.exec(body);
    if (original === null) return undefined;
    const originalNumber = safeInteger(original[1] ?? "");
    const depth = safeInteger(original[2] ?? "");
    if (originalNumber === undefined || depth === undefined) {
        return undefined;
    }
    return Object.freeze({
        kind: "decomposition-original",
        normalized: original[0],
        original: originalNumber,
        depth,
    });
};

const parseNeedsAttentionMarker = (body: string): RalphieMarker | undefined => {
    const needsAttention = NEEDS_ATTENTION_PATTERN.exec(body);
    if (needsAttention === null) return undefined;
    const issue = safeInteger(needsAttention[1] ?? "");
    if (issue === undefined) return undefined;
    return Object.freeze({
        kind: "needs-attention",
        normalized: needsAttention[0],
        issue,
    });
};

const parsePrReviewMarker = (body: string): RalphieMarker | undefined => {
    const prReview = PR_REVIEW_PATTERN.exec(body);
    if (prReview === null) return undefined;
    const pullRequest = safeInteger(prReview[1] ?? "");
    const attempt = safeInteger(prReview[3] ?? "");
    const head = prReview[2] ?? "";
    if (pullRequest === undefined || attempt === undefined) {
        return undefined;
    }
    return Object.freeze({
        kind: "pr-review",
        normalized: prReview[0],
        pullRequest,
        head,
        attempt,
    });
};

const parseReviewAttemptMarker = (body: string): RalphieMarker | undefined => {
    const reviewAttempt = REVIEW_ATTEMPT_PATTERN.exec(body);
    if (reviewAttempt === null) return undefined;
    const attempt = safeInteger(reviewAttempt[1] ?? "");
    if (attempt === undefined) return undefined;
    return Object.freeze({
        kind: "review-attempt",
        normalized: reviewAttempt[0],
        attempt,
    });
};

const parseMaintainMarkerValue = (body: string): RalphieMarker | undefined => {
    const maintain = MAINTAIN_PATTERN.exec(body);
    if (maintain === null) return undefined;
    const issue = safeInteger(maintain[1] ?? "");
    if (issue === undefined) return undefined;
    return Object.freeze({
        kind: "maintain",
        normalized: maintain[0],
        issue,
    });
};

const parseSingleMarker = (body: string): RalphieMarker | undefined =>
    parseDecompositionMarker(body) ??
    parseDecompositionOriginalMarker(body) ??
    parseNeedsAttentionMarker(body) ??
    parsePrReviewMarker(body) ??
    parseReviewAttemptMarker(body) ??
    parseMaintainMarkerValue(body);

export const parseRalphieMarker = (
    body: string | null | undefined,
): RalphieMarker | undefined => {
    if (typeof body !== "string" || body.length === 0) return undefined;
    return parseSingleMarker(body);
};

export const parseMaintainableMarker = parseRalphieMarker;
export const parseManagedMarker = parseRalphieMarker;
export const normalizeRalphieMarker = parseRalphieMarker;
export const normalizeMaintainableMarker = parseRalphieMarker;
export const normalizeManagedMarker = parseRalphieMarker;

const GLOBAL_MARKER_PATTERNS: ReadonlyArray<RegExp> = [
    /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/g,
    /<!-- ralphie:decomposition original=(\d+) depth=(\d+) -->/g,
    /<!-- ralphie:needs-attention issue=(\d+) -->/g,
    /<!-- ralphie:pr-review pr=(\d+) head=([0-9a-f]{40}(?:[0-9a-f]{24})?) attempt=(\d+) -->/g,
    /<!-- ralphie:review-attempt=(\d+) -->/g,
    /<!-- ralphie:maintain issue=(\d+) -->/g,
];

export const parseAllRalphieMarkers = (
    body: string | null | undefined,
): ReadonlyArray<RalphieMarker> => {
    if (typeof body !== "string" || body.length === 0) {
        return Object.freeze([]);
    }
    const markers: RalphieMarker[] = [];
    for (const pattern of GLOBAL_MARKER_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of body.matchAll(pattern)) {
            const marker = parseSingleMarker(match[0]);
            if (marker !== undefined) markers.push(marker);
        }
        pattern.lastIndex = 0;
    }
    return Object.freeze(markers);
};

export const parseAllMaintainableMarkers = parseAllRalphieMarkers;
export const parseAllManagedMarkers = parseAllRalphieMarkers;

export const isRalphieManaged = (body: string | null | undefined): boolean =>
    parseRalphieMarker(body) !== undefined;

export const isMaintainableManaged = isRalphieManaged;
export const isManagedMarker = isRalphieManaged;
export const isMaintainManaged = isRalphieManaged;

export type MaintainableAvailabilityKind =
    | "available"
    | "unavailable"
    | "partial";

export type AvailabilityKind = MaintainableAvailabilityKind;
export type IssueAvailabilityKind = MaintainableAvailabilityKind;

export type MaintainableSkipReason =
    | "transferred"
    | "deleted"
    | "inaccessible"
    | "null-author"
    | "locked"
    | "partial"
    | "unavailable"
    | MaintainableUnknownValue;

export type SkipReason = MaintainableSkipReason;
export type AvailabilityReason = MaintainableSkipReason;
export type IssueSkipReason = MaintainableSkipReason;

const KNOWN_SKIP_REASONS: ReadonlyArray<string> = [
    "transferred",
    "deleted",
    "inaccessible",
    "null-author",
    "locked",
    "partial",
    "unavailable",
];

export const normalizeMaintainableSkipReason = (
    value: unknown,
): MaintainableSkipReason => {
    if (
        typeof value === "string" &&
        (KNOWN_SKIP_REASONS as ReadonlyArray<string>).includes(value)
    ) {
        return value as MaintainableSkipReason;
    }
    if (isMaintainableUnknownValue(value)) return createUnknownValue(value);
    if (typeof value === "string") return createUnknownValue(value);
    if (value === null || value === undefined) {
        return createUnknownValue(value);
    }
    return createUnknownValue(String(value));
};

export const normalizeSkipReason = normalizeMaintainableSkipReason;
export const normalizeAvailabilityReason = normalizeMaintainableSkipReason;

export type MaintainableAvailability = {
    readonly kind: MaintainableAvailabilityKind;
    readonly reason: MaintainableSkipReason | null;
    readonly detail: string | null;
};

export type AvailabilityMetadata = MaintainableAvailability;
export type IssueAvailability = MaintainableAvailability;
export type Availability = MaintainableAvailability;
export type CommentAvailability = MaintainableAvailability;

export type MaintainableAvailabilityInput = {
    readonly kind?: unknown;
    readonly reason?: unknown;
    readonly detail?: unknown;
};

const availabilityKindFromInput = (
    kind: unknown,
): MaintainableAvailabilityKind => {
    if (kind === "available" || kind === "unavailable" || kind === "partial") {
        return kind;
    }
    if (kind === undefined || kind === null) {
        return "available";
    }
    return "unavailable";
};

const availabilityReasonFromInput = (
    reason: unknown,
): MaintainableSkipReason | null => {
    if (reason === null || reason === undefined) {
        return null;
    }
    if (typeof reason === "string" && reason.length === 0) {
        return null;
    }
    return normalizeMaintainableSkipReason(reason);
};

const availabilityDetailFromInput = (detail: unknown): string | null => {
    if (typeof detail === "string") {
        return detail;
    }
    if (detail === null || detail === undefined) {
        return null;
    }
    return String(detail);
};

const reconcileAvailabilityKindReason = (
    kind: MaintainableAvailabilityKind,
    reason: MaintainableSkipReason | null,
    detail: string | null,
): MaintainableAvailability => {
    if (kind === "available" && reason !== null) {
        const reasonKey = typeof reason === "string" ? reason : "unavailable";
        const nextKind =
            reasonKey === "partial" || reasonKey === "locked"
                ? "partial"
                : "unavailable";
        return Object.freeze({ kind: nextKind, reason, detail });
    }
    if (kind === "partial" && reason === null) {
        return Object.freeze({ kind, reason: "partial", detail });
    }
    if (kind === "unavailable" && reason === null) {
        return Object.freeze({ kind, reason: "unavailable", detail });
    }
    return Object.freeze({ kind, reason, detail });
};

export const normalizeMaintainableAvailability = (
    value: unknown,
): MaintainableAvailability => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Object.freeze({ kind: "available", reason: null, detail: null });
    }
    const record = value as Record<string, unknown>;
    const kind = availabilityKindFromInput(record.kind);
    const reason = availabilityReasonFromInput(record.reason);
    const detail = availabilityDetailFromInput(record.detail);
    return reconcileAvailabilityKindReason(kind, reason, detail);
};

export const normalizeAvailability = normalizeMaintainableAvailability;
export const createMaintainableAvailability = normalizeMaintainableAvailability;
export const toMaintainableAvailability = normalizeMaintainableAvailability;

export type MaintainableSkip = {
    readonly reason: MaintainableSkipReason;
    readonly detail: string | null;
    readonly issueNumber: number | null;
};

export type SkipMetadata = MaintainableSkip;
export type IssueSkip = MaintainableSkip;
export type Skip = MaintainableSkip;

export type MaintainableSkipInput = {
    readonly reason?: unknown;
    readonly detail?: unknown;
    readonly issueNumber?: unknown;
    readonly issue_number?: unknown;
};

const skipDetailOrNull = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return null;
    return String(value);
};

const skipIssueNumberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export const normalizeMaintainableSkip = (
    value: unknown,
): MaintainableSkip | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.reason === undefined || record.reason === null) {
        return undefined;
    }
    return Object.freeze({
        reason: normalizeMaintainableSkipReason(record.reason),
        detail: skipDetailOrNull(record.detail),
        issueNumber: skipIssueNumberOrNull(
            record.issueNumber ?? record.issue_number,
        ),
    });
};

export const normalizeSkip = normalizeMaintainableSkip;
export const createMaintainableSkip = normalizeMaintainableSkip;
export const toMaintainableSkip = normalizeMaintainableSkip;

export type MaintainableComment = {
    readonly id: number;
    readonly databaseId: number;
    readonly nodeId: string;
    readonly url: string;
    readonly htmlUrl: string;
    readonly author: MaintainableActor | null;
    readonly authorAssociation: MaintainableAuthorAssociation;
    readonly body: string | null;
    readonly content: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly isRalphieManaged: boolean;
    readonly marker: MaintainableMarker | undefined;
};

export type MaintainableIssueComment = MaintainableComment;
export type CommentThreadItem = MaintainableComment;

export type MaintainableCommentInput = {
    readonly id?: unknown;
    readonly databaseId?: unknown;
    readonly database_id?: unknown;
    readonly nodeId?: unknown;
    readonly node_id?: unknown;
    readonly url?: unknown;
    readonly html_url?: unknown;
    readonly htmlUrl?: unknown;
    readonly author?: unknown;
    readonly authorAssociation?: unknown;
    readonly author_association?: unknown;
    readonly body?: unknown;
    readonly content?: unknown;
    readonly createdAt?: unknown;
    readonly created_at?: unknown;
    readonly updatedAt?: unknown;
    readonly updated_at?: unknown;
};

const nullableBody = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

export const createMaintainableComment = (
    input: MaintainableCommentInput,
): MaintainableComment => {
    const source = (input ?? {}) as Record<string, unknown>;
    const rawId = source.id ?? source.databaseId ?? source.database_id;
    const id = numberOrZero(rawId);
    const nodeId = textOrEmpty(source.nodeId ?? source.node_id);
    const url = textOrEmpty(source.url ?? source.html_url ?? source.htmlUrl);
    const author = normalizeMaintainableActor(source.author ?? null);
    const authorAssociation = normalizeMaintainableAuthorAssociation(
        source.authorAssociation ?? source.author_association,
    );
    const body = nullableBody(
        source.body !== undefined ? source.body : source.content,
    );
    const content = nullableBody(
        source.content !== undefined ? source.content : source.body,
    );
    const createdAt = timestampOrEmpty(source.createdAt ?? source.created_at);
    const updatedAt = timestampOrEmpty(source.updatedAt ?? source.updated_at);
    const marker = parseRalphieMarker(body);
    const comment: MaintainableComment = {
        id,
        databaseId: id,
        nodeId,
        url,
        htmlUrl: url,
        author,
        authorAssociation,
        body,
        content,
        createdAt,
        updatedAt,
        isRalphieManaged: marker !== undefined,
        marker,
    };
    return Object.freeze(comment);
};

export const toMaintainableComment = createMaintainableComment;
export const normalizeMaintainableComment = createMaintainableComment;
export const cloneMaintainableComment = (
    input: MaintainableComment,
): MaintainableComment =>
    createMaintainableComment({
        id: input.id,
        nodeId: input.nodeId,
        url: input.url,
        author:
            input.author === null
                ? null
                : {
                      login: input.author.login,
                      type:
                          typeof input.author.type === "string"
                              ? input.author.type
                              : {
                                    kind: "unknown",
                                    value: input.author.type.value,
                                },
                      nodeId: input.author.nodeId,
                  },
        authorAssociation:
            typeof input.authorAssociation === "string"
                ? input.authorAssociation
                : {
                      kind: "unknown",
                      value: input.authorAssociation.value,
                  },
        body: input.body,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
    });
export const freezeMaintainableComment = cloneMaintainableComment;

export type MaintainableSelectedThread = {
    readonly comments: ReadonlyArray<MaintainableComment>;
    readonly fetchedCount: number;
    readonly totalCount: number | null;
    readonly complete: boolean;
    readonly availability: MaintainableAvailability;
};

export type SelectedCommentThread = MaintainableSelectedThread;
export type MaintainableCommentThread = MaintainableSelectedThread;
export type CommentThread = MaintainableSelectedThread;
export type SelectedThread = MaintainableSelectedThread;
export type MaintainableThread = MaintainableSelectedThread;

export type MaintainableSelectedThreadInput = {
    readonly comments?: unknown;
    readonly fetchedCount?: unknown;
    readonly fetched_count?: unknown;
    readonly totalCount?: unknown;
    readonly total_count?: unknown;
    readonly complete?: unknown;
    readonly availability?: unknown;
};

const copyComments = (value: unknown): ReadonlyArray<MaintainableComment> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const comments = value.map((entry) =>
        createMaintainableComment((entry ?? {}) as MaintainableCommentInput),
    );
    return Object.freeze(comments);
};

const threadTotalCount = (source: Record<string, unknown>): number | null => {
    const rawTotal = source.totalCount ?? source.total_count;
    if (
        typeof rawTotal === "number" &&
        Number.isSafeInteger(rawTotal) &&
        rawTotal >= 0
    ) {
        return rawTotal;
    }
    return null;
};

const threadBaseAvailability = (
    source: Record<string, unknown>,
): MaintainableAvailability =>
    normalizeMaintainableAvailability(
        source.availability ?? {
            kind: "available",
            reason: null,
            detail: null,
        },
    );

const unavailableThreadState = (
    availability: MaintainableAvailability,
    fallback: string,
): { complete: false; availability: MaintainableAvailability } => {
    if (availability.kind === "available") {
        return {
            complete: false,
            availability: Object.freeze({
                kind: "unavailable",
                reason: "unavailable",
                detail: availability.detail ?? fallback,
            }) as MaintainableAvailability,
        };
    }
    return { complete: false, availability };
};

const truncatedThreadState = (
    availability: MaintainableAvailability,
    totalCount: number,
    fetchedCount: number,
): { complete: false; availability: MaintainableAvailability } => {
    if (availability.kind === "available") {
        return {
            complete: false,
            availability: Object.freeze({
                kind: "partial",
                reason: "partial",
                detail:
                    availability.detail ??
                    `known total ${totalCount} exceeds fetched ${fetchedCount}`,
            }) as MaintainableAvailability,
        };
    }
    return { complete: false, availability };
};

const hasThreadCountContradiction = (
    totalCount: number | null,
    fetchedCount: number,
): boolean => totalCount !== null && totalCount !== fetchedCount;

const hasThreadAvailabilityContradiction = (
    availability: MaintainableAvailability,
): boolean => availability.kind !== "available" || availability.reason !== null;

const hasThreadEvidenceGap = (
    hasExplicitComments: boolean,
    fetchedCount: number,
    totalCount: number | null,
): boolean => {
    if (!hasExplicitComments) {
        return true;
    }
    return fetchedCount === 0 && totalCount !== 0;
};

const forcedIncompleteThreadAvailability = (
    availability: MaintainableAvailability,
    totalCount: number | null,
    fetchedCount: number,
): MaintainableAvailability => {
    if (totalCount !== null && totalCount > fetchedCount) {
        return Object.freeze({
            kind: "partial",
            reason: "partial",
            detail:
                availability.detail ??
                `known total ${totalCount} exceeds fetched ${fetchedCount}`,
        }) as MaintainableAvailability;
    }
    return Object.freeze({
        kind: "unavailable",
        reason: "unavailable",
        detail: availability.detail ?? "comment thread is incomplete",
    }) as MaintainableAvailability;
};

const guardCompleteThreadState = (input: {
    complete: boolean;
    availability: MaintainableAvailability;
    hasExplicitComments: boolean;
    totalCount: number | null;
    fetchedCount: number;
}): { complete: boolean; availability: MaintainableAvailability } => {
    if (!input.complete) {
        return { complete: false, availability: input.availability };
    }
    const countContradicts = hasThreadCountContradiction(
        input.totalCount,
        input.fetchedCount,
    );
    const availabilityContradicts = hasThreadAvailabilityContradiction(
        input.availability,
    );
    const evidenceMissing = hasThreadEvidenceGap(
        input.hasExplicitComments,
        input.fetchedCount,
        input.totalCount,
    );
    const isConsistent =
        !countContradicts && !availabilityContradicts && !evidenceMissing;
    if (isConsistent) {
        return { complete: true, availability: input.availability };
    }
    if (input.availability.kind !== "available") {
        return { complete: false, availability: input.availability };
    }
    return {
        complete: false,
        availability: forcedIncompleteThreadAvailability(
            input.availability,
            input.totalCount,
            input.fetchedCount,
        ),
    };
};

export const createMaintainableThread = (
    input: MaintainableSelectedThreadInput = {},
): MaintainableSelectedThread => {
    const source = (input ?? {}) as Record<string, unknown>;
    const hasExplicitComments = Array.isArray(source.comments);
    const comments = copyComments(hasExplicitComments ? source.comments : []);
    // fetchedCount is always derived from normalized comments so it stays
    // consistent with the retained thread independently of later projection.
    const fetchedCount = comments.length;
    const totalCount = threadTotalCount(source);
    const inputComplete = source.complete === true;
    const baseAvailability = threadBaseAvailability(source);
    if (!hasExplicitComments) {
        // Omitted comments (or an omitted selected-thread input) means
        // comments were not fetched: never invent a complete zero-comment
        // thread.
        const state = unavailableThreadState(
            baseAvailability,
            "comments were not fetched",
        );
        return Object.freeze({
            comments,
            fetchedCount,
            totalCount,
            ...state,
        });
    }
    if (totalCount !== null && totalCount > fetchedCount) {
        // A known total greater than the fetched count contradicts any
        // explicit complete:true: fail closed to an incomplete thread.
        const state = truncatedThreadState(
            baseAvailability,
            totalCount,
            fetchedCount,
        );
        return Object.freeze({
            comments,
            fetchedCount,
            totalCount,
            ...state,
        });
    }
    if (fetchedCount === 0 && totalCount !== 0) {
        // An explicitly fetched empty collection is complete only with
        // authoritative completion evidence such as a known total of zero.
        const state = unavailableThreadState(
            baseAvailability,
            "comment thread was fetched but completeness is unknown",
        );
        return Object.freeze({
            comments,
            fetchedCount,
            totalCount,
            ...state,
        });
    }
    if (
        baseAvailability.kind !== "available" ||
        baseAvailability.reason !== null
    ) {
        // Explicit unavailability contradicts any complete:true claim.
        return Object.freeze({
            comments,
            fetchedCount,
            totalCount,
            complete: false,
            availability: baseAvailability,
        });
    }
    const guarded = guardCompleteThreadState({
        complete: inputComplete,
        availability: baseAvailability,
        hasExplicitComments,
        totalCount,
        fetchedCount,
    });
    return Object.freeze({
        comments,
        fetchedCount,
        totalCount,
        ...guarded,
    });
};

export const toMaintainableThread = createMaintainableThread;
export const normalizeMaintainableThread = createMaintainableThread;
export const createSelectedThread = createMaintainableThread;
export const toSelectedThread = createMaintainableThread;
export const cloneMaintainableThread = (
    input: MaintainableSelectedThread,
): MaintainableSelectedThread =>
    createMaintainableThread({
        comments: input.comments.map((comment) => ({ ...comment })),
        fetchedCount: input.fetchedCount,
        totalCount: input.totalCount,
        complete: input.complete,
        availability: { ...input.availability },
    });
export const cloneSelectedThread = cloneMaintainableThread;

export type MaintainableIssue = {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly body: string | null;
    readonly url: string;
    readonly htmlUrl: string;
    readonly state: MaintainableIssueState;
    readonly isOpen: boolean;
    readonly open: boolean;
    readonly author: MaintainableActor | null;
    readonly authorAssociation: MaintainableAuthorAssociation;
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly assignees: ReadonlyArray<MaintainableAssignee>;
    readonly milestone: MaintainableMilestone | undefined;
    readonly locked: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly selectedThread: MaintainableSelectedThread;
    readonly thread: MaintainableSelectedThread;
    readonly commentThread: MaintainableSelectedThread;
    readonly marker: MaintainableMarker | undefined;
    readonly isRalphieManaged: boolean;
    readonly availability: MaintainableAvailability;
    readonly skip: MaintainableSkip | undefined;
};

export type MaintainableIssueSnapshot = MaintainableIssue;

export type MaintainableIssueInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly node_id?: unknown;
    readonly title?: unknown;
    readonly body?: unknown;
    readonly url?: unknown;
    readonly html_url?: unknown;
    readonly htmlUrl?: unknown;
    readonly state?: unknown;
    readonly isOpen?: unknown;
    readonly open?: unknown;
    readonly author?: unknown;
    readonly authorAssociation?: unknown;
    readonly author_association?: unknown;
    readonly labels?: unknown;
    readonly assignees?: unknown;
    readonly milestone?: unknown;
    readonly locked?: unknown;
    readonly createdAt?: unknown;
    readonly created_at?: unknown;
    readonly updatedAt?: unknown;
    readonly updated_at?: unknown;
    readonly selectedThread?: unknown;
    readonly thread?: unknown;
    readonly commentThread?: unknown;
    readonly comments?: unknown;
    readonly availability?: unknown;
    readonly skip?: unknown;
};

const copyLabels = (value: unknown): ReadonlyArray<MaintainableLabel> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const labels = value.map((entry) => normalizeMaintainableLabel(entry));
    return Object.freeze(labels);
};

const copyAssignees = (value: unknown): ReadonlyArray<MaintainableAssignee> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const assignees: MaintainableAssignee[] = [];
    for (const entry of value) {
        const actor = normalizeMaintainableActor(entry);
        if (actor !== null) assignees.push(actor);
    }
    return Object.freeze(assignees);
};

const resolveThreadInput = (
    source: Record<string, unknown>,
): MaintainableSelectedThreadInput => {
    const direct =
        source.selectedThread ?? source.thread ?? source.commentThread;
    if (
        direct !== null &&
        typeof direct === "object" &&
        !Array.isArray(direct)
    ) {
        return direct as MaintainableSelectedThreadInput;
    }
    if (Array.isArray(source.comments)) {
        return { comments: source.comments };
    }
    if (Array.isArray(direct)) {
        return { comments: direct };
    }
    return {};
};

const skipKindForReason = (
    reason: MaintainableSkipReason,
): MaintainableAvailabilityKind => {
    const key = typeof reason === "string" ? reason : "unavailable";
    return key === "partial" || key === "locked" ? "partial" : "unavailable";
};

const applySkipToAvailability = (
    availability: MaintainableAvailability,
    skip: MaintainableSkip,
): MaintainableAvailability => {
    if (availability.kind !== "available") {
        return availability;
    }
    return Object.freeze({
        kind: skipKindForReason(skip.reason),
        reason: skip.reason,
        detail: skip.detail ?? availability.detail,
    }) as MaintainableAvailability;
};

const applySkipToThread = (
    thread: MaintainableSelectedThread,
    skip: MaintainableSkip,
): MaintainableSelectedThread => {
    if (thread.availability.kind === "available") {
        return Object.freeze({
            ...thread,
            complete: false,
            availability: Object.freeze({
                kind: skipKindForReason(skip.reason),
                reason: skip.reason,
                detail: skip.detail ?? thread.availability.detail,
            }),
        }) as MaintainableSelectedThread;
    }
    if (thread.complete) {
        return Object.freeze({
            ...thread,
            complete: false,
        }) as MaintainableSelectedThread;
    }
    return thread;
};

const applyLockedToAvailability = (
    availability: MaintainableAvailability,
): MaintainableAvailability => {
    if (availability.kind !== "available") {
        return availability;
    }
    return Object.freeze({
        kind: "partial",
        reason: "locked",
        detail: availability.detail ?? "issue is locked",
    }) as MaintainableAvailability;
};

const applyLockedToThread = (
    thread: MaintainableSelectedThread,
): MaintainableSelectedThread => {
    if (thread.availability.kind !== "available") {
        return thread;
    }
    return Object.freeze({
        ...thread,
        complete: false,
        availability: Object.freeze({
            kind: "partial",
            reason: "locked",
            detail: thread.availability.detail ?? "issue is locked",
        }),
    }) as MaintainableSelectedThread;
};

export const createMaintainableIssue = (
    input: MaintainableIssueInput,
): MaintainableIssue => {
    const source = (input ?? {}) as Record<string, unknown>;
    const number = numberOrZero(source.number);
    const nodeId = textOrEmpty(source.nodeId ?? source.node_id);
    const title = textOrEmpty(source.title);
    const body = nullableBody(source.body);
    const url = textOrEmpty(source.url ?? source.html_url ?? source.htmlUrl);
    const state = normalizeMaintainableIssueState(source.state);
    const isOpen = state === "open";
    const author = normalizeMaintainableActor(source.author ?? null);
    const authorAssociation = normalizeMaintainableAuthorAssociation(
        source.authorAssociation ?? source.author_association,
    );
    const labels = copyLabels(source.labels);
    const assignees = copyAssignees(source.assignees);
    const milestone = normalizeMaintainableMilestone(source.milestone ?? null);
    const locked = source.locked === true;
    const createdAt = timestampOrEmpty(source.createdAt ?? source.created_at);
    const updatedAt = timestampOrEmpty(source.updatedAt ?? source.updated_at);
    const skip = normalizeMaintainableSkip(source.skip ?? null);
    let selectedThread = createMaintainableThread(resolveThreadInput(source));
    const marker = parseRalphieMarker(body);
    let availability = normalizeMaintainableAvailability(
        source.availability ?? {
            kind: "available",
            reason: null,
            detail: null,
        },
    );
    if (skip !== undefined) {
        availability = applySkipToAvailability(availability, skip);
        selectedThread = applySkipToThread(selectedThread, skip);
    }
    if (locked) {
        availability = applyLockedToAvailability(availability);
        selectedThread = applyLockedToThread(selectedThread);
    }
    const issue: MaintainableIssue = {
        number,
        nodeId,
        title,
        body,
        url,
        htmlUrl: url,
        state,
        isOpen,
        open: isOpen,
        author,
        authorAssociation,
        labels,
        assignees,
        milestone,
        locked,
        createdAt,
        updatedAt,
        selectedThread,
        thread: selectedThread,
        commentThread: selectedThread,
        marker,
        isRalphieManaged: marker !== undefined,
        availability,
        skip,
    };
    return Object.freeze(issue);
};

export const toMaintainableIssue = createMaintainableIssue;
export const normalizeMaintainableIssue = createMaintainableIssue;
export const snapshotMaintainableIssue = createMaintainableIssue;
export const freezeMaintainableIssue = (
    input: MaintainableIssue,
): MaintainableIssue =>
    createMaintainableIssue({
        number: input.number,
        nodeId: input.nodeId,
        title: input.title,
        body: input.body,
        url: input.url,
        state:
            typeof input.state === "string"
                ? input.state
                : { kind: "unknown", value: input.state.value },
        author:
            input.author === null
                ? null
                : {
                      login: input.author.login,
                      type:
                          typeof input.author.type === "string"
                              ? input.author.type
                              : {
                                    kind: "unknown",
                                    value: input.author.type.value,
                                },
                      nodeId: input.author.nodeId,
                  },
        authorAssociation:
            typeof input.authorAssociation === "string"
                ? input.authorAssociation
                : {
                      kind: "unknown",
                      value: input.authorAssociation.value,
                  },
        labels: input.labels.map((label) => ({ ...label })),
        assignees: input.assignees.map((assignee) => ({ ...assignee })),
        milestone:
            input.milestone === undefined ? undefined : { ...input.milestone },
        locked: input.locked,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        selectedThread: {
            comments: input.selectedThread.comments.map((comment) => ({
                ...comment,
            })),
            fetchedCount: input.selectedThread.fetchedCount,
            totalCount: input.selectedThread.totalCount,
            complete: input.selectedThread.complete,
            availability: { ...input.selectedThread.availability },
        },
        availability: { ...input.availability },
        skip:
            input.skip === undefined
                ? undefined
                : {
                      reason:
                          typeof input.skip.reason === "string"
                              ? input.skip.reason
                              : {
                                    kind: "unknown",
                                    value: input.skip.reason.value,
                                },
                      detail: input.skip.detail,
                      issueNumber: input.skip.issueNumber,
                  },
    });
export const cloneMaintainableIssue = freezeMaintainableIssue;