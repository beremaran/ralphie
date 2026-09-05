/**
 * Deterministic GitHub reconciliation for non-relationship maintenance
 * actions.
 *
 * This module is the mutation seam for maintenance. OpenCode supplies a validated
 * action, but it never receives this adapter or an Octokit client. Every
 * mutation is preceded by an authoritative read; a lost response is
 * reconciled by a fresh read and is never retried blindly. Managed comments
 * carry an issue-scoped, action-keyed marker whose body digest lets the
 * adapter distinguish an unchanged Ralphie comment from a human edit.
 */
import type { Octokit } from "octokit";
import { createHash } from "node:crypto";

import {
    issueMaintenanceActionSchema,
    maintenanceActionKey,
    type IssueMaintenanceAction,
} from "../maintain-issues-plan.ts";
import type { MaintenanceSnapshot } from "../maintain-issues-snapshot-service.ts";
import type { MaintainableComment } from "../maintain-issues-snapshot.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export const MAINTENANCE_ACTION_MARKER_VERSION = 1;
export const RALPHIE_MAINTENANCE_ACTION_MARKER = "ralphie:maintain-action";
export const MAINTENANCE_ACTION_MARKER_PREFIX =
    RALPHIE_MAINTENANCE_ACTION_MARKER;

export type MaintenanceCommentActionKind = "ask-question" | "answer-question";

export type MaintenanceActionMarker = {
    readonly version: typeof MAINTENANCE_ACTION_MARKER_VERSION;
    readonly issueNumber: number;
    readonly action: MaintenanceCommentActionKind;
    readonly actionKey: string;
    readonly bodySha256: string;
    /** The exact marker text, useful for audit and safe body matching. */
    readonly normalized: string;
};

const markerPattern =
    /<!-- ralphie:maintain-action version=1 issue=([1-9]\d*) action=(ask-question|answer-question) key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/g;
const markerLikePattern = /<!--\s*ralphie:maintain-action\b/gu;

const safePositiveInteger = (value: string): number | undefined => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

const parseMarkerMatch = (
    match: RegExpMatchArray,
): MaintenanceActionMarker | undefined => {
    const issueNumber = safePositiveInteger(match[1] ?? "");
    const action = match[2];
    const rawKey = match[3];
    const bodySha256 = match[4];
    if (
        issueNumber === undefined ||
        (action !== "ask-question" && action !== "answer-question") ||
        rawKey === undefined ||
        bodySha256 === undefined
    ) {
        return undefined;
    }
    let actionKey: unknown;
    try {
        actionKey = JSON.parse(rawKey);
    } catch {
        return undefined;
    }
    if (typeof actionKey !== "string" || actionKey.trim().length === 0) {
        return undefined;
    }
    return Object.freeze({
        version: MAINTENANCE_ACTION_MARKER_VERSION,
        issueNumber,
        action,
        actionKey,
        bodySha256,
        normalized: match[0],
    });
};

/** Parse every exact versioned maintenance action marker in a comment body. */
export const parseMaintenanceActionMarkers = (
    body: string | null | undefined,
): ReadonlyArray<MaintenanceActionMarker> => {
    if (typeof body !== "string" || body.length === 0) {
        return Object.freeze([]);
    }
    markerPattern.lastIndex = 0;
    const markers: MaintenanceActionMarker[] = [];
    for (const match of body.matchAll(markerPattern)) {
        const marker = parseMarkerMatch(match);
        if (marker !== undefined) markers.push(marker);
    }
    markerPattern.lastIndex = 0;
    return Object.freeze(markers);
};

export const parseAllMaintenanceActionMarkers = parseMaintenanceActionMarkers;
export const parseManagedMaintenanceMarkers = parseMaintenanceActionMarkers;

/**
 * Parse one marker only. A body with duplicate markers, a malformed marker,
 * or a marker embedded after other content is intentionally not accepted as
 * an owned managed comment.
 */
export const parseMaintenanceActionMarker = (
    body: string | null | undefined,
): MaintenanceActionMarker | undefined => {
    if (typeof body !== "string") return undefined;
    const markers = parseMaintenanceActionMarkers(body);
    const marker = markers[0];
    if (marker === undefined || markers.length !== 1) return undefined;
    return body.startsWith(marker.normalized) ? marker : undefined;
};

export const parseManagedMaintenanceMarker = parseMaintenanceActionMarker;

const bodySha256 = (body: string): string =>
    createHash("sha256").update(body, "utf8").digest("hex");

export const maintenanceActionBodySha256 = bodySha256;

export type MaintenanceActionMarkerInput = {
    readonly issueNumber: number;
    readonly action: MaintenanceCommentActionKind;
    readonly actionKey: string;
    readonly bodySha256: string;
};

/** Render the exact marker line used at the start of a managed comment. */
export const renderMaintenanceActionMarker = (
    input: MaintenanceActionMarkerInput,
): string => {
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
        throw new RalphieError({
            message: `Invalid maintenance marker issue number: ${String(input.issueNumber)}.`,
        });
    }
    if (input.actionKey.trim().length === 0) {
        throw new RalphieError({
            message: "A maintenance marker action key cannot be blank.",
        });
    }
    if (!/^[0-9a-f]{64}$/u.test(input.bodySha256)) {
        throw new RalphieError({
            message:
                "A maintenance marker body digest must be a SHA-256 hex value.",
        });
    }
    return `<!-- ${RALPHIE_MAINTENANCE_ACTION_MARKER} version=${String(MAINTENANCE_ACTION_MARKER_VERSION)} issue=${String(input.issueNumber)} action=${input.action} key=${JSON.stringify(input.actionKey)} body-sha256=${input.bodySha256} -->`;
};

export const maintenanceActionMarker = renderMaintenanceActionMarker;
export const managedMaintenanceActionMarker = renderMaintenanceActionMarker;

const contentAfterMarker = (
    body: string,
    marker: MaintenanceActionMarker,
): string | undefined => {
    if (!body.startsWith(marker.normalized)) return undefined;
    const suffix = body.slice(marker.normalized.length);
    return suffix.startsWith("\n") ? suffix.slice(1) : suffix;
};

/** Verify that a managed comment has not been edited after its marker. */
export const maintenanceActionMarkerOwnsBody = (
    body: string | null | undefined,
    marker: MaintenanceActionMarker,
): boolean => {
    if (typeof body !== "string") return false;
    const content = contentAfterMarker(body, marker);
    return content !== undefined && bodySha256(content) === marker.bodySha256;
};

export const isUnchangedMaintenanceManagedBody =
    maintenanceActionMarkerOwnsBody;

const normalizeComparableText = (value: string): string =>
    value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();

export const normalizeMaintenanceCommentText = normalizeComparableText;

const normalizedLabel = (value: string): string =>
    value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const recordValue = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;

const responseData = (value: unknown): unknown =>
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "data")
        ? value.data
        : undefined;

const statusOf = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const nested = isRecord(value.response) ? value.response.status : undefined;
    const status = nested ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const detailOf = (value: unknown): string => {
    if (value instanceof Error && value.message.length > 0) {
        return value.message;
    }
    if (isRecord(value) && typeof value.message === "string") {
        return value.message;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const requestOptions = (signal: AbortSignal | undefined): RecordLike =>
    signal === undefined ? {} : { request: { signal } };

const isAbortCause = (
    cause: unknown,
    signal: AbortSignal | undefined,
): boolean =>
    signal?.aborted === true ||
    (isRecord(cause) && cause.name === "AbortError");

const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (!signal?.aborted) return;
    throw (
        signal.reason ??
        Object.assign(new Error("maintenance reconciliation aborted"), {
            name: "AbortError",
        })
    );
};

type RecordLike = Record<string, unknown>;
type Endpoint = (parameters: RecordLike) => Promise<unknown>;

const endpointFor = (
    client: Octokit,
    namespace: string,
    name: string,
): Endpoint | undefined => {
    const rest = (client as unknown as RecordLike).rest;
    const group = isRecord(rest) ? rest[namespace] : undefined;
    const endpoint = isRecord(group) ? group[name] : undefined;
    return typeof endpoint === "function"
        ? (
              endpoint as (...args: ReadonlyArray<unknown>) => Promise<unknown>
          ).bind(group)
        : undefined;
};

const repositoryParameters = (
    repository: string,
): {
    readonly owner: string;
    readonly repo: string;
} => {
    const parsed = parseRepositorySlug(repository);
    return { owner: parsed.owner, repo: parsed.name };
};

const hasPullRequestShape = (value: RecordLike): boolean =>
    Object.prototype.hasOwnProperty.call(value, "pull_request");

const namesFrom = (value: unknown): ReadonlyArray<string> => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        const name = recordValue(entry, "name");
        return typeof name === "string" ? [name] : [];
    });
};

export type AdditiveLabelPlanStatus = "ready" | "unchanged" | "skipped";

export type AdditiveLabelPlan = {
    readonly status: AdditiveLabelPlanStatus;
    readonly requested: ReadonlyArray<string>;
    readonly exactCatalogLabels: ReadonlyArray<string>;
    readonly alreadyPresent: ReadonlyArray<string>;
    readonly toAdd: ReadonlyArray<string>;
    readonly missing: ReadonlyArray<string>;
    readonly reason?:
        | "label-not-in-catalog"
        | "label-not-additive"
        | "label-catalog-ambiguous"
        | "duplicate-label";
    readonly detail?: string;
};

export type AdditiveLabelPlanInput = {
    readonly requested: ReadonlyArray<string>;
    readonly current: ReadonlyArray<string>;
    readonly catalog: ReadonlyArray<string>;
};

const frozenStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
    Object.freeze([...values]);

const skippedLabelPlan = (
    input: AdditiveLabelPlanInput,
    reason: NonNullable<AdditiveLabelPlan["reason"]>,
    detail: string,
    missing: ReadonlyArray<string> = [],
): AdditiveLabelPlan =>
    Object.freeze({
        status: "skipped" as const,
        requested: frozenStrings(input.requested),
        exactCatalogLabels: Object.freeze([]),
        alreadyPresent: Object.freeze([]),
        toAdd: Object.freeze([]),
        missing: frozenStrings(missing),
        reason,
        detail,
    });

/**
 * Compute an additive-only label mutation without touching GitHub. Catalog
 * spelling is authoritative, existing labels are case-insensitively removed,
 * and any missing/ambiguous catalog entry fails the whole action closed.
 */
export const planAdditiveLabels = (
    input: AdditiveLabelPlanInput,
): AdditiveLabelPlan => {
    const requested = input.requested.map((label) => label.trim());
    const requestedFailure = validateRequestedLabels(input, requested);
    if (requestedFailure !== undefined) return requestedFailure;
    const catalogResult = catalogByName(input);
    if (catalogResult.status === "skipped") return catalogResult.plan;
    const exactCatalogLabels = requested.map(
        (label) => catalogResult.catalog.get(normalizedLabel(label)) ?? "",
    );
    const missing = requested.filter(
        (label) => !catalogResult.catalog.has(normalizedLabel(label)),
    );
    if (missing.length > 0) {
        return skippedLabelPlan(
            input,
            "label-not-in-catalog",
            `requested labels are absent from the repository catalog: ${missing.join(", ")}`,
            missing,
        );
    }

    const currentNames = new Set(
        input.current.map(normalizedLabel).filter((label) => label.length > 0),
    );
    const alreadyPresent = exactCatalogLabels.filter((label) =>
        currentNames.has(normalizedLabel(label)),
    );
    const toAdd = exactCatalogLabels.filter(
        (label) => !currentNames.has(normalizedLabel(label)),
    );
    return Object.freeze({
        status:
            toAdd.length === 0 ? ("unchanged" as const) : ("ready" as const),
        requested: frozenStrings(requested),
        exactCatalogLabels: frozenStrings(exactCatalogLabels),
        alreadyPresent: frozenStrings(alreadyPresent),
        toAdd: frozenStrings(toAdd),
        missing: Object.freeze([]),
    });
};

const validateRequestedLabels = (
    input: AdditiveLabelPlanInput,
    requested: ReadonlyArray<string>,
): AdditiveLabelPlan | undefined => {
    const seenRequested = new Set<string>();
    for (const label of requested) {
        if (label.length === 0) {
            return skippedLabelPlan(
                input,
                "label-not-additive",
                "an additive label cannot be blank",
            );
        }
        if (label.startsWith("-")) {
            return skippedLabelPlan(
                input,
                "label-not-additive",
                `label ${JSON.stringify(label)} requests removal`,
            );
        }
        const normalized = normalizedLabel(label);
        if (seenRequested.has(normalized)) {
            return skippedLabelPlan(
                input,
                "duplicate-label",
                `label ${JSON.stringify(label)} is duplicated case-insensitively`,
            );
        }
        seenRequested.add(normalized);
    }
    return undefined;
};

type CatalogResult =
    | { readonly status: "ok"; readonly catalog: ReadonlyMap<string, string> }
    | { readonly status: "skipped"; readonly plan: AdditiveLabelPlan };

const catalogByName = (input: AdditiveLabelPlanInput): CatalogResult => {
    const catalogByName = new Map<string, string>();
    for (const rawLabel of input.catalog) {
        const label = rawLabel.trim();
        const normalized = normalizedLabel(label);
        if (normalized.length === 0) continue;
        const previous = catalogByName.get(normalized);
        if (previous !== undefined && previous !== label) {
            return {
                status: "skipped",
                plan: skippedLabelPlan(
                    input,
                    "label-catalog-ambiguous",
                    `catalog contains two spellings for ${JSON.stringify(label)}`,
                ),
            };
        }
        catalogByName.set(normalized, label);
    }
    return { status: "ok", catalog: catalogByName };
};

export const reconcileAdditiveLabels = planAdditiveLabels;
export const additiveLabelPlan = planAdditiveLabels;

const questionContent = (question: string, rationale: string): string =>
    [
        "### Ralphie clarification question",
        "",
        question,
        "",
        `Rationale: ${rationale}`,
    ].join("\n");

const answerContent = (
    answer: string,
    rationale: string,
    commentId: number,
    sourceUrl: string,
    sourceFingerprint: string,
): string =>
    [
        "### Ralphie grounded answer",
        "",
        answer,
        "",
        `Source comment #${String(commentId)}: ${sourceUrl}`,
        `Snapshot fingerprint: ${sourceFingerprint}`,
        `Rationale: ${rationale}`,
    ].join("\n");

export const renderMaintenanceQuestionContent = questionContent;
export const renderMaintenanceAnswerContent = answerContent;

export type RenderMaintenanceCommentInput =
    | {
          readonly action: Extract<
              IssueMaintenanceAction,
              { readonly action: "ask-question" }
          >;
          readonly actionKey?: string;
      }
    | {
          readonly action: Extract<
              IssueMaintenanceAction,
              { readonly action: "answer-question" }
          >;
          readonly actionKey?: string;
      };

/** Render a complete managed question/answer body with its digest marker. */
export const renderMaintenanceActionComment = (
    input: RenderMaintenanceCommentInput,
): string => {
    const actionKey = input.actionKey ?? maintenanceActionKey(input.action);
    const content =
        input.action.action === "ask-question"
            ? questionContent(input.action.question, input.action.rationale)
            : answerContent(
                  input.action.answer,
                  input.action.rationale,
                  input.action.commentId,
                  input.action.sourceUrl,
                  input.action.sourceFingerprint,
              );
    const marker = renderMaintenanceActionMarker({
        issueNumber: input.action.issueNumber,
        action: input.action.action,
        actionKey,
        bodySha256: bodySha256(content),
    });
    return `${marker}\n${content}`;
};

export const renderManagedMaintenanceComment = renderMaintenanceActionComment;

const contentForMarker = (
    body: string | null,
    marker: MaintenanceActionMarker | undefined,
): string => {
    if (body === null) return "";
    if (marker === undefined) return body;
    return contentAfterMarker(body, marker) ?? body;
};

const questionFromBody = (body: string | null): string | undefined => {
    if (body === null) return undefined;
    const marker = parseMaintenanceActionMarker(body);
    const content = contentForMarker(body, marker);
    const prefix = "### Ralphie clarification question\n\n";
    if (content.startsWith(prefix)) {
        return content
            .slice(prefix.length)
            .split("\n\nRationale:", 1)[0]
            ?.trim();
    }
    return content.trim().length === 0 ? undefined : content.trim();
};

const answerFromBody = (body: string | null): string | undefined => {
    if (body === null) return undefined;
    const marker = parseMaintenanceActionMarker(body);
    const content = contentForMarker(body, marker);
    const prefix = "### Ralphie grounded answer\n\n";
    if (!content.startsWith(prefix)) return undefined;
    return content
        .slice(prefix.length)
        .split("\n\nSource comment #", 1)[0]
        ?.trim();
};

type LiveComment = {
    readonly id: number;
    readonly body: string | null;
    readonly url: string;
    readonly authorLogin: string | undefined;
    readonly createdAt: string;
    readonly raw: RecordLike;
};

const liveCommentFrom = (value: unknown): LiveComment | undefined => {
    if (!isRecord(value)) return undefined;
    const id = value.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        return undefined;
    }
    const rawUser = value.user ?? value.author;
    const authorLogin =
        typeof rawUser === "string"
            ? rawUser.trim() || undefined
            : text(recordValue(rawUser, "login")).trim() || undefined;
    return {
        id,
        body: typeof value.body === "string" ? value.body : null,
        url: text(value.html_url ?? value.htmlUrl ?? value.url),
        authorLogin,
        createdAt: text(value.created_at ?? value.createdAt),
        raw: value,
    };
};

const compareLiveComments = (left: LiveComment, right: LiveComment): number =>
    left.createdAt.localeCompare(right.createdAt) || left.id - right.id;

type LiveIssue = {
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "closed";
    readonly locked: boolean;
    readonly labels: ReadonlyArray<string>;
    readonly permissions: RecordLike | undefined;
    readonly raw: RecordLike;
};

type ReadIssueResult =
    | { readonly status: "ok"; readonly issue: LiveIssue }
    | {
          readonly status: "skipped";
          readonly reason:
              | "issue-missing"
              | "issue-inaccessible"
              | "issue-closed"
              | "not-an-issue";
          readonly detail: string;
      }
    | { readonly status: "recovery-required"; readonly detail: string };

const issueReadError = (
    cause: unknown,
    issueNumber: number,
): ReadIssueResult => {
    const status = statusOf(cause);
    if (status === 404) {
        return {
            status: "skipped",
            reason: "issue-missing",
            detail: `issue #${String(issueNumber)} is not present in the live repository`,
        };
    }
    if (status === 401 || status === 403) {
        return {
            status: "skipped",
            reason: "issue-inaccessible",
            detail: `issue #${String(issueNumber)} is inaccessible to the authenticated GitHub actor`,
        };
    }
    return {
        status: "recovery-required",
        detail: `live issue read failed: ${detailOf(cause)}`,
    };
};

const liveIssueFrom = (data: unknown, issueNumber: number): ReadIssueResult => {
    if (!isRecord(data)) {
        return {
            status: "recovery-required",
            detail: "GitHub returned no issue object for live reconciliation.",
        };
    }
    if (hasPullRequestShape(data)) {
        return {
            status: "skipped",
            reason: "not-an-issue",
            detail: `#${String(issueNumber)} is a pull request, not an issue`,
        };
    }
    const number = data.number;
    if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number !== issueNumber
    ) {
        return {
            status: "recovery-required",
            detail: `GitHub returned an issue identity that does not match #${String(issueNumber)}`,
        };
    }
    if (data.state === "closed") {
        return {
            status: "skipped",
            reason: "issue-closed",
            detail: `issue #${String(issueNumber)} is closed in the live repository`,
        };
    }
    if (data.state !== "open") {
        return {
            status: "recovery-required",
            detail: `GitHub returned unsupported state ${JSON.stringify(data.state)} for issue #${String(issueNumber)}`,
        };
    }
    return {
        status: "ok",
        issue: {
            number,
            url: text(data.html_url ?? data.htmlUrl ?? data.url),
            state: "open",
            locked: data.locked === true,
            labels: namesFrom(data.labels),
            permissions: isRecord(data.permissions)
                ? data.permissions
                : undefined,
            raw: data,
        },
    };
};

const readIssue = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    signal: AbortSignal | undefined,
): Promise<ReadIssueResult> => {
    const endpoint = endpointFor(client, "issues", "get");
    if (endpoint === undefined) {
        return {
            status: "recovery-required",
            detail: "GitHub issues.get is unavailable for live reconciliation.",
        };
    }
    try {
        const response = await endpoint({
            ...repositoryParameters(repository),
            issue_number: issueNumber,
            ...requestOptions(signal),
        });
        return liveIssueFrom(responseData(response), issueNumber);
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return issueReadError(cause, issueNumber);
    }
};

type ReadCommentsResult =
    | { readonly status: "ok"; readonly comments: ReadonlyArray<LiveComment> }
    | { readonly status: "recovery-required"; readonly detail: string };

const readComments = async (
    client: Octokit,
    repository: string,
    issueNumber: number,
    signal: AbortSignal | undefined,
): Promise<ReadCommentsResult> => {
    const endpoint = endpointFor(client, "issues", "listComments");
    if (endpoint === undefined) {
        return {
            status: "recovery-required",
            detail: "GitHub issues.listComments is unavailable for marker discovery.",
        };
    }
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
        per_page: 100,
        ...requestOptions(signal),
    };
    let data: unknown;
    try {
        const pagination = (
            client as unknown as {
                readonly paginate?: (
                    method: unknown,
                    parameters: RecordLike,
                ) => Promise<unknown>;
            }
        ).paginate;
        data =
            pagination === undefined
                ? responseData(await endpoint(parameters))
                : await pagination(endpoint, parameters);
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "recovery-required",
            detail: `live comment discovery failed: ${detailOf(cause)}`,
        };
    }
    if (!Array.isArray(data)) {
        return {
            status: "recovery-required",
            detail: "GitHub returned a non-array comment collection.",
        };
    }
    const comments = data
        .map(liveCommentFrom)
        .filter((comment): comment is LiveComment => comment !== undefined)
        .sort(compareLiveComments);
    return { status: "ok", comments: Object.freeze(comments) };
};

type ActorResult =
    | { readonly status: "ok"; readonly login: string }
    | { readonly status: "skipped"; readonly detail: string };

const authenticatedActor = async (
    client: Octokit,
    signal: AbortSignal | undefined,
): Promise<ActorResult> => {
    const endpoint = endpointFor(client, "users", "getAuthenticated");
    if (endpoint === undefined) {
        return {
            status: "skipped",
            detail: "GitHub users.getAuthenticated is unavailable; ownership cannot be confirmed.",
        };
    }
    try {
        const response = await endpoint({ ...requestOptions(signal) });
        const login = text(recordValue(responseData(response), "login")).trim();
        return login.length === 0
            ? {
                  status: "skipped",
                  detail: "GitHub did not return an authenticated actor login.",
              }
            : { status: "ok", login };
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "skipped",
            detail: `authenticated actor lookup failed: ${detailOf(cause)}`,
        };
    }
};

const sameActor = (left: string | undefined, right: string): boolean =>
    left !== undefined &&
    normalizedLabel(left) === normalizedLabel(right) &&
    left.trim().length > 0;

export type LockedCommentPermissionInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly issueNumber: number;
    readonly actorLogin: string;
    readonly issue: RecordLike;
};

export type LockedCommentPermissionChecker = (
    input: LockedCommentPermissionInput,
) => Promise<boolean>;

const permissionGranted = (value: RecordLike | undefined): boolean =>
    value?.admin === true ||
    value?.maintain === true ||
    value?.push === true ||
    value?.triage === true;

const runLockedPermissionChecker = async (
    checker: LockedCommentPermissionChecker,
    input: LockedCommentPermissionInput,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    try {
        return await checker(input);
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return undefined;
    }
};

const readRepositoryPermissions = async (
    client: Octokit,
    repository: string,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    const endpoint = endpointFor(client, "repos", "get");
    if (endpoint === undefined) return undefined;
    try {
        const response = await endpoint({
            ...repositoryParameters(repository),
            ...requestOptions(signal),
        });
        const permissions = recordValue(responseData(response), "permissions");
        return isRecord(permissions)
            ? permissionGranted(permissions)
            : undefined;
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return undefined;
    }
};

const canCommentOnLockedIssue = async (
    client: Octokit,
    repository: string,
    issue: LiveIssue,
    actorLogin: string,
    checker: LockedCommentPermissionChecker | undefined,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    if (!issue.locked) return true;
    if (checker !== undefined) {
        return runLockedPermissionChecker(
            checker,
            {
                client,
                repository,
                issueNumber: issue.number,
                actorLogin,
                issue: issue.raw,
            },
            signal,
        );
    }
    if (permissionGranted(issue.permissions)) return true;
    return readRepositoryPermissions(client, repository, signal);
};

const snapshotComment = (
    snapshot: MaintenanceSnapshot | undefined,
    commentId: number,
): MaintainableComment | undefined => {
    if (snapshot === undefined) return undefined;
    const selected = [
        ...snapshot.selectedIssues.flatMap((issue) =>
            issue.selectedThread.comments.filter(
                (comment) => comment.id === commentId,
            ),
        ),
        ...snapshot.selectedDetails.flatMap((detail) =>
            detail.thread.comments.filter(
                (comment) => comment.id === commentId,
            ),
        ),
    ];
    return selected[0];
};

export type MaintenanceMutationSkipReason =
    | "invalid-action"
    | "invalid-repository"
    | "unsupported-action"
    | "stale-fingerprint"
    | "issue-missing"
    | "issue-inaccessible"
    | "issue-closed"
    | "not-an-issue"
    | "locked-comment-permission-unknown"
    | "locked-comment-not-permitted"
    | "authenticated-actor-unavailable"
    | "label-not-in-catalog"
    | "label-not-additive"
    | "label-catalog-ambiguous"
    | "duplicate-label"
    | "comment-missing"
    | "comment-ambiguous"
    | "comment-url-mismatch"
    | "source-issue-mismatch"
    | "stale-answer"
    | "self-reply"
    | "marker-malformed"
    | "duplicate-marker"
    | "foreign-marker"
    | "marker-conflict"
    | "managed-comment-ownership"
    | "human-edited-managed-comment"
    | "already-answered"
    | "equivalent-question"
    | "planner-skip";

export type MaintenanceMutationBase = {
    readonly actionKey: string;
    readonly issueNumber: number;
};

export type MaintenanceMutationResult =
    | (MaintenanceMutationBase & {
          readonly status: "applied";
          readonly mutation:
              | "labels-added"
              | "comment-created"
              | "comment-updated";
          readonly changed: true;
          readonly detail: string;
          readonly labels?: ReadonlyArray<string>;
          readonly commentId?: number;
      })
    | (MaintenanceMutationBase & {
          readonly status: "unchanged";
          readonly mutation: "none";
          readonly changed: false;
          readonly detail: string;
          readonly commentId?: number;
          readonly labels?: ReadonlyArray<string>;
      })
    | (MaintenanceMutationBase & {
          readonly status: "skipped";
          readonly reason: MaintenanceMutationSkipReason;
          readonly detail: string;
          readonly changed: false;
      })
    | (MaintenanceMutationBase & {
          readonly status: "recovery-required";
          readonly operation:
              | "add-labels"
              | "create-comment"
              | "update-comment";
          readonly detail: string;
          readonly changed: false;
      });

export type IssueMaintenanceMutationResult = MaintenanceMutationResult;
export type MaintenanceMutationOutcome = MaintenanceMutationResult;

const freezeResult = <Result extends MaintenanceMutationResult>(
    result: Result,
): Result => Object.freeze(result);

const skipped = (
    actionKey: string,
    issueNumber: number,
    reason: MaintenanceMutationSkipReason,
    detail: string,
): MaintenanceMutationResult =>
    freezeResult({
        actionKey,
        issueNumber,
        status: "skipped",
        reason,
        detail,
        changed: false,
    });

const recovered = (
    actionKey: string,
    issueNumber: number,
    operation: "add-labels" | "create-comment" | "update-comment",
    detail: string,
): MaintenanceMutationResult =>
    freezeResult({
        actionKey,
        issueNumber,
        status: "recovery-required",
        operation,
        detail,
        changed: false,
    });

const applied = (
    actionKey: string,
    issueNumber: number,
    mutation: "labels-added" | "comment-created" | "comment-updated",
    detail: string,
    extra: {
        readonly labels?: ReadonlyArray<string>;
        readonly commentId?: number;
    } = {},
): MaintenanceMutationResult =>
    freezeResult({
        actionKey,
        issueNumber,
        status: "applied",
        mutation,
        changed: true,
        detail,
        ...(extra.labels === undefined
            ? {}
            : { labels: Object.freeze([...extra.labels]) }),
        ...(extra.commentId === undefined
            ? {}
            : { commentId: extra.commentId }),
    });

const unchanged = (
    actionKey: string,
    issueNumber: number,
    detail: string,
    extra: {
        readonly labels?: ReadonlyArray<string>;
        readonly commentId?: number;
    } = {},
): MaintenanceMutationResult =>
    freezeResult({
        actionKey,
        issueNumber,
        status: "unchanged",
        mutation: "none",
        changed: false,
        detail,
        ...(extra.labels === undefined
            ? {}
            : { labels: Object.freeze([...extra.labels]) }),
        ...(extra.commentId === undefined
            ? {}
            : { commentId: extra.commentId }),
    });

type ActionWithKey = IssueMaintenanceAction & { readonly actionKey: string };
type AskQuestionAction = Extract<
    IssueMaintenanceAction,
    { readonly action: "ask-question" }
>;
type AnswerQuestionAction = Extract<
    IssueMaintenanceAction,
    { readonly action: "answer-question" }
>;
type AddLabelsAction = Extract<
    IssueMaintenanceAction,
    { readonly action: "add-labels" }
>;

const actionWithKey = (action: IssueMaintenanceAction): ActionWithKey => ({
    ...action,
    actionKey: maintenanceActionKey(action),
});

const validateAction = (
    value: unknown,
):
    | { readonly status: "ok"; readonly action: ActionWithKey }
    | { readonly status: "invalid"; readonly detail: string } => {
    const parsed = issueMaintenanceActionSchema.safeParse(value);
    if (!parsed.success) {
        return {
            status: "invalid",
            detail: "maintenance action failed schema validation",
        };
    }
    return { status: "ok", action: actionWithKey(parsed.data) };
};

export type MaintenanceMutationRequest = {
    readonly action: IssueMaintenanceAction;
    /** The immutable plan/snapshot fingerprint expected by the caller. */
    readonly snapshotFingerprint?: string;
    readonly snapshot?: MaintenanceSnapshot;
    /** Optional live issue URL from the validated snapshot. */
    readonly expectedIssueUrl?: string;
    /** Test/replay seam; production resolves the authenticated GitHub actor. */
    readonly authenticatedActorLogin?: string;
    readonly confirmLockedCommentPermission?: LockedCommentPermissionChecker;
    /** Alias retained for callers that phrase the seam as a capability check. */
    readonly canCommentOnLockedIssue?: LockedCommentPermissionChecker;
    readonly signal?: AbortSignal;
};

export type IssueMaintenanceMutationRequest = MaintenanceMutationRequest;

const readLabelsCatalog = async (
    client: Octokit,
    repository: string,
    signal: AbortSignal | undefined,
): Promise<
    | { readonly status: "ok"; readonly labels: ReadonlyArray<string> }
    | { readonly status: "recovery-required"; readonly detail: string }
> => {
    const endpoint = endpointFor(client, "issues", "listLabelsForRepo");
    if (endpoint === undefined) {
        return {
            status: "recovery-required",
            detail: "GitHub issues.listLabelsForRepo is unavailable for catalog reconciliation.",
        };
    }
    const parameters = {
        ...repositoryParameters(repository),
        per_page: 100,
        ...requestOptions(signal),
    };
    let data: unknown;
    try {
        const pagination = (
            client as unknown as {
                readonly paginate?: (
                    method: unknown,
                    parameters: RecordLike,
                ) => Promise<unknown>;
            }
        ).paginate;
        data =
            pagination === undefined
                ? responseData(await endpoint(parameters))
                : await pagination(endpoint, parameters);
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "recovery-required",
            detail: `label catalog discovery failed: ${detailOf(cause)}`,
        };
    }
    return Array.isArray(data)
        ? { status: "ok", labels: Object.freeze(namesFrom(data)) }
        : {
              status: "recovery-required",
              detail: "GitHub returned a non-array label catalog.",
          };
};

type MarkerDiscovery = {
    readonly matching: ReadonlyArray<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceActionMarker;
    }>;
    readonly malformed: ReadonlyArray<LiveComment>;
    readonly foreign: ReadonlyArray<LiveComment>;
};

type MarkerClassification =
    | { readonly kind: "none" }
    | { readonly kind: "malformed" }
    | { readonly kind: "foreign" }
    | { readonly kind: "matching"; readonly marker: MaintenanceActionMarker };

const classifyMarker = (
    comment: LiveComment,
    issueNumber: number,
    action: MaintenanceCommentActionKind,
    actionKey: string,
): MarkerClassification => {
    if (comment.body === null) return { kind: "none" };
    const markers = parseMaintenanceActionMarkers(comment.body);
    markerLikePattern.lastIndex = 0;
    const markerLikeMatches = [...comment.body.matchAll(markerLikePattern)];
    markerLikePattern.lastIndex = 0;
    if (markers.length === 0) {
        return markerLikeMatches.length > 0
            ? { kind: "malformed" }
            : { kind: "none" };
    }
    if (
        markerLikeMatches.length !== markers.length ||
        markers.length !== 1 ||
        !comment.body.startsWith(markers[0]?.normalized ?? "")
    ) {
        return { kind: "malformed" };
    }
    const marker = markers[0] as MaintenanceActionMarker;
    return marker.issueNumber === issueNumber &&
        marker.action === action &&
        marker.actionKey === actionKey
        ? { kind: "matching", marker }
        : { kind: "foreign" };
};

const discoverMarkers = (
    comments: ReadonlyArray<LiveComment>,
    issueNumber: number,
    action: MaintenanceCommentActionKind,
    actionKey: string,
): MarkerDiscovery => {
    const matching: Array<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceActionMarker;
    }> = [];
    const malformed: LiveComment[] = [];
    const foreign: LiveComment[] = [];
    for (const comment of comments) {
        const classification = classifyMarker(
            comment,
            issueNumber,
            action,
            actionKey,
        );
        switch (classification.kind) {
            case "matching":
                matching.push({ comment, marker: classification.marker });
                break;
            case "malformed":
                malformed.push(comment);
                break;
            case "foreign":
                foreign.push(comment);
                break;
            case "none":
                break;
        }
    }
    return {
        matching: Object.freeze(matching),
        malformed: Object.freeze(malformed),
        foreign: Object.freeze(foreign),
    };
};

const sourceSnapshotIsCurrent = (
    snapshot: MaintenanceSnapshot | undefined,
    source: LiveComment,
): boolean => {
    const captured = snapshotComment(snapshot, source.id);
    if (captured === undefined) return false;
    return captured.url === source.url && captured.body === source.body;
};

const commentMutationReconciliation = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issueNumber: number;
    readonly action: MaintenanceCommentActionKind;
    readonly actionKey: string;
    readonly desiredBody: string;
    readonly operation: "create-comment" | "update-comment";
    readonly actorLogin: string;
    readonly signal?: AbortSignal;
}): Promise<MaintenanceMutationResult> => {
    const discovered = await readComments(
        input.client,
        input.repository,
        input.issueNumber,
        input.signal,
    );
    if (discovered.status !== "ok") {
        return recovered(
            input.actionKey,
            input.issueNumber,
            input.operation,
            `${input.operation} response was uncertain and ${discovered.detail}`,
        );
    }
    const markers = discoverMarkers(
        discovered.comments,
        input.issueNumber,
        input.action,
        input.actionKey,
    );
    if (markers.matching.length !== 1) {
        return recovered(
            input.actionKey,
            input.issueNumber,
            input.operation,
            markers.matching.length === 0
                ? `${input.operation} response was uncertain; no matching managed marker was found`
                : `${input.operation} response was uncertain; ${String(markers.matching.length)} matching managed markers were found`,
        );
    }
    const match = markers.matching[0] as (typeof markers.matching)[number];
    if (!sameActor(match.comment.authorLogin, input.actorLogin)) {
        return recovered(
            input.actionKey,
            input.issueNumber,
            input.operation,
            `${input.operation} response was uncertain; the matching marker is not owned by the authenticated actor`,
        );
    }
    if (!maintenanceActionMarkerOwnsBody(match.comment.body, match.marker)) {
        return recovered(
            input.actionKey,
            input.issueNumber,
            input.operation,
            `${input.operation} response was uncertain; the matching managed comment was edited`,
        );
    }
    if (match.comment.body === input.desiredBody) {
        return applied(
            input.actionKey,
            input.issueNumber,
            input.operation === "create-comment"
                ? "comment-created"
                : "comment-updated",
            `${input.operation} was confirmed by the matching marker`,
            { commentId: match.comment.id },
        );
    }
    return recovered(
        input.actionKey,
        input.issueNumber,
        input.operation,
        `${input.operation} response was uncertain; the matching marker has a different body`,
    );
};

const issueReadResult = (
    result: ReadIssueResult,
    actionKey: string,
    issueNumber: number,
    operation: "add-labels" | "create-comment",
): MaintenanceMutationResult | undefined =>
    result.status === "ok"
        ? undefined
        : result.status === "skipped"
          ? skipped(actionKey, issueNumber, result.reason, result.detail)
          : recovered(actionKey, issueNumber, operation, result.detail);

const actorFor = async (
    client: Octokit,
    input: MaintenanceMutationRequest,
): Promise<ActorResult> =>
    input.authenticatedActorLogin?.trim()
        ? { status: "ok", login: input.authenticatedActorLogin.trim() }
        : await authenticatedActor(client, input.signal);

const validateFingerprint = (
    action: IssueMaintenanceAction,
    input: MaintenanceMutationRequest,
): string | undefined => {
    const snapshotFingerprint = input.snapshot?.fingerprint;
    const expected = input.snapshotFingerprint ?? snapshotFingerprint;
    const sourceFingerprint =
        "sourceFingerprint" in action ? action.sourceFingerprint : undefined;
    if (
        input.snapshotFingerprint !== undefined &&
        snapshotFingerprint !== undefined &&
        input.snapshotFingerprint !== snapshotFingerprint
    ) {
        return "the request fingerprint does not match the supplied immutable snapshot";
    }
    if (action.action === "answer-question" && input.snapshot === undefined) {
        return "grounded answers require the immutable snapshot used to cite their source comment";
    }
    if (action.action === "answer-question" && expected === undefined) {
        return "grounded answers require an expected immutable snapshot fingerprint";
    }
    if (
        expected !== undefined &&
        sourceFingerprint !== undefined &&
        expected !== sourceFingerprint
    ) {
        return "the action source fingerprint does not match the expected immutable snapshot fingerprint";
    }
    return undefined;
};

const validateRepository = (
    repository: string,
):
    | { readonly valid: true }
    | { readonly valid: false; readonly detail: string } => {
    try {
        repositoryParameters(repository);
        return { valid: true };
    } catch (cause) {
        return {
            valid: false,
            detail: `invalid GitHub repository: ${detailOf(cause)}`,
        };
    }
};

const matchIssueUrl = (
    issue: LiveIssue,
    expectedIssueUrl: string | undefined,
): string | undefined =>
    expectedIssueUrl !== undefined && issue.url !== expectedIssueUrl
        ? "live issue URL no longer matches the validated snapshot"
        : undefined;

const labelsContainAll = (
    current: ReadonlyArray<string>,
    expected: ReadonlyArray<string>,
): boolean => {
    const normalizedCurrent = new Set(current.map(normalizedLabel));
    return expected.every((label) =>
        normalizedCurrent.has(normalizedLabel(label)),
    );
};

const labelPlanSkipResult = (
    actionKey: string,
    issueNumber: number,
    labelPlan: AdditiveLabelPlan,
): MaintenanceMutationResult => {
    const reason = labelPlan.reason;
    return skipped(
        actionKey,
        issueNumber,
        reason === "label-catalog-ambiguous"
            ? "label-catalog-ambiguous"
            : reason === "duplicate-label"
              ? "duplicate-label"
              : reason === "label-not-additive"
                ? "label-not-additive"
                : "label-not-in-catalog",
        labelPlan.detail ?? "additive label plan was skipped",
    );
};

const responseContainsLabels = (
    response: unknown,
    expected: ReadonlyArray<string>,
): boolean => {
    const returned = responseData(response);
    const responseLabels = namesFrom(recordValue(returned, "labels"));
    return (
        responseLabels.length > 0 && labelsContainAll(responseLabels, expected)
    );
};

const reconcileUncertainLabels = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: AddLabelsAction;
    readonly actionKey: string;
    readonly labels: ReadonlyArray<string>;
    readonly detail: string;
    readonly signal?: AbortSignal;
}): Promise<MaintenanceMutationResult> => {
    const reconciled = await readIssue(
        input.client,
        input.repository,
        input.action.issueNumber,
        input.signal,
    );
    if (
        reconciled.status === "ok" &&
        labelsContainAll(reconciled.issue.labels, input.labels)
    ) {
        return applied(
            input.actionKey,
            input.action.issueNumber,
            "labels-added",
            "label mutation was confirmed by an authoritative refetch",
            { labels: input.labels },
        );
    }
    return recovered(
        input.actionKey,
        input.action.issueNumber,
        "add-labels",
        input.detail,
    );
};

const reconcileLabels = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: AddLabelsAction;
    readonly actionKey: string;
    readonly expectedIssueUrl?: string;
    readonly signal?: AbortSignal;
}): Promise<MaintenanceMutationResult> => {
    const issueResult = await readIssue(
        input.client,
        input.repository,
        input.action.issueNumber,
        input.signal,
    );
    const issueFailure = issueReadResult(
        issueResult,
        input.actionKey,
        input.action.issueNumber,
        "add-labels",
    );
    if (issueFailure !== undefined) return issueFailure;
    const issue = (issueResult as Extract<ReadIssueResult, { status: "ok" }>)
        .issue;
    const urlFailure = matchIssueUrl(issue, input.expectedIssueUrl);
    if (urlFailure !== undefined) {
        return skipped(
            input.actionKey,
            input.action.issueNumber,
            "stale-fingerprint",
            urlFailure,
        );
    }
    const catalogResult = await readLabelsCatalog(
        input.client,
        input.repository,
        input.signal,
    );
    if (catalogResult.status !== "ok") {
        return recovered(
            input.actionKey,
            input.action.issueNumber,
            "add-labels",
            catalogResult.detail,
        );
    }
    const labelPlan = planAdditiveLabels({
        requested: input.action.labels,
        current: issue.labels,
        catalog: catalogResult.labels,
    });
    if (labelPlan.status === "skipped") {
        return labelPlanSkipResult(
            input.actionKey,
            input.action.issueNumber,
            labelPlan,
        );
    }
    if (labelPlan.status === "unchanged") {
        return unchanged(
            input.actionKey,
            input.action.issueNumber,
            "all requested labels are already present with catalog spelling",
            { labels: labelPlan.exactCatalogLabels },
        );
    }
    const endpoint = endpointFor(input.client, "issues", "addLabels");
    if (endpoint === undefined) {
        return recovered(
            input.actionKey,
            input.action.issueNumber,
            "add-labels",
            "GitHub issues.addLabels is unavailable for the additive mutation",
        );
    }
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            issue_number: input.action.issueNumber,
            labels: [...labelPlan.toAdd],
            ...requestOptions(input.signal),
        });
        if (responseContainsLabels(response, labelPlan.toAdd)) {
            return applied(
                input.actionKey,
                input.action.issueNumber,
                "labels-added",
                "additive labels were accepted by GitHub",
                { labels: labelPlan.toAdd },
            );
        }
        return reconcileUncertainLabels({
            ...input,
            labels: labelPlan.toAdd,
            detail: "GitHub accepted an ambiguous label response but authoritative refetch did not confirm every requested label",
        });
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcileUncertainLabels({
            ...input,
            labels: labelPlan.toAdd,
            detail: `label mutation may have reached GitHub; authoritative refetch did not confirm completion: ${detailOf(cause)}`,
        });
    }
};

const markerFailure = (
    actionKey: string,
    issueNumber: number,
    discovery: MarkerDiscovery,
): MaintenanceMutationResult | undefined => {
    if (discovery.matching.length > 1) {
        return skipped(
            actionKey,
            issueNumber,
            "duplicate-marker",
            "more than one comment carries the same issue-scoped action marker",
        );
    }
    if (discovery.malformed.length > 0) {
        return skipped(
            actionKey,
            issueNumber,
            "marker-malformed",
            "a comment contains a malformed or conflicting Ralphie maintenance marker; no comment was overwritten",
        );
    }
    return undefined;
};

type EnsureManagedCommentInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly action: AskQuestionAction | AnswerQuestionAction;
    readonly actionKey: string;
    readonly desiredBody: string;
    readonly actorLogin: string;
    readonly signal?: AbortSignal;
    readonly mode: "ask" | "answer";
};

const updateManagedComment = async (
    input: EnsureManagedCommentInput,
    existing: {
        readonly comment: LiveComment;
        readonly marker: MaintenanceActionMarker;
    },
): Promise<MaintenanceMutationResult> => {
    if (!sameActor(existing.comment.authorLogin, input.actorLogin)) {
        return skipped(
            input.actionKey,
            input.issue.number,
            "managed-comment-ownership",
            "the matching managed comment is not owned by the authenticated actor",
        );
    }
    if (
        !maintenanceActionMarkerOwnsBody(existing.comment.body, existing.marker)
    ) {
        return skipped(
            input.actionKey,
            input.issue.number,
            "human-edited-managed-comment",
            "the matching managed comment was edited after Ralphie published it; the human edit is preserved",
        );
    }
    if (existing.comment.body === input.desiredBody) {
        return unchanged(
            input.actionKey,
            input.issue.number,
            "the managed comment already contains the desired body",
            { commentId: existing.comment.id },
        );
    }
    const endpoint = endpointFor(input.client, "issues", "updateComment");
    if (endpoint === undefined) {
        return recovered(
            input.actionKey,
            input.issue.number,
            "update-comment",
            "GitHub issues.updateComment is unavailable for the managed update",
        );
    }
    const reconcile = () =>
        commentMutationReconciliation({
            client: input.client,
            repository: input.repository,
            issueNumber: input.issue.number,
            action: input.action.action,
            actionKey: input.actionKey,
            desiredBody: input.desiredBody,
            operation: "update-comment",
            actorLogin: input.actorLogin,
            signal: input.signal,
        });
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            comment_id: existing.comment.id,
            body: input.desiredBody,
            ...requestOptions(input.signal),
        });
        const returned = responseData(response);
        return isRecord(returned) && text(returned.body) === input.desiredBody
            ? applied(
                  input.actionKey,
                  input.issue.number,
                  "comment-updated",
                  "the Ralphie-managed comment was updated in place",
                  { commentId: existing.comment.id },
              )
            : await reconcile();
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcile();
    }
};

const equivalentQuestionResult = (
    input: EnsureManagedCommentInput,
    comments: ReadonlyArray<LiveComment>,
): MaintenanceMutationResult | undefined => {
    if (input.mode !== "ask") return undefined;
    const action = input.action as AskQuestionAction;
    const normalizedQuestion = normalizeComparableText(action.question);
    const questionIndex = comments.findIndex(
        (comment) =>
            normalizeComparableText(questionFromBody(comment.body) ?? "") ===
            normalizedQuestion,
    );
    if (questionIndex < 0) return undefined;
    const later = comments.slice(questionIndex + 1);
    const answered = later.some(
        (comment) =>
            normalizeComparableText(comment.body ?? "") !==
                normalizedQuestion &&
            normalizeComparableText(comment.body ?? "").length > 0,
    );
    return skipped(
        input.actionKey,
        input.issue.number,
        answered ? "already-answered" : "equivalent-question",
        answered
            ? "an equivalent question already has a later answer; no duplicate question was created"
            : "an equivalent human question already exists; it was preserved",
    );
};

const equivalentAnswerResult = (
    input: EnsureManagedCommentInput,
    comments: ReadonlyArray<LiveComment>,
): MaintenanceMutationResult | undefined => {
    if (input.mode !== "answer") return undefined;
    const action = input.action as AnswerQuestionAction;
    const normalizedAnswer = normalizeComparableText(action.answer);
    const exists = comments.some(
        (comment) =>
            !sameActor(comment.authorLogin, input.actorLogin) &&
            normalizeComparableText(
                answerFromBody(comment.body) ?? comment.body ?? "",
            ) === normalizedAnswer,
    );
    return exists
        ? unchanged(
              input.actionKey,
              input.issue.number,
              "an equivalent grounded answer already exists",
          )
        : undefined;
};

const createManagedComment = async (
    input: EnsureManagedCommentInput,
): Promise<MaintenanceMutationResult> => {
    const endpoint = endpointFor(input.client, "issues", "createComment");
    if (endpoint === undefined) {
        return recovered(
            input.actionKey,
            input.issue.number,
            "create-comment",
            "GitHub issues.createComment is unavailable for the managed comment",
        );
    }
    const reconcile = () =>
        commentMutationReconciliation({
            client: input.client,
            repository: input.repository,
            issueNumber: input.issue.number,
            action: input.action.action,
            actionKey: input.actionKey,
            desiredBody: input.desiredBody,
            operation: "create-comment",
            actorLogin: input.actorLogin,
            signal: input.signal,
        });
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            issue_number: input.issue.number,
            body: input.desiredBody,
            ...requestOptions(input.signal),
        });
        const returned = responseData(response);
        const returnedId = recordValue(returned, "id");
        return typeof returnedId === "number" &&
            Number.isSafeInteger(returnedId) &&
            text(recordValue(returned, "body")) === input.desiredBody
            ? applied(
                  input.actionKey,
                  input.issue.number,
                  "comment-created",
                  "the managed comment was created",
                  { commentId: returnedId },
              )
            : await reconcile();
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcile();
    }
};

const ensureManagedComment = async (
    input: EnsureManagedCommentInput,
): Promise<MaintenanceMutationResult> => {
    const commentsResult = await readComments(
        input.client,
        input.repository,
        input.issue.number,
        input.signal,
    );
    if (commentsResult.status !== "ok") {
        return recovered(
            input.actionKey,
            input.issue.number,
            "create-comment",
            commentsResult.detail,
        );
    }
    const discovery = discoverMarkers(
        commentsResult.comments,
        input.issue.number,
        input.action.action,
        input.actionKey,
    );
    const markerSkip = markerFailure(
        input.actionKey,
        input.issue.number,
        discovery,
    );
    if (markerSkip !== undefined) return markerSkip;
    const existing = discovery.matching[0];
    if (existing !== undefined) {
        return updateManagedComment(input, existing);
    }
    const equivalentQuestion = equivalentQuestionResult(
        input,
        commentsResult.comments,
    );
    if (equivalentQuestion !== undefined) return equivalentQuestion;
    const equivalentAnswer = equivalentAnswerResult(
        input,
        commentsResult.comments,
    );
    if (equivalentAnswer !== undefined) return equivalentAnswer;
    return createManagedComment(input);
};

const validateAnswerSource = (
    action: AnswerQuestionAction,
    comments: ReadonlyArray<LiveComment>,
    snapshot: MaintenanceSnapshot | undefined,
    actorLogin: string,
    actionKey: string,
): MaintenanceMutationResult | undefined => {
    const sourceMatches = comments.filter(
        (comment) => comment.id === action.commentId,
    );
    if (sourceMatches.length === 0) {
        return skipped(
            actionKey,
            action.issueNumber,
            "comment-missing",
            `source comment #${String(action.commentId)} is no longer present in the live issue`,
        );
    }
    if (sourceMatches.length > 1) {
        return skipped(
            actionKey,
            action.issueNumber,
            "comment-ambiguous",
            `source comment #${String(action.commentId)} has multiple live records`,
        );
    }
    const source = sourceMatches[0] as LiveComment;
    if (source.url !== action.sourceUrl) {
        return skipped(
            actionKey,
            action.issueNumber,
            "comment-url-mismatch",
            `source comment #${String(action.commentId)} no longer has the URL cited by the plan`,
        );
    }
    if (
        action.sourceIssueNumber !== undefined &&
        action.sourceIssueNumber !== action.issueNumber
    ) {
        return skipped(
            actionKey,
            action.issueNumber,
            "source-issue-mismatch",
            `sourceIssueNumber ${String(action.sourceIssueNumber)} does not match the action issue #${String(action.issueNumber)}`,
        );
    }
    if (!sourceSnapshotIsCurrent(snapshot, source)) {
        return skipped(
            actionKey,
            action.issueNumber,
            "stale-answer",
            "the grounded source comment changed after the immutable snapshot was captured",
        );
    }
    return sameActor(source.authorLogin, actorLogin)
        ? skipped(
              actionKey,
              action.issueNumber,
              "self-reply",
              "the cited source comment is authored by the authenticated Ralphie actor; Ralphie will not reply to its own answer",
          )
        : undefined;
};

const reconcileCommentAction = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceMutationRequest;
    readonly action: AskQuestionAction | AnswerQuestionAction;
    readonly actionKey: string;
}): Promise<MaintenanceMutationResult> => {
    const action = input.action;
    const issueResult = await readIssue(
        input.client,
        input.repository,
        action.issueNumber,
        input.request.signal,
    );
    const issueFailure = issueReadResult(
        issueResult,
        input.actionKey,
        action.issueNumber,
        "create-comment",
    );
    if (issueFailure !== undefined) return issueFailure;
    const issue = (issueResult as Extract<ReadIssueResult, { status: "ok" }>)
        .issue;
    const urlFailure = matchIssueUrl(issue, input.request.expectedIssueUrl);
    if (urlFailure !== undefined) {
        return skipped(
            input.actionKey,
            action.issueNumber,
            "stale-fingerprint",
            urlFailure,
        );
    }
    const actor = await actorFor(input.client, input.request);
    if (actor.status !== "ok") {
        return skipped(
            input.actionKey,
            action.issueNumber,
            "authenticated-actor-unavailable",
            actor.detail,
        );
    }
    const checker =
        input.request.confirmLockedCommentPermission ??
        input.request.canCommentOnLockedIssue;
    const lockedPermission = await canCommentOnLockedIssue(
        input.client,
        input.repository,
        issue,
        actor.login,
        checker,
        input.request.signal,
    );
    if (lockedPermission === undefined) {
        return skipped(
            input.actionKey,
            action.issueNumber,
            "locked-comment-permission-unknown",
            "issue is locked and GitHub did not confirm that the authenticated actor may comment",
        );
    }
    if (!lockedPermission) {
        return skipped(
            input.actionKey,
            action.issueNumber,
            "locked-comment-not-permitted",
            "issue is locked and GitHub did not grant the authenticated actor comment permission",
        );
    }
    const commentsResult = await readComments(
        input.client,
        input.repository,
        action.issueNumber,
        input.request.signal,
    );
    if (commentsResult.status !== "ok") {
        return recovered(
            input.actionKey,
            action.issueNumber,
            "create-comment",
            commentsResult.detail,
        );
    }
    if (action.action === "answer-question") {
        const sourceFailure = validateAnswerSource(
            action,
            commentsResult.comments,
            input.request.snapshot,
            actor.login,
            input.actionKey,
        );
        if (sourceFailure !== undefined) return sourceFailure;
    }
    if (action.action === "ask-question") {
        const askAction = action as AskQuestionAction;
        return ensureManagedComment({
            client: input.client,
            repository: input.repository,
            issue,
            action: askAction,
            actionKey: input.actionKey,
            desiredBody: renderMaintenanceActionComment({
                action: askAction,
                actionKey: input.actionKey,
            }),
            actorLogin: actor.login,
            signal: input.request.signal,
            mode: "ask",
        });
    }
    const answerAction = action as AnswerQuestionAction;
    return ensureManagedComment({
        client: input.client,
        repository: input.repository,
        issue,
        action: answerAction,
        actionKey: input.actionKey,
        desiredBody: renderMaintenanceActionComment({
            action: answerAction,
            actionKey: input.actionKey,
        }),
        actorLogin: actor.login,
        signal: input.request.signal,
        mode: "answer",
    });
};

export type GitHubIssueMaintenanceService = {
    /** Reconcile one validated non-relationship maintenance action. */
    readonly reconcile: (
        client: Octokit,
        repository: string,
        request: MaintenanceMutationRequest,
    ) => Promise<MaintenanceMutationResult>;
};

export type IssueMaintenanceService = GitHubIssueMaintenanceService;

const reconcileValidatedAction = async (
    client: Octokit,
    repository: string,
    request: MaintenanceMutationRequest,
    action: ActionWithKey,
): Promise<MaintenanceMutationResult> => {
    const fingerprintFailure = validateFingerprint(action, request);
    if (fingerprintFailure !== undefined) {
        return skipped(
            action.actionKey,
            action.issueNumber,
            "stale-fingerprint",
            fingerprintFailure,
        );
    }
    if (action.action === "skip") {
        return skipped(
            action.actionKey,
            action.issueNumber,
            "planner-skip",
            `planner requested skip: ${action.reason}`,
        );
    }
    if (
        action.action === "link-duplicate" ||
        action.action === "close-duplicate" ||
        action.action === "link-related"
    ) {
        return skipped(
            action.actionKey,
            action.issueNumber,
            "unsupported-action",
            "relationship actions belong to the separate relationship policy adapter",
        );
    }
    if (action.action === "add-labels") {
        return reconcileLabels({
            client,
            repository,
            action,
            actionKey: action.actionKey,
            expectedIssueUrl: request.expectedIssueUrl,
            signal: request.signal,
        });
    }
    return reconcileCommentAction({
        client,
        repository,
        request,
        action,
        actionKey: action.actionKey,
    });
};

/**
 * Create the GitHub mutation adapter. The small interface deliberately takes
 * one action at a time so a future runner can persist the returned outcome
 * before proceeding to the next action.
 */
export const makeGitHubIssueMaintenanceService =
    (): GitHubIssueMaintenanceService => ({
        reconcile: async (client, repository, request) => {
            throwIfAborted(request.signal);
            const validation = validateAction(request.action);
            if (validation.status !== "ok") {
                return skipped(
                    "maintenance-action:invalid",
                    0,
                    "invalid-action",
                    validation.detail,
                );
            }
            const repositoryValidation = validateRepository(repository);
            if (!repositoryValidation.valid) {
                return skipped(
                    validation.action.actionKey,
                    validation.action.issueNumber,
                    "invalid-repository",
                    repositoryValidation.detail,
                );
            }
            return reconcileValidatedAction(
                client,
                repository,
                request,
                validation.action,
            );
        },
    });

export const makeIssueMaintenanceService = makeGitHubIssueMaintenanceService;
export const GitHubIssueMaintenanceLive = makeGitHubIssueMaintenanceService;
export const IssueMaintenanceLive = makeGitHubIssueMaintenanceService;