/**
 * Single REST translation boundary for the maintenance GitHub reader.
 *
 * All GitHub REST field variations are translated here, once, into canonical
 * maintenance inputs (`src/maintain/snapshot.ts`). Downstream construction
 * (`createMaintenance*`, `normalizeMaintenance*`) receives only canonical
 * camelCase values and never reads REST snake_case keys (`node_id`,
 * `html_url`, `author_association`, `created_at`, ...) or REST aliases
 * (`user` for `author`, `pull_request` presence is classified in `skips.ts`
 * before mapping). Unknown provider values, null authors, and malformed
 * shapes are passed through untouched so the canonical value layer can
 * preserve them as explicit unknown/unavailable evidence with its existing
 * fail-closed completeness behavior.
 */

import type {
    MaintenanceCommentInput,
    MaintenanceIssueInput,
    MaintenanceRepositoryInput,
} from "../snapshot.ts";

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const pick = (...candidates: ReadonlyArray<unknown>): unknown => {
    for (const candidate of candidates) {
        if (candidate !== undefined) return candidate;
    }
    return undefined;
};

/** Translate a REST repository record into a canonical repository input. */
export const maintenanceRepositoryInputFromRest = (
    value: unknown,
    repository: string,
): MaintenanceRepositoryInput => {
    const source = isRecord(value) ? value : {};
    return {
        fullName: pick(source.full_name, source.fullName, repository),
        defaultBranch: pick(source.default_branch, source.defaultBranch),
        htmlUrl: pick(source.html_url, source.htmlUrl),
    };
};

/** Translate a REST actor record (`user`, `assignee`) into canonical form. */
export const maintenanceActorInputFromRest = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (!isRecord(value)) return value;
    return {
        login: pick(value.login, value.name, value.username),
        type: pick(value.type, value.kind, value.actorType),
        nodeId: pick(value.node_id, value.nodeId),
    };
};

/** Translate a REST label record into canonical form (already canonical). */
export const maintenanceLabelInputFromRest = (value: unknown): unknown => value;

/** Translate a REST milestone record into canonical form. */
export const maintenanceMilestoneInputFromRest = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (!isRecord(value)) return value;
    return {
        number: value.number,
        nodeId: pick(value.node_id, value.nodeId),
        title: value.title,
        description: value.description,
        state: value.state,
        url: pick(value.html_url, value.htmlUrl, value.url),
        createdAt: pick(value.created_at, value.createdAt),
        updatedAt: pick(value.updated_at, value.updatedAt),
        dueOn: pick(value.due_on, value.dueOn),
    };
};

/** Translate a REST comment record into a canonical comment input. */
export const maintenanceCommentInputFromRest = (
    value: unknown,
): MaintenanceCommentInput => {
    const source = isRecord(value) ? value : {};
    return {
        id: pick(source.id, source.database_id, source.databaseId),
        nodeId: pick(source.node_id, source.nodeId),
        url: pick(source.html_url, source.htmlUrl, source.url),
        author: maintenanceActorInputFromRest(
            pick(source.user, source.author, null),
        ),
        authorAssociation: pick(
            source.author_association,
            source.authorAssociation,
        ),
        body: pick(source.body, source.content),
        content: pick(source.content, source.body),
        createdAt: pick(source.created_at, source.createdAt),
        updatedAt: pick(source.updated_at, source.updatedAt),
    };
};

/** Translate a REST issue-detail record into a canonical issue input. */
export const maintenanceIssueInputFromRest = (
    value: unknown,
    fallbackNumber: number,
): MaintenanceIssueInput => {
    const source = isRecord(value) ? value : {};
    const labels = Array.isArray(source.labels)
        ? source.labels.map(maintenanceLabelInputFromRest)
        : source.labels;
    const assignees = Array.isArray(source.assignees)
        ? source.assignees.map(maintenanceActorInputFromRest)
        : source.assignees;
    return {
        number: pick(source.number, fallbackNumber),
        nodeId: pick(source.node_id, source.nodeId),
        title: source.title,
        body: source.body,
        url: pick(source.html_url, source.htmlUrl, source.url),
        state: source.state,
        author: maintenanceActorInputFromRest(
            pick(source.user, source.author, null),
        ),
        authorAssociation: pick(
            source.author_association,
            source.authorAssociation,
        ),
        labels,
        assignees,
        milestone: maintenanceMilestoneInputFromRest(source.milestone ?? null),
        locked: source.locked,
        createdAt: pick(source.created_at, source.createdAt),
        updatedAt: pick(source.updated_at, source.updatedAt),
    };
};

/** Translate a REST issue-list record into canonical summary fields. */
export const maintenanceIssueSummaryInputFromRest = (
    value: unknown,
): {
    readonly number: unknown;
    readonly nodeId: unknown;
    readonly title: unknown;
    readonly url: unknown;
    readonly htmlUrl: unknown;
    readonly labels: unknown;
    readonly author: unknown;
    readonly createdAt: unknown;
    readonly updatedAt: unknown;
    readonly commentCount: unknown;
    readonly state: unknown;
} => {
    const source = isRecord(value) ? value : {};
    return {
        number: source.number,
        nodeId: pick(source.node_id, source.nodeId),
        title: source.title,
        url: pick(source.html_url, source.url),
        htmlUrl: pick(source.html_url, source.htmlUrl, source.url),
        labels: source.labels,
        author: maintenanceActorInputFromRest(
            pick(source.user, source.author, null),
        ),
        createdAt: pick(source.created_at, source.createdAt),
        updatedAt: pick(source.updated_at, source.updatedAt),
        commentCount: pick(source.comments, source.commentCount),
        state: source.state,
    };
};