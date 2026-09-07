/**
 * Canonical maintenance snapshot seam.
 *
 * A single typed snapshot vocabulary with one name per concept and one
 * construction function per value. This module is the preferred seam for new
 * callers; the compatibility surface in `src/maintain-issues-snapshot.ts`
 * remains supported and accepts the same canonical values.
 *
 * REST translation lives exactly once at the GitHub reader boundary
 * (`src/maintain/github-reader/translate.ts`), which maps provider records
 * into the canonical inputs below. These inputs use only canonical camelCase
 * keys: they never read REST snake_case keys (`node_id`, `html_url`,
 * `author_association`, `created_at`, ...) or REST aliases (`user` for
 * `author`). Unknown provider values, unavailable comment threads, bounded
 * evidence, and fail-closed completeness are preserved by the construction
 * functions, which delegate to the shared value layer.
 *
 * Canonical concepts covered here:
 * - repository (`MaintenanceRepository`)
 * - issue (`MaintenanceIssue`)
 * - comment thread (`MaintenanceCommentThread`, `MaintenanceComment`)
 * - availability (`MaintenanceAvailability`, `MaintenanceSkip`)
 * - unknown provider evidence (`MaintenanceUnknown`)
 *
 * Supporting actor, label, milestone, and marker values use the same single
 * names. There are no duplicate aliases in this module: each concept has
 * exactly one type name and one construction function.
 */

import {
    cloneMaintainableComment,
    cloneMaintainableIssue,
    cloneMaintainableThread,
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    createUnknownValue,
    isMaintainableUnknownValue,
    maintainableLabelNames,
    maintainMarker,
    normalizeMaintainableActor,
    normalizeMaintainableAuthorAssociation,
    normalizeMaintainableAvailability,
    normalizeMaintainableIssueState,
    normalizeMaintainableLabel,
    normalizeMaintainableMilestone,
    normalizeMaintainableSkip,
    normalizeMaintainableSkipReason,
    parseAllRalphieMarkers,
    parseRalphieMarker,
    isRalphieManaged,
    isMaintainableIssueOpen,
    type MaintainableActor,
    type MaintainableAuthorAssociation,
    type MaintainableAvailability,
    type MaintainableComment,
    type MaintainableIssue,
    type MaintainableLabel,
    type MaintainableMilestone,
    type MaintainableSelectedThread,
    type MaintainableSkip,
    type MaintainableUnknownValue,
    type RalphieMarker,
} from "../maintain-issues-snapshot.ts";

export type MaintenanceUnknown = MaintainableUnknownValue;
export type MaintenanceIssueState = MaintainableIssue["state"];
export type MaintenanceActor = MaintainableActor;
export type MaintenanceAuthorAssociation = MaintainableAuthorAssociation;
export type MaintenanceLabel = MaintainableLabel;
export type MaintenanceMilestone = MaintainableMilestone;
export type MaintenanceMarker = RalphieMarker;
export type MaintenanceAvailability = MaintainableAvailability;
export type MaintenanceSkip = MaintainableSkip;
export type MaintenanceSkipReason = MaintainableSkip["reason"];
export type MaintenanceComment = MaintainableComment;
export type MaintenanceCommentThread = MaintainableSelectedThread;
export type MaintenanceIssue = MaintainableIssue;

/** Canonical actor input: camelCase only. REST translation happens in the reader. */
export type MaintenanceActorInput = {
    readonly login?: unknown;
    readonly type?: unknown;
    readonly nodeId?: unknown;
};

/** Canonical label input. */
export type MaintenanceLabelInput = {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly color?: unknown;
};

/** Canonical milestone input: camelCase only. */
export type MaintenanceMilestoneInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly title?: unknown;
    readonly description?: unknown;
    readonly state?: unknown;
    readonly url?: unknown;
    readonly htmlUrl?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
    readonly dueOn?: unknown;
};

export type MaintenanceAvailabilityInput = {
    readonly kind?: unknown;
    readonly reason?: unknown;
    readonly detail?: unknown;
};

export type MaintenanceSkipInput = {
    readonly reason?: unknown;
    readonly detail?: unknown;
    readonly issueNumber?: unknown;
};

/** Canonical comment input: camelCase only. */
export type MaintenanceCommentInput = {
    readonly id?: unknown;
    readonly databaseId?: unknown;
    readonly nodeId?: unknown;
    readonly url?: unknown;
    readonly htmlUrl?: unknown;
    readonly author?: unknown;
    readonly authorAssociation?: unknown;
    readonly body?: unknown;
    readonly content?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
};

/** Canonical thread input: camelCase only, one thread name. */
export type MaintenanceCommentThreadInput = {
    readonly comments?: unknown;
    readonly fetchedCount?: unknown;
    readonly totalCount?: unknown;
    readonly complete?: unknown;
    readonly availability?: unknown;
};

/** Canonical issue input: camelCase only, one thread name (`selectedThread`). */
export type MaintenanceIssueInput = {
    readonly number?: unknown;
    readonly nodeId?: unknown;
    readonly title?: unknown;
    readonly body?: unknown;
    readonly url?: unknown;
    readonly htmlUrl?: unknown;
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

export type MaintenanceRepository = {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly htmlUrl: string;
    /** The unmodified REST `default_branch` value, including unknown shapes. */
    readonly rawDefaultBranch: unknown;
    /** A deep-frozen copy retaining every unknown REST response field. */
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

export const isMaintenanceUnknown = isMaintainableUnknownValue;

export const createMaintenanceUnknown = createUnknownValue;

export const normalizeMaintenanceIssueState = normalizeMaintainableIssueState;

export const isMaintenanceIssueOpen = isMaintainableIssueOpen;

export const normalizeMaintenanceActor = normalizeMaintainableActor;

export const normalizeMaintenanceAuthorAssociation =
    normalizeMaintainableAuthorAssociation;

export const normalizeMaintenanceLabel = normalizeMaintainableLabel;

export const maintenanceLabelNames = maintainableLabelNames;

export const normalizeMaintenanceMilestone = normalizeMaintainableMilestone;

export const renderMaintenanceMarker = maintainMarker;

export const parseMaintenanceMarker = parseRalphieMarker;

export const parseAllMaintenanceMarkers = parseAllRalphieMarkers;

export const isMaintenanceManaged = isRalphieManaged;

export const normalizeMaintenanceSkipReason = normalizeMaintainableSkipReason;

export const normalizeMaintenanceAvailability =
    normalizeMaintainableAvailability;

export const normalizeMaintenanceSkip = normalizeMaintainableSkip;

export const createMaintenanceComment = createMaintainableComment;

export const cloneMaintenanceComment = cloneMaintainableComment;

export const createMaintenanceCommentThread = createMaintainableThread;

export const cloneMaintenanceCommentThread = cloneMaintainableThread;

export const createMaintenanceIssue = createMaintainableIssue;

export const cloneMaintenanceIssue = cloneMaintainableIssue;

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