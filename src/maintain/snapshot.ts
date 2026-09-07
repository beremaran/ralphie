/**
 * Canonical maintenance snapshot seam.
 *
 * A single typed snapshot vocabulary with one name per concept and one
 * construction function per value. This module is the only maintenance
 * value layer; all maintenance callers use these `Maintenance*` names.
 *
 * REST translation lives exactly once at the GitHub reader boundary
 * (`src/maintain/github-reader/translate.ts`), which maps provider records
 * into the canonical inputs below. These inputs use only canonical camelCase
 * keys: they never read REST snake_case keys (`node_id`, `html_url`,
 * `author_association`, `created_at`, ...) or REST aliases (`user` for
 * `author`, `content` for `body`, `database_id` for `id`). Unknown provider
 * values, unavailable comment threads, bounded evidence, and fail-closed
 * completeness are preserved by the construction functions.
 *
 * Immutability contract: every value returned by this module is deeply
 * frozen (`Object.freeze` at every level). Construction deep-copies all
 * nested arrays, records, and `raw` evidence so later mutation of a caller
 * supplied input cannot alter a captured snapshot, and mutation of a
 * returned snapshot is rejected (frozen). Callers must treat snapshots as
 * readonly and re-invoke a construction function for a new value instead of
 * mutating. `Object.isFrozen` holds for every returned value and every
 * nested array/record.
 *
 * Canonical concepts covered here:
 * - repository (`MaintenanceRepository`)
 * - issue (`MaintenanceIssue`, canonical thread `selectedThread` only)
 * - comment thread (`MaintenanceCommentThread`, `MaintenanceComment`,
 *   canonical `body`/`url`/`id` only)
 * - availability (`MaintenanceAvailability`, `MaintenanceSkip`)
 * - unknown provider evidence (`MaintenanceUnknown`)
 *
 * There are no duplicate aliases in this module: each concept has exactly
 * one type name and one construction function. Mirrored outputs (`databaseId`
 * for `id`, `htmlUrl` for `url`, `content` for `body`, `isOpen`/`open` for
 * `state`, `thread`/`commentThread` for `selectedThread`) do not exist here.
 */

export type MaintenanceUnknown = {
    readonly kind: "unknown";
    readonly value: string;
};

export const isMaintenanceUnknown = (
    value: unknown,
): value is MaintenanceUnknown =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly kind?: unknown }).kind === "unknown" &&
    typeof (value as { readonly value?: unknown }).value === "string";

export const createMaintenanceUnknown = (
    value: unknown,
): MaintenanceUnknown => {
    if (isMaintenanceUnknown(value)) {
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

export type MaintenanceIssueState = "open" | "closed" | MaintenanceUnknown;

export const normalizeMaintenanceIssueState = (
    value: unknown,
): MaintenanceIssueState => {
    if (value === "open" || value === "closed") return value;
    if (isMaintenanceUnknown(value)) return createMaintenanceUnknown(value);
    if (typeof value === "string") return createMaintenanceUnknown(value);
    if (value === null || value === undefined) {
        return createMaintenanceUnknown(value);
    }
    return createMaintenanceUnknown(String(value));
};

export const isMaintenanceIssueOpen = (state: MaintenanceIssueState): boolean =>
    state === "open";

export type MaintenanceMilestoneState = "open" | "closed" | MaintenanceUnknown;

const normalizeMaintenanceMilestoneState = (
    value: unknown,
): MaintenanceMilestoneState => {
    if (value === "open" || value === "closed") return value;
    if (isMaintenanceUnknown(value)) return createMaintenanceUnknown(value);
    if (typeof value === "string") return createMaintenanceUnknown(value);
    if (value === null || value === undefined) {
        return createMaintenanceUnknown(value);
    }
    return createMaintenanceUnknown(String(value));
};

export type MaintenanceActorType =
    | "User"
    | "Bot"
    | "Organization"
    | "Mannequin"
    | MaintenanceUnknown;

const normalizeMaintenanceActorType = (
    value: unknown,
): MaintenanceActorType => {
    if (
        value === "User" ||
        value === "Bot" ||
        value === "Organization" ||
        value === "Mannequin"
    ) {
        return value;
    }
    if (isMaintenanceUnknown(value)) return createMaintenanceUnknown(value);
    if (typeof value === "string") return createMaintenanceUnknown(value);
    if (value === null || value === undefined) {
        return createMaintenanceUnknown(value);
    }
    return createMaintenanceUnknown(String(value));
};

export type MaintenanceActor = {
    readonly login: string;
    readonly type: MaintenanceActorType;
    readonly nodeId: string | null;
};

/** Canonical actor input: camelCase only. REST translation happens in the reader. */
export type MaintenanceActorInput = {
    readonly login?: unknown;
    readonly type?: unknown;
    readonly nodeId?: unknown;
};

const textOrNull = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    return value;
};

const textOrEmpty = (value: unknown): string =>
    typeof value === "string" ? value : "";

const timestampOrEmpty = (value: unknown): string =>
    typeof value === "string" ? value : "";

const actorFromString = (value: string): MaintenanceActor | null => {
    const login = value.trim();
    if (login.length === 0) return null;
    return Object.freeze({
        login,
        type: createMaintenanceUnknown("missing") as MaintenanceActorType,
        nodeId: null,
    });
};

const actorFromNonRecord = (value: unknown): MaintenanceActor =>
    Object.freeze({
        login: "unknown",
        type: createMaintenanceUnknown(String(value)) as MaintenanceActorType,
        nodeId: null,
    });

const actorFromRecord = (record: Record<string, unknown>): MaintenanceActor => {
    // Canonical keys only: `login`, `type`, `nodeId`. Provider variations
    // (`name`/`username`, `kind`/`actorType`, `node_id`) are translated at the
    // GitHub read boundary and are never read here.
    const rawLogin = record.login;
    if (typeof rawLogin !== "string" || rawLogin.trim().length === 0) {
        const fallback = record.type ?? "unknown";
        return Object.freeze({
            login: "unknown",
            type: normalizeMaintenanceActorType(fallback),
            nodeId: textOrNull(record.nodeId),
        });
    }
    return Object.freeze({
        login: rawLogin.trim(),
        type: normalizeMaintenanceActorType(record.type),
        nodeId: textOrNull(record.nodeId),
    });
};

export const normalizeMaintenanceActor = (
    value: unknown,
): MaintenanceActor | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return actorFromString(value);
    if (typeof value !== "object" || Array.isArray(value)) {
        return actorFromNonRecord(value);
    }
    return actorFromRecord(value as Record<string, unknown>);
};

export type MaintenanceAuthorAssociation =
    | "COLLABORATOR"
    | "CONTRIBUTOR"
    | "FIRST_TIMER"
    | "FIRST_TIME_CONTRIBUTOR"
    | "MANNEQUIN"
    | "MEMBER"
    | "NONE"
    | "OWNER"
    | MaintenanceUnknown;

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

export const normalizeMaintenanceAuthorAssociation = (
    value: unknown,
): MaintenanceAuthorAssociation => {
    if (
        typeof value === "string" &&
        (KNOWN_AUTHOR_ASSOCIATIONS as ReadonlyArray<string>).includes(value)
    ) {
        return value as MaintenanceAuthorAssociation;
    }
    if (isMaintenanceUnknown(value)) return createMaintenanceUnknown(value);
    if (typeof value === "string") return createMaintenanceUnknown(value);
    if (value === null || value === undefined) {
        return createMaintenanceUnknown(value);
    }
    return createMaintenanceUnknown(String(value));
};

export type MaintenanceLabel = {
    readonly name: string;
    readonly description: string | null;
    readonly color: string | null;
};

/** Canonical label input. */
export type MaintenanceLabelInput = {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly color?: unknown;
};

export const normalizeMaintenanceLabel = (value: unknown): MaintenanceLabel => {
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

export type MaintenanceMilestone = {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly description: string | null;
    readonly state: MaintenanceMilestoneState;
    readonly url: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly dueOn: string | null;
};

/** Canonical milestone input: camelCase only. */
export type MaintenanceMilestoneInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly title?: unknown;
    readonly description?: unknown;
    readonly state?: unknown;
    readonly url?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
    readonly dueOn?: unknown;
};

const numberOrZero = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : 0;

export const normalizeMaintenanceMilestone = (
    value: unknown,
): MaintenanceMilestone | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const milestone: MaintenanceMilestone = {
        number: numberOrZero(record.number),
        nodeId: textOrEmpty(record.nodeId),
        title: textOrEmpty(record.title),
        description: textOrNull(record.description),
        state: normalizeMaintenanceMilestoneState(record.state),
        url: textOrEmpty(record.url),
        createdAt: timestampOrEmpty(record.createdAt),
        updatedAt: timestampOrEmpty(record.updatedAt),
        dueOn: textOrNull(record.dueOn),
    };
    return Object.freeze(milestone);
};

export type MaintenanceMarkerKind =
    | "decomposition"
    | "decomposition-original"
    | "needs-attention"
    | "pr-review"
    | "review-attempt"
    | "maintain"
    | "maintenance-action"
    | "maintenance-relationship";

export type MaintenanceMarker = {
    readonly kind: MaintenanceMarkerKind;
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
    readonly version?: number;
    readonly action?: "ask-question" | "answer-question";
    readonly actionKey?: string;
    readonly bodySha256?: string;
    readonly relation?: "duplicate" | "related";
    readonly targetIssueNumber?: number;
    readonly pairKey?: string;
};

export const MAINTENANCE_MARKER = "ralphie:maintain";

export const renderMaintenanceMarker = (issueNumber: number): string =>
    `<!-- ${MAINTENANCE_MARKER} issue=${issueNumber} -->`;

const DECOMPOSITION_PATTERN =
    /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/;
const DECOMPOSITION_ORIGINAL_PATTERN =
    /<!-- ralphie:decomposition original=(\d+) depth=(\d+) -->/;
const NEEDS_ATTENTION_PATTERN = /<!-- ralphie:needs-attention issue=(\d+) -->/;
const PR_REVIEW_PATTERN =
    /<!-- ralphie:pr-review pr=(\d+) head=([0-9a-f]{40}(?:[0-9a-f]{24})?) attempt=(\d+) -->/;
const REVIEW_ATTEMPT_PATTERN = /<!-- ralphie:review-attempt=(\d+) -->/;
const MAINTAIN_PATTERN = /<!-- ralphie:maintain issue=(\d+) -->/;
const MAINTENANCE_ACTION_PATTERN =
    /<!-- ralphie:maintain-action version=1 issue=([1-9]\d*) action=(ask-question|answer-question) key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/;
const MAINTENANCE_RELATIONSHIP_PATTERN =
    /<!-- ralphie:maintain-relationship version=1 issue=([1-9]\d*) relation=(duplicate|related) target=([1-9]\d*) pair-key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/;

const safeInteger = (text: string): number | undefined => {
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseDecompositionMarker = (
    body: string,
): MaintenanceMarker | undefined => {
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
): MaintenanceMarker | undefined => {
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

const parseNeedsAttentionMarker = (
    body: string,
): MaintenanceMarker | undefined => {
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

const parsePrReviewMarker = (body: string): MaintenanceMarker | undefined => {
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

const parseReviewAttemptMarker = (
    body: string,
): MaintenanceMarker | undefined => {
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

const parseMaintainMarkerValue = (
    body: string,
): MaintenanceMarker | undefined => {
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

const parseMaintenanceActionMarkerValue = (
    body: string,
): MaintenanceMarker | undefined => {
    const maintenanceAction = MAINTENANCE_ACTION_PATTERN.exec(body);
    if (maintenanceAction === null) return undefined;
    const issue = safeInteger(maintenanceAction[1] ?? "");
    const action = maintenanceAction[2];
    const bodySha256 = maintenanceAction[4];
    if (
        issue === undefined ||
        (action !== "ask-question" && action !== "answer-question") ||
        bodySha256 === undefined
    ) {
        return undefined;
    }
    let actionKey: unknown;
    try {
        actionKey = JSON.parse(maintenanceAction[3] ?? "");
    } catch {
        return undefined;
    }
    if (typeof actionKey !== "string" || actionKey.trim().length === 0) {
        return undefined;
    }
    return Object.freeze({
        kind: "maintenance-action",
        normalized: maintenanceAction[0],
        issue,
        version: 1,
        action,
        actionKey,
        bodySha256,
    });
};

const parseMaintenanceRelationshipMarkerValue = (
    body: string,
): MaintenanceMarker | undefined => {
    const relationship = MAINTENANCE_RELATIONSHIP_PATTERN.exec(body);
    if (relationship === null) return undefined;
    const issue = safeInteger(relationship[1] ?? "");
    const relation = relationship[2];
    const targetIssueNumber = safeInteger(relationship[3] ?? "");
    const bodySha256 = relationship[5];
    if (
        issue === undefined ||
        issue <= 0 ||
        (relation !== "duplicate" && relation !== "related") ||
        targetIssueNumber === undefined ||
        targetIssueNumber <= 0 ||
        issue === targetIssueNumber ||
        bodySha256 === undefined
    ) {
        return undefined;
    }
    let pairKey: unknown;
    try {
        pairKey = JSON.parse(relationship[4] ?? "");
    } catch {
        return undefined;
    }
    if (typeof pairKey !== "string" || pairKey.trim().length === 0) {
        return undefined;
    }
    return Object.freeze({
        kind: "maintenance-relationship",
        normalized: relationship[0],
        issue,
        version: 1,
        relation,
        targetIssueNumber,
        pairKey,
        bodySha256,
    });
};

const parseSingleMarker = (body: string): MaintenanceMarker | undefined =>
    parseDecompositionMarker(body) ??
    parseDecompositionOriginalMarker(body) ??
    parseNeedsAttentionMarker(body) ??
    parsePrReviewMarker(body) ??
    parseReviewAttemptMarker(body) ??
    parseMaintainMarkerValue(body) ??
    parseMaintenanceActionMarkerValue(body) ??
    parseMaintenanceRelationshipMarkerValue(body);

export const parseMaintenanceMarker = (
    body: string | null | undefined,
): MaintenanceMarker | undefined => {
    if (typeof body !== "string" || body.length === 0) return undefined;
    return parseSingleMarker(body);
};

const GLOBAL_MARKER_PATTERNS: ReadonlyArray<RegExp> = [
    /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/g,
    /<!-- ralphie:decomposition original=(\d+) depth=(\d+) -->/g,
    /<!-- ralphie:needs-attention issue=(\d+) -->/g,
    /<!-- ralphie:pr-review pr=(\d+) head=([0-9a-f]{40}(?:[0-9a-f]{24})?) attempt=(\d+) -->/g,
    /<!-- ralphie:review-attempt=(\d+) -->/g,
    /<!-- ralphie:maintain issue=(\d+) -->/g,
    /<!-- ralphie:maintain-action version=1 issue=([1-9]\d*) action=(ask-question|answer-question) key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/g,
    /<!-- ralphie:maintain-relationship version=1 issue=([1-9]\d*) relation=(duplicate|related) target=([1-9]\d*) pair-key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/g,
];

export const parseAllMaintenanceMarkers = (
    body: string | null | undefined,
): ReadonlyArray<MaintenanceMarker> => {
    if (typeof body !== "string" || body.length === 0) {
        return Object.freeze([]);
    }
    const markers: MaintenanceMarker[] = [];
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

export const isMaintenanceManaged = (
    body: string | null | undefined,
): boolean => parseMaintenanceMarker(body) !== undefined;

export type MaintenanceAvailabilityKind =
    | "available"
    | "unavailable"
    | "partial";

export type MaintenanceSkipReason =
    | "transferred"
    | "deleted"
    | "inaccessible"
    | "null-author"
    | "locked"
    | "partial"
    | "unavailable"
    | MaintenanceUnknown;

const KNOWN_SKIP_REASONS: ReadonlyArray<string> = [
    "transferred",
    "deleted",
    "inaccessible",
    "null-author",
    "locked",
    "partial",
    "unavailable",
];

export const normalizeMaintenanceSkipReason = (
    value: unknown,
): MaintenanceSkipReason => {
    if (
        typeof value === "string" &&
        (KNOWN_SKIP_REASONS as ReadonlyArray<string>).includes(value)
    ) {
        return value as MaintenanceSkipReason;
    }
    if (isMaintenanceUnknown(value)) return createMaintenanceUnknown(value);
    if (typeof value === "string") return createMaintenanceUnknown(value);
    if (value === null || value === undefined) {
        return createMaintenanceUnknown(value);
    }
    return createMaintenanceUnknown(String(value));
};

export type MaintenanceAvailability = {
    readonly kind: MaintenanceAvailabilityKind;
    readonly reason: MaintenanceSkipReason | null;
    readonly detail: string | null;
};

export type MaintenanceAvailabilityInput = {
    readonly kind?: unknown;
    readonly reason?: unknown;
    readonly detail?: unknown;
};

const availabilityKindFromInput = (
    kind: unknown,
): MaintenanceAvailabilityKind => {
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
): MaintenanceSkipReason | null => {
    if (reason === null || reason === undefined) {
        return null;
    }
    if (typeof reason === "string" && reason.length === 0) {
        return null;
    }
    return normalizeMaintenanceSkipReason(reason);
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
    kind: MaintenanceAvailabilityKind,
    reason: MaintenanceSkipReason | null,
    detail: string | null,
): MaintenanceAvailability => {
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

export const normalizeMaintenanceAvailability = (
    value: unknown,
): MaintenanceAvailability => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Object.freeze({ kind: "available", reason: null, detail: null });
    }
    const record = value as Record<string, unknown>;
    const kind = availabilityKindFromInput(record.kind);
    const reason = availabilityReasonFromInput(record.reason);
    const detail = availabilityDetailFromInput(record.detail);
    return reconcileAvailabilityKindReason(kind, reason, detail);
};

export type MaintenanceSkip = {
    readonly reason: MaintenanceSkipReason;
    readonly detail: string | null;
    readonly issueNumber: number | null;
};

export type MaintenanceSkipInput = {
    readonly reason?: unknown;
    readonly detail?: unknown;
    readonly issueNumber?: unknown;
};

const skipDetailOrNull = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return null;
    return String(value);
};

const skipIssueNumberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export const normalizeMaintenanceSkip = (
    value: unknown,
): MaintenanceSkip | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.reason === undefined || record.reason === null) {
        return undefined;
    }
    return Object.freeze({
        reason: normalizeMaintenanceSkipReason(record.reason),
        detail: skipDetailOrNull(record.detail),
        issueNumber: skipIssueNumberOrNull(record.issueNumber),
    });
};

export type MaintenanceComment = {
    readonly id: number;
    readonly nodeId: string;
    readonly url: string;
    readonly author: MaintenanceActor | null;
    readonly authorAssociation: MaintenanceAuthorAssociation;
    readonly body: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly isMaintenanceManaged: boolean;
    readonly marker: MaintenanceMarker | undefined;
};

/** Canonical comment input: camelCase only, single `body`/`url`/`id` names. */
export type MaintenanceCommentInput = {
    readonly id?: unknown;
    readonly nodeId?: unknown;
    readonly url?: unknown;
    readonly author?: unknown;
    readonly authorAssociation?: unknown;
    readonly body?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
};

const nullableBody = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

export const createMaintenanceComment = (
    input: MaintenanceCommentInput,
): MaintenanceComment => {
    const source = (input ?? {}) as Record<string, unknown>;
    const id = numberOrZero(source.id);
    const nodeId = textOrEmpty(source.nodeId);
    const url = textOrEmpty(source.url);
    const author = normalizeMaintenanceActor(source.author ?? null);
    const authorAssociation = normalizeMaintenanceAuthorAssociation(
        source.authorAssociation,
    );
    const body = nullableBody(source.body);
    const createdAt = timestampOrEmpty(source.createdAt);
    const updatedAt = timestampOrEmpty(source.updatedAt);
    const marker = parseMaintenanceMarker(body);
    const comment: MaintenanceComment = {
        id,
        nodeId,
        url,
        author,
        authorAssociation,
        body,
        createdAt,
        updatedAt,
        isMaintenanceManaged: marker !== undefined,
        marker,
    };
    return Object.freeze(comment);
};

export type MaintenanceCommentThread = {
    readonly comments: ReadonlyArray<MaintenanceComment>;
    readonly fetchedCount: number;
    readonly totalCount: number | null;
    readonly complete: boolean;
    readonly availability: MaintenanceAvailability;
};

/** Canonical thread input: camelCase only, one thread name. */
export type MaintenanceCommentThreadInput = {
    readonly comments?: unknown;
    readonly totalCount?: unknown;
    readonly complete?: unknown;
    readonly availability?: unknown;
};

const copyComments = (value: unknown): ReadonlyArray<MaintenanceComment> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const comments = value.map((entry) =>
        createMaintenanceComment((entry ?? {}) as MaintenanceCommentInput),
    );
    return Object.freeze(comments);
};

const threadTotalCount = (source: Record<string, unknown>): number | null => {
    const rawTotal = source.totalCount;
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
): MaintenanceAvailability =>
    normalizeMaintenanceAvailability(
        source.availability ?? {
            kind: "available",
            reason: null,
            detail: null,
        },
    );

const unavailableThreadState = (
    availability: MaintenanceAvailability,
    fallback: string,
): { complete: false; availability: MaintenanceAvailability } => {
    if (availability.kind === "available") {
        return {
            complete: false,
            availability: Object.freeze({
                kind: "unavailable",
                reason: "unavailable",
                detail: availability.detail ?? fallback,
            }) as MaintenanceAvailability,
        };
    }
    return { complete: false, availability };
};

const truncatedThreadState = (
    availability: MaintenanceAvailability,
    totalCount: number,
    fetchedCount: number,
): { complete: false; availability: MaintenanceAvailability } => {
    if (availability.kind === "available") {
        return {
            complete: false,
            availability: Object.freeze({
                kind: "partial",
                reason: "partial",
                detail:
                    availability.detail ??
                    `known total ${totalCount} exceeds fetched ${fetchedCount}`,
            }) as MaintenanceAvailability,
        };
    }
    return { complete: false, availability };
};

const hasThreadCountContradiction = (
    totalCount: number | null,
    fetchedCount: number,
): boolean => totalCount !== null && totalCount !== fetchedCount;

const hasThreadAvailabilityContradiction = (
    availability: MaintenanceAvailability,
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
    availability: MaintenanceAvailability,
    totalCount: number | null,
    fetchedCount: number,
): MaintenanceAvailability => {
    if (totalCount !== null && totalCount > fetchedCount) {
        return Object.freeze({
            kind: "partial",
            reason: "partial",
            detail:
                availability.detail ??
                `known total ${totalCount} exceeds fetched ${fetchedCount}`,
        }) as MaintenanceAvailability;
    }
    return Object.freeze({
        kind: "unavailable",
        reason: "unavailable",
        detail: availability.detail ?? "comment thread is incomplete",
    }) as MaintenanceAvailability;
};

const guardCompleteThreadState = (input: {
    complete: boolean;
    availability: MaintenanceAvailability;
    hasExplicitComments: boolean;
    totalCount: number | null;
    fetchedCount: number;
}): { complete: boolean; availability: MaintenanceAvailability } => {
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

export const createMaintenanceCommentThread = (
    input: MaintenanceCommentThreadInput = {},
): MaintenanceCommentThread => {
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

export type MaintenanceIssue = {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly body: string | null;
    readonly url: string;
    readonly state: MaintenanceIssueState;
    readonly author: MaintenanceActor | null;
    readonly authorAssociation: MaintenanceAuthorAssociation;
    readonly labels: ReadonlyArray<MaintenanceLabel>;
    readonly assignees: ReadonlyArray<MaintenanceActor>;
    readonly milestone: MaintenanceMilestone | undefined;
    readonly locked: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly selectedThread: MaintenanceCommentThread;
    readonly marker: MaintenanceMarker | undefined;
    readonly isMaintenanceManaged: boolean;
    readonly availability: MaintenanceAvailability;
    readonly skip: MaintenanceSkip | undefined;
};

/** Canonical issue input: camelCase only, one thread name (`selectedThread`). */
export type MaintenanceIssueInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly title?: unknown;
    readonly body?: unknown;
    readonly url?: unknown;
    readonly state?: unknown;
    readonly author?: unknown;
    readonly authorAssociation?: unknown;
    readonly labels?: unknown;
    readonly assignees?: unknown;
    readonly milestone?: unknown;
    readonly locked?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
    readonly selectedThread?: unknown;
    readonly availability?: unknown;
    readonly skip?: unknown;
};

const copyLabels = (value: unknown): ReadonlyArray<MaintenanceLabel> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const labels = value.map((entry) => normalizeMaintenanceLabel(entry));
    return Object.freeze(labels);
};

const copyAssignees = (value: unknown): ReadonlyArray<MaintenanceActor> => {
    if (!Array.isArray(value)) return Object.freeze([]);
    const assignees: MaintenanceActor[] = [];
    for (const entry of value) {
        const actor = normalizeMaintenanceActor(entry);
        if (actor !== null) assignees.push(actor);
    }
    return Object.freeze(assignees);
};

const resolveThreadInput = (
    source: Record<string, unknown>,
): MaintenanceCommentThreadInput => {
    // Canonical thread field only. Provider aliases (`thread`,
    // `commentThread`, `comments`) are translated at the GitHub read boundary.
    const direct = source.selectedThread;
    if (
        direct !== null &&
        typeof direct === "object" &&
        !Array.isArray(direct)
    ) {
        return direct as MaintenanceCommentThreadInput;
    }
    return {};
};

const skipKindForReason = (
    reason: MaintenanceSkipReason,
): MaintenanceAvailabilityKind => {
    const key = typeof reason === "string" ? reason : "unavailable";
    return key === "partial" || key === "locked" ? "partial" : "unavailable";
};

const applySkipToAvailability = (
    availability: MaintenanceAvailability,
    skip: MaintenanceSkip,
): MaintenanceAvailability => {
    if (availability.kind !== "available") {
        return availability;
    }
    return Object.freeze({
        kind: skipKindForReason(skip.reason),
        reason: skip.reason,
        detail: skip.detail ?? availability.detail,
    }) as MaintenanceAvailability;
};

const applySkipToThread = (
    thread: MaintenanceCommentThread,
    skip: MaintenanceSkip,
): MaintenanceCommentThread => {
    if (thread.availability.kind === "available") {
        return Object.freeze({
            ...thread,
            complete: false,
            availability: Object.freeze({
                kind: skipKindForReason(skip.reason),
                reason: skip.reason,
                detail: skip.detail ?? thread.availability.detail,
            }),
        }) as MaintenanceCommentThread;
    }
    if (thread.complete) {
        return Object.freeze({
            ...thread,
            complete: false,
        }) as MaintenanceCommentThread;
    }
    return thread;
};

const applyLockedToAvailability = (
    availability: MaintenanceAvailability,
): MaintenanceAvailability => {
    if (availability.kind !== "available") {
        return availability;
    }
    return Object.freeze({
        kind: "partial",
        reason: "locked",
        detail: availability.detail ?? "issue is locked",
    }) as MaintenanceAvailability;
};

const applyLockedToThread = (
    thread: MaintenanceCommentThread,
): MaintenanceCommentThread => {
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
    }) as MaintenanceCommentThread;
};

export const createMaintenanceIssue = (
    input: MaintenanceIssueInput,
): MaintenanceIssue => {
    const source = (input ?? {}) as Record<string, unknown>;
    const number = numberOrZero(source.number);
    const nodeId = textOrEmpty(source.nodeId);
    const title = textOrEmpty(source.title);
    const body = nullableBody(source.body);
    const url = textOrEmpty(source.url);
    const state = normalizeMaintenanceIssueState(source.state);
    const author = normalizeMaintenanceActor(source.author ?? null);
    const authorAssociation = normalizeMaintenanceAuthorAssociation(
        source.authorAssociation,
    );
    const labels = copyLabels(source.labels);
    const assignees = copyAssignees(source.assignees);
    const milestone = normalizeMaintenanceMilestone(source.milestone ?? null);
    const locked = source.locked === true;
    const createdAt = timestampOrEmpty(source.createdAt);
    const updatedAt = timestampOrEmpty(source.updatedAt);
    const skip = normalizeMaintenanceSkip(source.skip ?? null);
    let selectedThread = createMaintenanceCommentThread(
        resolveThreadInput(source),
    );
    const marker = parseMaintenanceMarker(body);
    let availability = normalizeMaintenanceAvailability(
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
    const issue: MaintenanceIssue = {
        number,
        nodeId,
        title,
        body,
        url,
        state,
        author,
        authorAssociation,
        labels,
        assignees,
        milestone,
        locked,
        createdAt,
        updatedAt,
        selectedThread,
        marker,
        isMaintenanceManaged: marker !== undefined,
        availability,
        skip,
    };
    return Object.freeze(issue);
};

export type MaintenanceRepository = {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly htmlUrl: string;
    /** The unmodified canonical `defaultBranch` value, including unknown shapes. */
    readonly rawDefaultBranch: unknown;
    /** A deep-frozen copy retaining every unknown input field. */
    readonly raw: Readonly<Record<string, unknown>>;
};

/** Canonical repository input: camelCase only. */
export type MaintenanceRepositoryInput = {
    readonly fullName?: unknown;
    readonly defaultBranch?: unknown;
    readonly htmlUrl?: unknown;
};

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

const cloneAndFreeze = <T>(
    value: T,
    seen = new WeakMap<object, unknown>(),
): T => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value) as T;
    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        seen.set(value, copy);
        for (const entry of value) copy.push(cloneAndFreeze(entry, seen));
        return Object.freeze(copy) as T;
    }
    const copy: RecordLike = {};
    seen.set(value, copy);
    for (const key of Object.keys(value))
        copy[key] = cloneAndFreeze((value as RecordLike)[key], seen);
    return Object.freeze(copy) as T;
};

const frozenRaw = (value: unknown): Readonly<Record<string, unknown>> =>
    isRecord(value)
        ? cloneAndFreeze(value)
        : Object.freeze({ value: cloneAndFreeze(value) });

export const createMaintenanceRepository = (
    value: MaintenanceRepositoryInput | unknown,
    repository = "",
): MaintenanceRepository => {
    const source = isRecord(value) ? value : {};
    // Canonical keys only. The reader translates REST snake_case before
    // calling this seam; direct REST records are not read here.
    const rawDefaultBranch = (source as RecordLike).defaultBranch;
    const defaultBranch = text(rawDefaultBranch);
    const fullName = text((source as RecordLike).fullName) || text(repository);
    const htmlUrl = text((source as RecordLike).htmlUrl);
    return Object.freeze({
        fullName,
        defaultBranch,
        htmlUrl,
        rawDefaultBranch: cloneAndFreeze(rawDefaultBranch),
        raw: frozenRaw(source),
    });
};