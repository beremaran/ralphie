/**
 * Deterministic relationship policy for maintenance plans.
 *
 * This module is the only maintenance mutation seam that may close an issue.
 * Candidate analysis and plan validation remain pure; this adapter rereads
 * both live issues, proves the candidate and pair are still safe, and then
 * reconciles marker-owned comments through an injected Octokit client.
 * Relationship comments are deliberately used instead of issue-body edits so
 * human-authored descriptions and links remain untouched.
 */
import type { Octokit } from "octokit";

import {
    issueMaintenanceActionSchema,
    maintenanceActionKey,
    type IssueMaintenanceAction,
} from "../maintain-issues-plan.ts";
import type { MaintenanceCandidate } from "../maintain-issues-candidates.ts";
import {
    maintenanceActionBodySha256,
    normalizeMaintenanceCommentText,
} from "./issue-maintenance.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export const MAINTENANCE_RELATIONSHIP_MARKER_VERSION = 1;
export const RALPHIE_MAINTENANCE_RELATIONSHIP_MARKER =
    "ralphie:maintain-relationship";
export const MAINTENANCE_RELATIONSHIP_MARKER_PREFIX =
    RALPHIE_MAINTENANCE_RELATIONSHIP_MARKER;

export type MaintenanceRelationshipKind = "duplicate" | "related";

export type MaintenanceRelationshipMarker = {
    readonly version: typeof MAINTENANCE_RELATIONSHIP_MARKER_VERSION;
    readonly issueNumber: number;
    readonly relation: MaintenanceRelationshipKind;
    readonly targetIssueNumber: number;
    readonly pairKey: string;
    readonly bodySha256: string;
    readonly normalized: string;
};

const relationshipMarkerPattern =
    /<!-- ralphie:maintain-relationship version=1 issue=([1-9]\d*) relation=(duplicate|related) target=([1-9]\d*) pair-key=("(?:\\.|[^"\\])*") body-sha256=([0-9a-f]{64}) -->(?=\n|$)/g;
const relationshipMarkerLikePattern =
    /<!--\s*ralphie:maintain-relationship\b/gu;

const positiveInteger = (value: string): number | undefined => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const isRelationshipKind = (
    value: string | undefined,
): value is MaintenanceRelationshipKind =>
    value === "duplicate" || value === "related";

const parseRelationshipMarkerMatch = (
    match: RegExpMatchArray,
): MaintenanceRelationshipMarker | undefined => {
    const issueNumber = positiveInteger(match[1] ?? "");
    const relation = match[2];
    const targetIssueNumber = positiveInteger(match[3] ?? "");
    const rawPairKey = match[4];
    const bodySha256 = match[5];
    if (
        issueNumber === undefined ||
        !isRelationshipKind(relation) ||
        targetIssueNumber === undefined ||
        issueNumber === targetIssueNumber ||
        rawPairKey === undefined ||
        bodySha256 === undefined
    ) {
        return undefined;
    }
    let pairKey: unknown;
    try {
        pairKey = JSON.parse(rawPairKey);
    } catch {
        return undefined;
    }
    if (typeof pairKey !== "string" || pairKey.trim().length === 0) {
        return undefined;
    }
    return Object.freeze({
        version: MAINTENANCE_RELATIONSHIP_MARKER_VERSION,
        issueNumber,
        relation,
        targetIssueNumber,
        pairKey,
        bodySha256,
        normalized: match[0],
    });
};

/** Parse every exact relationship marker in a comment body. */
export const parseMaintenanceRelationshipMarkers = (
    body: string | null | undefined,
): ReadonlyArray<MaintenanceRelationshipMarker> => {
    if (typeof body !== "string" || body.length === 0) {
        return Object.freeze([]);
    }
    relationshipMarkerPattern.lastIndex = 0;
    const markers: MaintenanceRelationshipMarker[] = [];
    for (const match of body.matchAll(relationshipMarkerPattern)) {
        const marker = parseRelationshipMarkerMatch(match);
        if (marker !== undefined) markers.push(marker);
    }
    relationshipMarkerPattern.lastIndex = 0;
    return Object.freeze(markers);
};

export const parseAllMaintenanceRelationshipMarkers =
    parseMaintenanceRelationshipMarkers;
export const parseManagedRelationshipMarkers =
    parseMaintenanceRelationshipMarkers;

/** Parse one marker only; duplicates and embedded markers are not owned. */
export const parseMaintenanceRelationshipMarker = (
    body: string | null | undefined,
): MaintenanceRelationshipMarker | undefined => {
    if (typeof body !== "string") return undefined;
    const markers = parseMaintenanceRelationshipMarkers(body);
    const marker = markers[0];
    if (marker === undefined || markers.length !== 1) return undefined;
    return body.startsWith(marker.normalized) ? marker : undefined;
};

export const parseManagedRelationshipMarker =
    parseMaintenanceRelationshipMarker;

export type MaintenanceRelationshipMarkerInput = {
    readonly issueNumber: number;
    readonly relation: MaintenanceRelationshipKind;
    readonly targetIssueNumber: number;
    readonly pairKey: string;
    readonly bodySha256: string;
};

/** Derive a direction-independent key for a relationship pair. */
export const maintenanceRelationshipPairKey = (
    relation: MaintenanceRelationshipKind,
    leftIssueNumber: number,
    rightIssueNumber: number,
): string => {
    if (
        !Number.isSafeInteger(leftIssueNumber) ||
        leftIssueNumber <= 0 ||
        !Number.isSafeInteger(rightIssueNumber) ||
        rightIssueNumber <= 0 ||
        leftIssueNumber === rightIssueNumber
    ) {
        throw new RalphieError({
            message: "A relationship pair requires two distinct issue numbers.",
        });
    }
    if (!isRelationshipKind(relation)) {
        throw new RalphieError({
            message: `Unsupported maintenance relationship: ${String(relation)}.`,
        });
    }
    const first = Math.min(leftIssueNumber, rightIssueNumber);
    const second = Math.max(leftIssueNumber, rightIssueNumber);
    return `relationship:${relation}:${String(first)}:${String(second)}`;
};

export const relationshipPairKey = maintenanceRelationshipPairKey;
export const stableRelationshipPairKey = maintenanceRelationshipPairKey;

/** Render the exact versioned relationship marker line. */
export const renderMaintenanceRelationshipMarker = (
    input: MaintenanceRelationshipMarkerInput,
): string => {
    if (
        !Number.isSafeInteger(input.issueNumber) ||
        input.issueNumber <= 0 ||
        !Number.isSafeInteger(input.targetIssueNumber) ||
        input.targetIssueNumber <= 0 ||
        input.issueNumber === input.targetIssueNumber
    ) {
        throw new RalphieError({
            message:
                "A relationship marker requires two distinct issue numbers.",
        });
    }
    if (!isRelationshipKind(input.relation)) {
        throw new RalphieError({
            message: `Unsupported maintenance relationship: ${String(input.relation)}.`,
        });
    }
    if (input.pairKey.trim().length === 0) {
        throw new RalphieError({
            message: "A relationship marker pair key cannot be blank.",
        });
    }
    if (!/^[0-9a-f]{64}$/u.test(input.bodySha256)) {
        throw new RalphieError({
            message:
                "A relationship marker body digest must be a SHA-256 hex value.",
        });
    }
    return `<!-- ${RALPHIE_MAINTENANCE_RELATIONSHIP_MARKER} version=${String(MAINTENANCE_RELATIONSHIP_MARKER_VERSION)} issue=${String(input.issueNumber)} relation=${input.relation} target=${String(input.targetIssueNumber)} pair-key=${JSON.stringify(input.pairKey)} body-sha256=${input.bodySha256} -->`;
};

export const maintenanceRelationshipMarker =
    renderMaintenanceRelationshipMarker;
export const managedRelationshipMarker = renderMaintenanceRelationshipMarker;

const contentAfterMarker = (
    body: string,
    marker: MaintenanceRelationshipMarker,
): string | undefined => {
    if (!body.startsWith(marker.normalized)) return undefined;
    const suffix = body.slice(marker.normalized.length);
    return suffix.startsWith("\n") ? suffix.slice(1) : suffix;
};

/** Verify that the body after a relationship marker is unchanged. */
export const maintenanceRelationshipMarkerOwnsBody = (
    body: string | null | undefined,
    marker: MaintenanceRelationshipMarker,
): boolean => {
    if (typeof body !== "string") return false;
    const content = contentAfterMarker(body, marker);
    return (
        content !== undefined &&
        maintenanceActionBodySha256(content) === marker.bodySha256
    );
};

export const isUnchangedMaintenanceRelationshipBody =
    maintenanceRelationshipMarkerOwnsBody;

export type DuplicateAction = Extract<
    IssueMaintenanceAction,
    { readonly action: "link-duplicate" | "close-duplicate" }
>;
export type RelatedAction = Extract<
    IssueMaintenanceAction,
    { readonly action: "link-related" }
>;
export type RelationshipAction = DuplicateAction | RelatedAction;

export type RelationshipCommentEvidence = {
    readonly kind: string;
    readonly detail: string;
    readonly value: string | null;
};

export type RenderMaintenanceRelationshipCommentInput = {
    readonly issueNumber: number;
    readonly targetIssueNumber: number;
    readonly relation: MaintenanceRelationshipKind;
    readonly targetUrl: string;
    readonly pairKey?: string;
    readonly candidateId: string;
    readonly snapshotFingerprint: string;
    readonly rationale: string;
    readonly evidence?: ReadonlyArray<RelationshipCommentEvidence>;
};

const relationshipContent = (
    input: RenderMaintenanceRelationshipCommentInput,
    pairKey: string,
): string => {
    const relation =
        input.relation === "duplicate"
            ? `This issue is a duplicate of [#${String(input.targetIssueNumber)}](${input.targetUrl}).`
            : `This issue is related to [#${String(input.targetIssueNumber)}](${input.targetUrl}).`;
    const evidence = input.evidence ?? [];
    const evidenceLines =
        evidence.length === 0
            ? [
                  "- No additional evidence was supplied by the candidate analysis.",
              ]
            : evidence.map(
                  (item) =>
                      `- ${item.kind}: ${item.detail}${item.value === null ? "" : ` (${item.value})`}`,
              );
    return [
        input.relation === "duplicate"
            ? "### Ralphie duplicate relationship"
            : "### Ralphie related issue",
        "",
        relation,
        "",
        `Pair key: \`${pairKey}\``,
        `Candidate: \`${input.candidateId}\``,
        `Snapshot fingerprint: ${input.snapshotFingerprint}`,
        "Evidence:",
        ...evidenceLines,
        "",
        `Rationale: ${input.rationale}`,
    ].join("\n");
};

/** Render a marker-owned duplicate or related-issue comment. */
export const renderMaintenanceRelationshipComment = (
    input: RenderMaintenanceRelationshipCommentInput,
): string => {
    const pairKey =
        input.pairKey ??
        maintenanceRelationshipPairKey(
            input.relation,
            input.issueNumber,
            input.targetIssueNumber,
        );
    const content = relationshipContent(input, pairKey);
    const marker = renderMaintenanceRelationshipMarker({
        issueNumber: input.issueNumber,
        relation: input.relation,
        targetIssueNumber: input.targetIssueNumber,
        pairKey,
        bodySha256: maintenanceActionBodySha256(content),
    });
    return `${marker}\n${content}`;
};

export const renderManagedRelationshipComment =
    renderMaintenanceRelationshipComment;

export type RelationshipMutationSkipReason =
    | "invalid-action"
    | "invalid-repository"
    | "unsupported-action"
    | "candidate-missing"
    | "candidate-invalid"
    | "candidate-kind-mismatch"
    | "candidate-stale"
    | "candidate-not-eligible"
    | "action-issue-mismatch"
    | "target-mismatch"
    | "pair-missing"
    | "pair-inaccessible"
    | "pair-closed"
    | "pair-changed"
    | "not-an-issue"
    | "duplicate-cycle"
    | "duplicate-label"
    | "locked-comment-permission-unknown"
    | "locked-comment-not-permitted"
    | "authenticated-actor-unavailable"
    | "marker-malformed"
    | "duplicate-marker"
    | "foreign-marker"
    | "managed-comment-ownership"
    | "human-edited-managed-comment"
    | "human-relationship-conflict"
    | "link-conflict"
    | "close-conflict";

export type RelationshipEvidenceCheck = {
    readonly check:
        | "candidate"
        | "subject-read"
        | "target-read"
        | "subject-url"
        | "target-url"
        | "candidate-metadata"
        | "open-state"
        | "duplicate-cycle"
        | "duplicate-label"
        | "marker-discovery"
        | "marker-ownership"
        | "close-state";
    readonly status: "confirmed" | "failed" | "not-run";
    readonly detail: string;
};

export type RelationshipEvidence = {
    readonly candidateId: string | null;
    readonly snapshotFingerprint: string | null;
    readonly liveChecks: ReadonlyArray<RelationshipEvidenceCheck>;
};

export type RelationshipMutationBase = {
    readonly actionKey: string;
    readonly issueNumber: number;
    readonly targetIssueNumber: number;
    readonly evidence: RelationshipEvidence;
};

export type RelationshipSide = "lower-issue" | "higher-issue";

export type RelationshipMutationResult =
    | (RelationshipMutationBase & {
          readonly status: "applied";
          readonly mutation:
              | "duplicate-linked"
              | "related-pair-linked"
              | "duplicate-closed";
          readonly changed: true;
          readonly detail: string;
          readonly commentId?: number;
          readonly completedSides?: ReadonlyArray<RelationshipSide>;
      })
    | (RelationshipMutationBase & {
          readonly status: "unchanged";
          readonly mutation: "none";
          readonly changed: false;
          readonly detail: string;
          readonly commentId?: number;
          readonly completedSides?: ReadonlyArray<RelationshipSide>;
      })
    | (RelationshipMutationBase & {
          readonly status: "skipped";
          readonly reason: RelationshipMutationSkipReason;
          readonly changed: false;
          readonly detail: string;
          readonly completedSides?: ReadonlyArray<RelationshipSide>;
      })
    | (RelationshipMutationBase & {
          readonly status: "recovery-required";
          readonly operation:
              | "read-pair"
              | "relationship-comment"
              | "related-pair"
              | "close-duplicate";
          readonly changed: false;
          readonly detail: string;
          readonly completedSides?: ReadonlyArray<RelationshipSide>;
      });

type RelationshipRecoveryOperation =
    | "read-pair"
    | "relationship-comment"
    | "related-pair"
    | "close-duplicate";

export type IssueMaintenanceRelationshipMutationResult =
    RelationshipMutationResult;
export type MaintenanceRelationshipMutationOutcome = RelationshipMutationResult;

type WorkingContext = {
    readonly actionKey: string;
    readonly issueNumber: number;
    readonly targetIssueNumber: number;
    readonly candidate?: MaintenanceCandidate;
    readonly checks: RelationshipEvidenceCheck[];
};

const contextFor = (
    actionKey: string,
    issueNumber: number,
    targetIssueNumber: number,
    candidate?: MaintenanceCandidate,
): WorkingContext => ({
    actionKey,
    issueNumber,
    targetIssueNumber,
    candidate,
    checks: [],
});

const check = (
    context: WorkingContext,
    name: RelationshipEvidenceCheck["check"],
    status: RelationshipEvidenceCheck["status"],
    detail: string,
): void => {
    context.checks.push(Object.freeze({ check: name, status, detail }));
};

const evidenceFor = (context: WorkingContext): RelationshipEvidence =>
    Object.freeze({
        candidateId: context.candidate?.candidateId ?? null,
        snapshotFingerprint: context.candidate?.snapshotFingerprint ?? null,
        liveChecks: Object.freeze([...context.checks]),
    });

const freezeResult = <Result extends RelationshipMutationResult>(
    result: Result,
): Result => Object.freeze(result);

const skipped = (
    context: WorkingContext,
    reason: RelationshipMutationSkipReason,
    detail: string,
    completedSides?: ReadonlyArray<RelationshipSide>,
): RelationshipMutationResult =>
    freezeResult({
        actionKey: context.actionKey,
        issueNumber: context.issueNumber,
        targetIssueNumber: context.targetIssueNumber,
        evidence: evidenceFor(context),
        status: "skipped",
        reason,
        changed: false,
        detail,
        ...(completedSides === undefined
            ? {}
            : { completedSides: Object.freeze([...completedSides]) }),
    });

const recovered = (
    context: WorkingContext,
    operation: RelationshipRecoveryOperation,
    detail: string,
    completedSides?: ReadonlyArray<RelationshipSide>,
): RelationshipMutationResult =>
    freezeResult({
        actionKey: context.actionKey,
        issueNumber: context.issueNumber,
        targetIssueNumber: context.targetIssueNumber,
        evidence: evidenceFor(context),
        status: "recovery-required",
        operation,
        changed: false,
        detail,
        ...(completedSides === undefined
            ? {}
            : { completedSides: Object.freeze([...completedSides]) }),
    });

const applied = (
    context: WorkingContext,
    mutation: Extract<
        RelationshipMutationResult,
        { readonly status: "applied" }
    >["mutation"],
    detail: string,
    extra: {
        readonly commentId?: number;
        readonly completedSides?: ReadonlyArray<RelationshipSide>;
    } = {},
): RelationshipMutationResult =>
    freezeResult({
        actionKey: context.actionKey,
        issueNumber: context.issueNumber,
        targetIssueNumber: context.targetIssueNumber,
        evidence: evidenceFor(context),
        status: "applied",
        mutation,
        changed: true,
        detail,
        ...(extra.commentId === undefined
            ? {}
            : { commentId: extra.commentId }),
        ...(extra.completedSides === undefined
            ? {}
            : { completedSides: Object.freeze([...extra.completedSides]) }),
    });

const unchanged = (
    context: WorkingContext,
    detail: string,
    extra: {
        readonly commentId?: number;
        readonly completedSides?: ReadonlyArray<RelationshipSide>;
    } = {},
): RelationshipMutationResult =>
    freezeResult({
        actionKey: context.actionKey,
        issueNumber: context.issueNumber,
        targetIssueNumber: context.targetIssueNumber,
        evidence: evidenceFor(context),
        status: "unchanged",
        mutation: "none",
        changed: false,
        detail,
        ...(extra.commentId === undefined
            ? {}
            : { commentId: extra.commentId }),
        ...(extra.completedSides === undefined
            ? {}
            : { completedSides: Object.freeze([...extra.completedSides]) }),
    });

type RecordLike = Record<string, unknown>;
type Endpoint = (parameters: RecordLike) => Promise<unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
    typeof value === "string" ? value : "";

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
    if (value instanceof Error && value.message.length > 0)
        return value.message;
    if (isRecord(value) && typeof value.message === "string") {
        return value.message;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

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
        Object.assign(
            new Error("maintenance relationship reconciliation aborted"),
            {
                name: "AbortError",
            },
        )
    );
};

const requestOptions = (signal: AbortSignal | undefined): RecordLike =>
    signal === undefined ? {} : { request: { signal } };

const endpointFor = (
    client: Octokit,
    namespace: string,
    name: string,
): Endpoint | undefined => {
    const rest = recordValue(client, "rest");
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
): { readonly owner: string; readonly repo: string } => {
    const parsed = parseRepositorySlug(repository);
    return { owner: parsed.owner, repo: parsed.name };
};

type LiveComment = {
    readonly id: number;
    readonly body: string | null;
    readonly url: string;
    readonly authorLogin: string | undefined;
    readonly createdAt: string;
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
    };
};

const compareComments = (left: LiveComment, right: LiveComment): number =>
    left.createdAt.localeCompare(right.createdAt) || left.id - right.id;

type LiveIssue = {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly body: string | null;
    readonly state: "open" | "closed";
    readonly stateReason: string | undefined;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly labels: ReadonlyArray<string>;
    readonly locked: boolean;
    readonly permissions: RecordLike | undefined;
    readonly raw: RecordLike;
};

type LiveReadResult =
    | { readonly status: "ok"; readonly issue: LiveIssue }
    | {
          readonly status: "skipped";
          readonly reason:
              | "pair-missing"
              | "pair-inaccessible"
              | "not-an-issue";
          readonly detail: string;
      }
    | { readonly status: "recovery-required"; readonly detail: string };

const labelsFromLiveIssue = (value: RecordLike): ReadonlyArray<string> =>
    Array.isArray(value.labels)
        ? value.labels.flatMap((label) => {
              if (typeof label === "string") return [label];
              return isRecord(label) && typeof label.name === "string"
                  ? [label.name]
                  : [];
          })
        : [];

const liveIssueIdentityIsValid = (
    value: RecordLike,
    issueNumber: number,
): boolean =>
    typeof value.number === "number" &&
    Number.isSafeInteger(value.number) &&
    value.number === issueNumber;

const liveIssueStateIsSupported = (
    value: unknown,
): value is "open" | "closed" => value === "open" || value === "closed";

const liveIssueFrom = (data: unknown, issueNumber: number): LiveReadResult => {
    if (!isRecord(data)) {
        return {
            status: "recovery-required",
            detail: "GitHub returned no issue object for relationship reconciliation.",
        };
    }
    if (Object.prototype.hasOwnProperty.call(data, "pull_request")) {
        return {
            status: "skipped",
            reason: "not-an-issue",
            detail: `#${String(issueNumber)} is a pull request, not an issue`,
        };
    }
    if (!liveIssueIdentityIsValid(data, issueNumber)) {
        return {
            status: "recovery-required",
            detail: `GitHub returned an issue identity that does not match #${String(issueNumber)}`,
        };
    }
    if (!liveIssueStateIsSupported(data.state)) {
        return {
            status: "recovery-required",
            detail: `GitHub returned unsupported state ${JSON.stringify(data.state)} for issue #${String(issueNumber)}`,
        };
    }
    return {
        status: "ok",
        issue: {
            number: issueNumber,
            url: text(data.html_url ?? data.htmlUrl ?? data.url),
            title: text(data.title),
            body: typeof data.body === "string" ? data.body : null,
            state: data.state,
            stateReason:
                text(data.state_reason ?? data.stateReason) || undefined,
            createdAt: text(data.created_at ?? data.createdAt),
            updatedAt: text(data.updated_at ?? data.updatedAt),
            labels: labelsFromLiveIssue(data),
            locked: data.locked === true,
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
): Promise<LiveReadResult> => {
    const endpoint = endpointFor(client, "issues", "get");
    if (endpoint === undefined) {
        return {
            status: "recovery-required",
            detail: "GitHub issues.get is unavailable for relationship reconciliation.",
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
        const status = statusOf(cause);
        if (status === 404) {
            return {
                status: "skipped",
                reason: "pair-missing",
                detail: `issue #${String(issueNumber)} is not present in the live repository`,
            };
        }
        if (status === 401 || status === 403) {
            return {
                status: "skipped",
                reason: "pair-inaccessible",
                detail: `issue #${String(issueNumber)} is inaccessible to the authenticated GitHub actor`,
            };
        }
        return {
            status: "recovery-required",
            detail: `live relationship issue read failed: ${detailOf(cause)}`,
        };
    }
};

const normalizedRelationshipLabel = (value: string): string =>
    value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

const labelNamesFrom = (value: unknown): ReadonlyArray<string> => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        return isRecord(entry) && typeof entry.name === "string"
            ? [entry.name]
            : [];
    });
};

const labelsContain = (
    labels: ReadonlyArray<string>,
    expected: string,
): boolean => {
    const normalizedExpected = normalizedRelationshipLabel(expected);
    return labels.some(
        (label) => normalizedRelationshipLabel(label) === normalizedExpected,
    );
};

type RelationshipLabelCatalogResult =
    | { readonly status: "ok"; readonly duplicateLabel?: string }
    | { readonly status: "ambiguous"; readonly detail: string }
    | { readonly status: "unavailable"; readonly detail: string };

const readRelationshipLabelCatalog = async (
    client: Octokit,
    repository: string,
    signal: AbortSignal | undefined,
): Promise<RelationshipLabelCatalogResult> => {
    const endpoint = endpointFor(client, "issues", "listLabelsForRepo");
    if (endpoint === undefined) {
        return {
            status: "unavailable",
            detail: "GitHub issues.listLabelsForRepo is unavailable; the optional duplicate label cannot be inspected",
        };
    }
    const parameters = {
        ...repositoryParameters(repository),
        per_page: 100,
        ...requestOptions(signal),
    };
    try {
        const pagination = (
            client as unknown as {
                readonly paginate?: (
                    method: unknown,
                    parameters: RecordLike,
                ) => Promise<unknown>;
            }
        ).paginate;
        const data =
            pagination === undefined
                ? responseData(await endpoint(parameters))
                : await pagination(endpoint, parameters);
        if (!Array.isArray(data)) {
            return {
                status: "unavailable",
                detail: "GitHub returned a non-array label catalog; the optional duplicate label cannot be inspected",
            };
        }
        const matching = [
            ...new Set(
                labelNamesFrom(data).filter(
                    (label) =>
                        normalizedRelationshipLabel(label) === "duplicate",
                ),
            ),
        ];
        if (matching.length > 1) {
            return {
                status: "ambiguous",
                detail: "the repository label catalog contains multiple spellings of duplicate; no label mutation is safe",
            };
        }
        return {
            status: "ok",
            ...(matching[0] === undefined
                ? {}
                : { duplicateLabel: matching[0] }),
        };
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "unavailable",
            detail: `duplicate label catalog discovery failed: ${detailOf(cause)}`,
        };
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
            detail: "GitHub issues.listComments is unavailable for relationship marker discovery.",
        };
    }
    const parameters = {
        ...repositoryParameters(repository),
        issue_number: issueNumber,
        per_page: 100,
        ...requestOptions(signal),
    };
    try {
        const pagination = (
            client as unknown as {
                readonly paginate?: (
                    method: unknown,
                    parameters: RecordLike,
                ) => Promise<unknown>;
            }
        ).paginate;
        const data =
            pagination === undefined
                ? responseData(await endpoint(parameters))
                : await pagination(endpoint, parameters);
        if (!Array.isArray(data)) {
            return {
                status: "recovery-required",
                detail: "GitHub returned a non-array relationship comment collection.",
            };
        }
        const comments = data
            .map(liveCommentFrom)
            .filter((comment): comment is LiveComment => comment !== undefined)
            .sort(compareComments);
        return { status: "ok", comments: Object.freeze(comments) };
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "recovery-required",
            detail: `relationship comment discovery failed: ${detailOf(cause)}`,
        };
    }
};

type DuplicateLabelResult =
    | { readonly status: "ready" }
    | {
          readonly status: "outcome";
          readonly outcome: RelationshipMutationResult;
      };

const reconcileUncertainDuplicateLabel = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly label: string;
    readonly context: WorkingContext;
    readonly detail: string;
    readonly signal?: AbortSignal;
}): Promise<DuplicateLabelResult> => {
    const result = await readIssue(
        input.client,
        input.repository,
        input.issue.number,
        input.signal,
    );
    if (
        result.status === "ok" &&
        result.issue.url === input.issue.url &&
        labelsContain(result.issue.labels, input.label)
    ) {
        check(
            input.context,
            "duplicate-label",
            "confirmed",
            `the duplicate label ${JSON.stringify(input.label)} was confirmed by an authoritative refetch`,
        );
        return { status: "ready" };
    }
    const liveDetail =
        result.status === "ok"
            ? `live issue #${String(input.issue.number)} does not contain ${JSON.stringify(input.label)}`
            : result.detail;
    check(input.context, "duplicate-label", "failed", liveDetail);
    return {
        status: "outcome",
        outcome: recovered(
            input.context,
            "close-duplicate",
            `${input.detail}: ${liveDetail}`,
        ),
    };
};

const ensureDuplicateLabel = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<DuplicateLabelResult> => {
    const catalog = await readRelationshipLabelCatalog(
        input.client,
        input.repository,
        input.signal,
    );
    if (catalog.status === "unavailable") {
        check(input.context, "duplicate-label", "not-run", catalog.detail);
        return { status: "ready" };
    }
    if (catalog.status === "ambiguous") {
        check(input.context, "duplicate-label", "failed", catalog.detail);
        return {
            status: "outcome",
            outcome: recovered(
                input.context,
                "close-duplicate",
                catalog.detail,
            ),
        };
    }
    const duplicateLabel = catalog.duplicateLabel;
    if (duplicateLabel === undefined) {
        check(
            input.context,
            "duplicate-label",
            "confirmed",
            "the duplicate label is absent from the repository catalog; no label mutation was attempted",
        );
        return { status: "ready" };
    }
    if (labelsContain(input.issue.labels, duplicateLabel)) {
        check(
            input.context,
            "duplicate-label",
            "confirmed",
            `the duplicate label ${JSON.stringify(duplicateLabel)} is already present on the duplicate issue`,
        );
        return { status: "ready" };
    }
    const endpoint = endpointFor(input.client, "issues", "addLabels");
    if (endpoint === undefined) {
        const detail =
            "GitHub issues.addLabels is unavailable for the cataloged duplicate label; closure is withheld";
        check(input.context, "duplicate-label", "not-run", detail);
        return {
            status: "outcome",
            outcome: recovered(input.context, "close-duplicate", detail),
        };
    }
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            issue_number: input.issue.number,
            labels: [duplicateLabel],
            ...requestOptions(input.signal),
        });
        const returnedLabels = labelNamesFrom(
            recordValue(responseData(response), "labels"),
        );
        if (labelsContain(returnedLabels, duplicateLabel)) {
            check(
                input.context,
                "duplicate-label",
                "confirmed",
                `the cataloged duplicate label ${JSON.stringify(duplicateLabel)} was added`,
            );
            return { status: "ready" };
        }
        return reconcileUncertainDuplicateLabel({
            ...input,
            label: duplicateLabel,
            detail: "GitHub accepted an ambiguous duplicate-label response but did not return the cataloged label",
        });
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcileUncertainDuplicateLabel({
            ...input,
            label: duplicateLabel,
            detail: `duplicate-label mutation may have reached GitHub: ${detailOf(cause)}`,
        });
    }
};

type CandidateValidation =
    | { readonly status: "ok"; readonly candidate: MaintenanceCandidate }
    | {
          readonly status: "skipped";
          readonly reason:
              | "candidate-missing"
              | "candidate-invalid"
              | "candidate-kind-mismatch"
              | "candidate-stale"
              | "candidate-not-eligible"
              | "action-issue-mismatch"
              | "target-mismatch";
          readonly detail: string;
      };

const isCandidate = (value: unknown): value is MaintenanceCandidate => {
    if (!isRecord(value)) return false;
    const isPositiveIssueNumber = (candidateValue: unknown): boolean =>
        typeof candidateValue === "number" &&
        Number.isSafeInteger(candidateValue) &&
        candidateValue > 0;
    const canonical = value.canonical;
    const canonicalIsValid =
        canonical === undefined ||
        (isRecord(canonical) &&
            ((canonical.status === "resolved" &&
                isPositiveIssueNumber(canonical.issueNumber)) ||
                (canonical.status === "revalidate" &&
                    (canonical.issueNumber === null ||
                        isPositiveIssueNumber(canonical.issueNumber)) &&
                    typeof canonical.reason === "string" &&
                    typeof canonical.detail === "string") ||
                (canonical.status === "skip" &&
                    isPositiveIssueNumber(canonical.issueNumber) &&
                    typeof canonical.reason === "string" &&
                    typeof canonical.detail === "string")));
    return (
        typeof value.pairId === "string" &&
        value.pairId.trim().length > 0 &&
        typeof value.candidateId === "string" &&
        value.candidateId.trim().length > 0 &&
        isPositiveIssueNumber(value.subjectIssueNumber) &&
        isPositiveIssueNumber(value.targetIssueNumber) &&
        value.subjectIssueNumber !== value.targetIssueNumber &&
        typeof value.subjectUrl === "string" &&
        value.subjectUrl.trim().length > 0 &&
        typeof value.targetUrl === "string" &&
        value.targetUrl.trim().length > 0 &&
        typeof value.targetTitle === "string" &&
        typeof value.targetCreatedAt === "string" &&
        (value.kind === "duplicate" ||
            value.kind === "related" ||
            value.kind === "uncertain") &&
        typeof value.evidenceScore === "number" &&
        Number.isFinite(value.evidenceScore) &&
        Array.isArray(value.evidence) &&
        canonicalIsValid &&
        typeof value.snapshotFingerprint === "string" &&
        typeof value.mutationEligible === "boolean"
    );
};

const relationshipFor = (
    action: RelationshipAction,
): MaintenanceRelationshipKind =>
    action.action === "link-related" ? "related" : "duplicate";

const candidateIdentityFailure = (
    action: RelationshipAction,
    candidate: MaintenanceCandidate,
    expectedSnapshotFingerprint: string | undefined,
): CandidateValidation | undefined => {
    if (
        action.candidateId !== candidate.candidateId ||
        action.sourceFingerprint !== candidate.snapshotFingerprint
    ) {
        return {
            status: "skipped",
            reason: "candidate-stale",
            detail: "relationship action identity or source fingerprint does not match the candidate analysis",
        };
    }
    if (
        expectedSnapshotFingerprint !== undefined &&
        expectedSnapshotFingerprint !== candidate.snapshotFingerprint
    ) {
        return {
            status: "skipped",
            reason: "candidate-stale",
            detail: "relationship candidate does not match the expected immutable snapshot fingerprint",
        };
    }
    return undefined;
};

const candidateShapeFailure = (
    action: RelationshipAction,
    candidate: MaintenanceCandidate,
): CandidateValidation | undefined => {
    const relation = relationshipFor(action);
    if (candidate.kind !== relation) {
        return {
            status: "skipped",
            reason: "candidate-kind-mismatch",
            detail: `candidate ${candidate.candidateId} is ${candidate.kind}, not ${relation}`,
        };
    }
    if (!candidate.mutationEligible) {
        return {
            status: "skipped",
            reason: "candidate-not-eligible",
            detail: `candidate ${candidate.candidateId} is not mutation eligible after analysis revalidation`,
        };
    }
    return undefined;
};

const candidateDirectionFailure = (
    action: RelationshipAction,
    candidate: MaintenanceCandidate,
): CandidateValidation | undefined => {
    const relation = relationshipFor(action);
    const pairMember =
        action.issueNumber === candidate.subjectIssueNumber ||
        action.issueNumber === candidate.targetIssueNumber;
    if (relation === "related") {
        return action.issueNumber === candidate.subjectIssueNumber &&
            action.targetIssueNumber === candidate.targetIssueNumber
            ? undefined
            : {
                  status: "skipped",
                  reason: "target-mismatch",
                  detail: "related actions must retain the analyzed subject-to-target direction",
              };
    }
    if (!pairMember) {
        return {
            status: "skipped",
            reason: "action-issue-mismatch",
            detail: "relationship action issue is not a member of the candidate pair",
        };
    }
    if (candidate.canonical?.status !== "resolved") {
        return {
            status: "skipped",
            reason: "candidate-not-eligible",
            detail: "duplicate actions require a resolved canonical selection",
        };
    }
    if (candidate.canonical.issueNumber !== action.targetIssueNumber) {
        return {
            status: "skipped",
            reason: "target-mismatch",
            detail: "duplicate actions must target the canonical issue selected by analysis",
        };
    }
    return action.issueNumber === candidate.canonical.issueNumber
        ? {
              status: "skipped",
              reason: "action-issue-mismatch",
              detail: "the canonical issue cannot be treated as the duplicate source",
          }
        : undefined;
};

const validateCandidate = (
    action: RelationshipAction,
    candidateValue: unknown,
    expectedSnapshotFingerprint: string | undefined,
): CandidateValidation => {
    if (candidateValue === undefined) {
        return {
            status: "skipped",
            reason: "candidate-missing",
            detail: "relationship mutation requires the candidate analysis record used by the plan",
        };
    }
    if (!isCandidate(candidateValue)) {
        return {
            status: "skipped",
            reason: "candidate-invalid",
            detail: "relationship candidate is not a complete immutable candidate record",
        };
    }
    const candidate = candidateValue;
    if (action.targetIssueNumber === action.issueNumber) {
        return {
            status: "skipped",
            reason: "target-mismatch",
            detail: "a relationship cannot target the same issue it starts from",
        };
    }
    const identityFailure = candidateIdentityFailure(
        action,
        candidate,
        expectedSnapshotFingerprint,
    );
    if (identityFailure !== undefined) return identityFailure;
    const shapeFailure = candidateShapeFailure(action, candidate);
    if (shapeFailure !== undefined) return shapeFailure;
    const directionFailure = candidateDirectionFailure(action, candidate);
    if (directionFailure !== undefined) return directionFailure;
    return { status: "ok", candidate };
};

type PairReadResult =
    | {
          readonly status: "ok";
          readonly subject: LiveIssue;
          readonly target: LiveIssue;
      }
    | {
          readonly status: "skipped";
          readonly reason:
              | "pair-missing"
              | "pair-inaccessible"
              | "not-an-issue";
          readonly detail: string;
      }
    | { readonly status: "recovery-required"; readonly detail: string };

const pairReadFailure = (
    result: LiveReadResult,
    side: "subject" | "target",
    context: WorkingContext,
): PairReadResult | undefined => {
    if (result.status === "ok") return undefined;
    check(
        context,
        side === "subject" ? "subject-read" : "target-read",
        result.status === "skipped" ? "failed" : "not-run",
        result.detail,
    );
    return result.status === "skipped"
        ? result
        : { status: "recovery-required", detail: result.detail };
};

const readPair = async (
    client: Octokit,
    repository: string,
    action: RelationshipAction,
    context: WorkingContext,
    signal: AbortSignal | undefined,
): Promise<PairReadResult> => {
    const subjectResult = await readIssue(
        client,
        repository,
        action.issueNumber,
        signal,
    );
    const subjectFailure = pairReadFailure(subjectResult, "subject", context);
    if (subjectFailure !== undefined) return subjectFailure;
    const subject = (subjectResult as Extract<LiveReadResult, { status: "ok" }>)
        .issue;
    check(
        context,
        "subject-read",
        "confirmed",
        `live subject issue #${String(subject.number)} was read`,
    );

    const targetResult = await readIssue(
        client,
        repository,
        action.targetIssueNumber,
        signal,
    );
    const targetFailure = pairReadFailure(targetResult, "target", context);
    if (targetFailure !== undefined) return targetFailure;
    const target = (targetResult as Extract<LiveReadResult, { status: "ok" }>)
        .issue;
    check(
        context,
        "target-read",
        "confirmed",
        `live target issue #${String(target.number)} was read`,
    );
    return { status: "ok", subject, target };
};

const expectedCandidateUrl = (
    candidate: MaintenanceCandidate,
    issueNumber: number,
): string | undefined =>
    candidate.subjectIssueNumber === issueNumber
        ? candidate.subjectUrl
        : candidate.targetIssueNumber === issueNumber
          ? candidate.targetUrl
          : undefined;

const issueMetadataMatchesCandidate = (
    issue: LiveIssue,
    candidate: MaintenanceCandidate,
): boolean => {
    if (issue.number === candidate.subjectIssueNumber) {
        return issue.url === candidate.subjectUrl;
    }
    if (issue.number !== candidate.targetIssueNumber) return true;
    return (
        issue.url === candidate.targetUrl &&
        issue.title === candidate.targetTitle &&
        (candidate.targetCreatedAt.length === 0 ||
            issue.createdAt === candidate.targetCreatedAt)
    );
};

const duplicateReferences = (body: string | null): ReadonlyArray<number> => {
    if (body === null) return [];
    const pattern =
        /\b(?:duplicate(?:d)?|dupe|superseded)\s+(?:of|by|to)\s+#?(\d+)\b/giu;
    const references: number[] = [];
    for (const match of body.matchAll(pattern)) {
        const number = positiveInteger(match[1] ?? "");
        if (number !== undefined) references.push(number);
    }
    return [...new Set(references)].sort((left, right) => left - right);
};

const pairStateFailure = (
    pair: Extract<PairReadResult, { status: "ok" }>,
    action: RelationshipAction,
    candidate: MaintenanceCandidate,
    context: WorkingContext,
): RelationshipMutationResult | undefined => {
    const expectedSubjectUrl = expectedCandidateUrl(
        candidate,
        action.issueNumber,
    );
    if (
        expectedSubjectUrl !== undefined &&
        pair.subject.url !== expectedSubjectUrl
    ) {
        check(
            context,
            "subject-url",
            "failed",
            "live subject URL no longer matches the candidate snapshot",
        );
        return skipped(
            context,
            "pair-changed",
            "live subject issue identity no longer matches the candidate snapshot",
        );
    }
    check(
        context,
        "subject-url",
        "confirmed",
        "live subject URL matches the candidate snapshot",
    );
    if (pair.target.url !== action.targetUrl) {
        check(
            context,
            "target-url",
            "failed",
            "live target URL no longer matches the plan target",
        );
        return skipped(
            context,
            "pair-changed",
            "live target issue identity no longer matches the plan target",
        );
    }
    check(
        context,
        "target-url",
        "confirmed",
        "live target URL matches the plan target",
    );
    if (
        !issueMetadataMatchesCandidate(pair.subject, candidate) ||
        !issueMetadataMatchesCandidate(pair.target, candidate)
    ) {
        check(
            context,
            "candidate-metadata",
            "failed",
            "live title, creation time, or URL no longer matches candidate evidence",
        );
        return skipped(
            context,
            "pair-changed",
            "live relationship pair no longer matches candidate evidence",
        );
    }
    check(
        context,
        "candidate-metadata",
        "confirmed",
        "live relationship pair still matches candidate evidence",
    );
    if (pair.subject.state !== "open" || pair.target.state !== "open") {
        check(
            context,
            "open-state",
            "failed",
            "both relationship issues must remain open",
        );
        return skipped(
            context,
            "pair-closed",
            "relationship pair contains a closed issue; no relationship mutation was attempted",
        );
    }
    check(
        context,
        "open-state",
        "confirmed",
        "both relationship issues are open",
    );
    if (
        action.action !== "link-related" &&
        duplicateReferences(pair.subject.body).includes(pair.target.number) &&
        duplicateReferences(pair.target.body).includes(pair.subject.number)
    ) {
        check(
            context,
            "duplicate-cycle",
            "failed",
            "live issue bodies contain reciprocal duplicate references",
        );
        return skipped(
            context,
            "duplicate-cycle",
            "live duplicate references would form a cycle; no link or close was attempted",
        );
    }
    check(
        context,
        "duplicate-cycle",
        "confirmed",
        "live issue bodies do not contain a reciprocal duplicate reference",
    );
    return undefined;
};

type MarkerDiscovery = {
    readonly matching: ReadonlyArray<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceRelationshipMarker;
    }>;
    readonly malformed: ReadonlyArray<LiveComment>;
    readonly foreign: ReadonlyArray<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceRelationshipMarker;
    }>;
};

type MarkerClassification =
    | { readonly kind: "none" }
    | { readonly kind: "malformed" }
    | {
          readonly kind: "foreign";
          readonly marker: MaintenanceRelationshipMarker;
      }
    | {
          readonly kind: "matching";
          readonly marker: MaintenanceRelationshipMarker;
      };

const classifyMarker = (
    comment: LiveComment,
    issueNumber: number,
    relation: MaintenanceRelationshipKind,
    targetIssueNumber: number,
    pairKey: string,
): MarkerClassification => {
    if (comment.body === null) return { kind: "none" };
    const markers = parseMaintenanceRelationshipMarkers(comment.body);
    relationshipMarkerLikePattern.lastIndex = 0;
    const markerLikeMatches = [
        ...comment.body.matchAll(relationshipMarkerLikePattern),
    ];
    relationshipMarkerLikePattern.lastIndex = 0;
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
    const marker = markers[0] as MaintenanceRelationshipMarker;
    return marker.issueNumber === issueNumber &&
        marker.relation === relation &&
        marker.targetIssueNumber === targetIssueNumber &&
        marker.pairKey === pairKey
        ? { kind: "matching", marker }
        : { kind: "foreign", marker };
};

const discoverMarkers = (
    comments: ReadonlyArray<LiveComment>,
    issueNumber: number,
    relation: MaintenanceRelationshipKind,
    targetIssueNumber: number,
    pairKey: string,
): MarkerDiscovery => {
    const matching: Array<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceRelationshipMarker;
    }> = [];
    const malformed: LiveComment[] = [];
    const foreign: Array<{
        readonly comment: LiveComment;
        readonly marker: MaintenanceRelationshipMarker;
    }> = [];
    for (const comment of comments) {
        const classification = classifyMarker(
            comment,
            issueNumber,
            relation,
            targetIssueNumber,
            pairKey,
        );
        switch (classification.kind) {
            case "matching":
                matching.push({ comment, marker: classification.marker });
                break;
            case "malformed":
                malformed.push(comment);
                break;
            case "foreign":
                foreign.push({ comment, marker: classification.marker });
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

const sameActor = (left: string | undefined, right: string): boolean =>
    left !== undefined &&
    left.trim().length > 0 &&
    normalizeMaintenanceCommentText(left) ===
        normalizeMaintenanceCommentText(right);

const permissionGranted = (value: RecordLike | undefined): boolean =>
    value?.admin === true ||
    value?.maintain === true ||
    value?.push === true ||
    value?.triage === true;

export type LockedPermissionChecker = (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: RecordLike;
    readonly issueNumber: number;
    readonly actorLogin: string;
}) => Promise<boolean>;

export type MaintenanceRelationshipMutationRequest = {
    readonly action: RelationshipAction;
    /** Immutable candidate evidence used to validate the relationship pair. */
    readonly candidate?: MaintenanceCandidate;
    readonly snapshotFingerprint?: string;
    readonly authenticatedActorLogin?: string;
    readonly confirmLockedCommentPermission?: LockedPermissionChecker;
    readonly signal?: AbortSignal;
};

export type IssueMaintenanceRelationshipMutationRequest =
    MaintenanceRelationshipMutationRequest;

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
            detail: "GitHub users.getAuthenticated is unavailable; relationship ownership cannot be confirmed.",
        };
    }
    try {
        const response = await endpoint({ ...requestOptions(signal) });
        const login = text(recordValue(responseData(response), "login")).trim();
        return login.length === 0
            ? {
                  status: "skipped",
                  detail: "GitHub did not return an authenticated relationship actor login.",
              }
            : { status: "ok", login };
    } catch (cause) {
        if (isAbortCause(cause, signal)) throw cause;
        return {
            status: "skipped",
            detail: `authenticated relationship actor lookup failed: ${detailOf(cause)}`,
        };
    }
};

const actorFor = async (
    client: Octokit,
    request: MaintenanceRelationshipMutationRequest,
): Promise<ActorResult> =>
    request.authenticatedActorLogin?.trim()
        ? { status: "ok", login: request.authenticatedActorLogin.trim() }
        : authenticatedActor(client, request.signal);

const readRepositoryPermission = async (
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
    checker: LockedPermissionChecker | undefined,
    signal: AbortSignal | undefined,
): Promise<boolean | undefined> => {
    if (!issue.locked) return true;
    if (checker !== undefined) {
        try {
            return await checker({
                client,
                repository,
                issue: issue.raw,
                issueNumber: issue.number,
                actorLogin,
            });
        } catch (cause) {
            if (isAbortCause(cause, signal)) throw cause;
            return undefined;
        }
    }
    if (permissionGranted(issue.permissions)) return true;
    return readRepositoryPermission(client, repository, signal);
};

type CommentMutationResult =
    | {
          readonly status: "applied";
          readonly mutation: "created" | "updated";
          readonly commentId: number;
          readonly detail: string;
      }
    | {
          readonly status: "unchanged";
          readonly commentId: number;
          readonly detail: string;
      }
    | {
          readonly status: "skipped";
          readonly reason:
              | "marker-malformed"
              | "duplicate-marker"
              | "foreign-marker"
              | "managed-comment-ownership"
              | "human-edited-managed-comment"
              | "human-relationship-conflict";
          readonly detail: string;
      }
    | {
          readonly status: "recovery-required";
          readonly detail: string;
      };

const commentSkip = (
    reason: Extract<CommentMutationResult, { status: "skipped" }>["reason"],
    detail: string,
): CommentMutationResult => ({ status: "skipped", reason, detail });

const commentRecovery = (detail: string): CommentMutationResult => ({
    status: "recovery-required",
    detail,
});

const markerFailure = (
    discovery: MarkerDiscovery,
    relation?: MaintenanceRelationshipKind,
): CommentMutationResult | undefined => {
    if (discovery.matching.length > 1) {
        return commentSkip(
            "duplicate-marker",
            "more than one comment carries the same relationship marker",
        );
    }
    if (discovery.malformed.length > 0) {
        return commentSkip(
            "marker-malformed",
            "a comment contains a malformed or conflicting relationship marker; no comment was overwritten",
        );
    }
    if (
        relation === "duplicate" &&
        discovery.foreign.some((entry) => entry.marker.relation === "duplicate")
    ) {
        return commentSkip(
            "foreign-marker",
            "the issue already has a different managed duplicate relationship; no competing duplicate link was created",
        );
    }
    return undefined;
};

type EnsureRelationshipCommentInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly relation: MaintenanceRelationshipKind;
    readonly pairKey: string;
    readonly desiredBody: string;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
};

const humanRelationshipEquivalent = (
    body: string | null,
    relation: MaintenanceRelationshipKind,
    targetIssueNumber: number,
    desiredBody: string,
): boolean => {
    if (body === null) return false;
    if (parseMaintenanceRelationshipMarker(body) !== undefined) {
        return false;
    }
    const normalizedBody = normalizeMaintenanceCommentText(body);
    const normalizedDesired = normalizeMaintenanceCommentText(
        desiredBody.replace(/<!--.*?-->\n?/su, ""),
    );
    const target = String(targetIssueNumber);
    const mentionsTarget = new RegExp(`(?:^|\\s)${target}(?:$|\\s)`, "u").test(
        normalizedBody,
    );
    const mentionsRelation = normalizedBody.includes(
        relation === "duplicate" ? "duplicate" : "related",
    );
    return mentionsTarget && mentionsRelation
        ? true
        : normalizedBody === normalizedDesired;
};

const reconcileUncertainComment = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly relation: MaintenanceRelationshipKind;
    readonly pairKey: string;
    readonly desiredBody: string;
    readonly actorLogin: string;
    readonly operation: "created" | "updated";
    readonly signal?: AbortSignal;
}): Promise<CommentMutationResult> => {
    const commentsResult = await readComments(
        input.client,
        input.repository,
        input.issue.number,
        input.signal,
    );
    if (commentsResult.status !== "ok") {
        return commentRecovery(
            `${input.operation} response was uncertain and ${commentsResult.detail}`,
        );
    }
    const discovery = discoverMarkers(
        commentsResult.comments,
        input.issue.number,
        input.relation,
        input.target.number,
        input.pairKey,
    );
    if (discovery.matching.length !== 1) {
        return commentRecovery(
            discovery.matching.length === 0
                ? `${input.operation} response was uncertain; no matching relationship marker was found`
                : `${input.operation} response was uncertain; multiple matching relationship markers were found`,
        );
    }
    const matching = discovery
        .matching[0] as (typeof discovery.matching)[number];
    if (!sameActor(matching.comment.authorLogin, input.actorLogin)) {
        return commentRecovery(
            `${input.operation} response was uncertain; the relationship marker is not owned by the authenticated actor`,
        );
    }
    if (
        !maintenanceRelationshipMarkerOwnsBody(
            matching.comment.body,
            matching.marker,
        )
    ) {
        return commentRecovery(
            `${input.operation} response was uncertain; the relationship comment was edited`,
        );
    }
    if (matching.comment.body !== input.desiredBody) {
        return commentRecovery(
            `${input.operation} response was uncertain; the matching relationship marker has a different body`,
        );
    }
    return {
        status: "applied",
        mutation: input.operation,
        commentId: matching.comment.id,
        detail: `${input.operation} was confirmed by authoritative relationship marker discovery`,
    };
};

const updateRelationshipComment = async (
    input: EnsureRelationshipCommentInput,
    existing: {
        readonly comment: LiveComment;
        readonly marker: MaintenanceRelationshipMarker;
    },
): Promise<CommentMutationResult> => {
    if (!sameActor(existing.comment.authorLogin, input.actorLogin)) {
        return commentSkip(
            "managed-comment-ownership",
            "the matching relationship marker is not owned by the authenticated actor",
        );
    }
    if (
        !maintenanceRelationshipMarkerOwnsBody(
            existing.comment.body,
            existing.marker,
        )
    ) {
        return commentSkip(
            "human-edited-managed-comment",
            "the matching relationship comment was edited after Ralphie published it; the human edit is preserved",
        );
    }
    if (existing.comment.body === input.desiredBody) {
        return {
            status: "unchanged",
            commentId: existing.comment.id,
            detail: "the relationship comment already contains the desired body",
        };
    }
    const endpoint = endpointFor(input.client, "issues", "updateComment");
    if (endpoint === undefined) {
        return commentRecovery(
            "GitHub issues.updateComment is unavailable for relationship reconciliation",
        );
    }
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            comment_id: existing.comment.id,
            body: input.desiredBody,
            ...requestOptions(input.signal),
        });
        const data = responseData(response);
        return isRecord(data) && text(data.body) === input.desiredBody
            ? {
                  status: "applied",
                  mutation: "updated",
                  commentId: existing.comment.id,
                  detail: "the Ralphie-managed relationship comment was updated in place",
              }
            : reconcileUncertainComment({
                  ...input,
                  operation: "updated",
              });
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcileUncertainComment({
            ...input,
            operation: "updated",
        });
    }
};

const createRelationshipComment = async (
    input: EnsureRelationshipCommentInput,
): Promise<CommentMutationResult> => {
    const endpoint = endpointFor(input.client, "issues", "createComment");
    if (endpoint === undefined) {
        return commentRecovery(
            "GitHub issues.createComment is unavailable for relationship reconciliation",
        );
    }
    try {
        const response = await endpoint({
            ...repositoryParameters(input.repository),
            issue_number: input.issue.number,
            body: input.desiredBody,
            ...requestOptions(input.signal),
        });
        const data = responseData(response);
        const id = recordValue(data, "id");
        return typeof id === "number" &&
            Number.isSafeInteger(id) &&
            text(recordValue(data, "body")) === input.desiredBody
            ? {
                  status: "applied",
                  mutation: "created",
                  commentId: id,
                  detail: "the relationship comment was created",
              }
            : reconcileUncertainComment({
                  ...input,
                  operation: "created",
              });
    } catch (cause) {
        if (isAbortCause(cause, input.signal)) throw cause;
        return reconcileUncertainComment({
            ...input,
            operation: "created",
        });
    }
};

const ensureRelationshipComment = async (
    input: EnsureRelationshipCommentInput,
): Promise<CommentMutationResult> => {
    const commentsResult = await readComments(
        input.client,
        input.repository,
        input.issue.number,
        input.signal,
    );
    if (commentsResult.status !== "ok") {
        check(
            input.context,
            "marker-discovery",
            "not-run",
            commentsResult.detail,
        );
        return commentRecovery(commentsResult.detail);
    }
    const discovery = discoverMarkers(
        commentsResult.comments,
        input.issue.number,
        input.relation,
        input.target.number,
        input.pairKey,
    );
    const failure = markerFailure(discovery, input.relation);
    if (failure !== undefined) {
        check(input.context, "marker-discovery", "failed", failure.detail);
        return failure;
    }
    check(
        input.context,
        "marker-discovery",
        "confirmed",
        "relationship marker discovery found at most one owned marker and no malformed marker",
    );
    const existing = discovery.matching[0];
    if (existing !== undefined)
        return updateRelationshipComment(input, existing);
    if (
        commentsResult.comments.some((comment) =>
            humanRelationshipEquivalent(
                comment.body,
                input.relation,
                input.target.number,
                input.desiredBody,
            ),
        )
    ) {
        return commentSkip(
            "human-relationship-conflict",
            "an equivalent human-authored relationship exists; it was preserved",
        );
    }
    return createRelationshipComment(input);
};

const commentOutcome = (
    context: WorkingContext,
    result: CommentMutationResult,
    mutation: Extract<
        RelationshipMutationResult,
        { readonly status: "applied" }
    >["mutation"],
    operation: "relationship-comment" | "related-pair" = "relationship-comment",
    completedSides?: ReadonlyArray<RelationshipSide>,
): RelationshipMutationResult => {
    switch (result.status) {
        case "applied":
            return applied(context, mutation, result.detail, {
                commentId: result.commentId,
                completedSides,
            });
        case "unchanged":
            return unchanged(context, result.detail, {
                commentId: result.commentId,
                completedSides,
            });
        case "skipped":
            return completedSides !== undefined && completedSides.length > 0
                ? recovered(
                      context,
                      operation,
                      `the relationship pair is partially reconciled; ${result.detail}`,
                      completedSides,
                  )
                : skipped(context, result.reason, result.detail);
        case "recovery-required":
            return recovered(context, operation, result.detail, completedSides);
    }
};

const relationshipCommentInput = (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: RelationshipAction;
    readonly candidate: MaintenanceCandidate;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly pairKey: string;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): EnsureRelationshipCommentInput => ({
    client: input.client,
    repository: input.repository,
    issue: input.issue,
    target: input.target,
    relation: relationshipFor(input.action),
    pairKey: input.pairKey,
    desiredBody: renderMaintenanceRelationshipComment({
        issueNumber: input.issue.number,
        targetIssueNumber: input.target.number,
        relation: relationshipFor(input.action),
        targetUrl: input.target.url,
        pairKey: input.pairKey,
        candidateId: input.candidate.candidateId,
        snapshotFingerprint: input.candidate.snapshotFingerprint,
        rationale: input.action.rationale,
        evidence: input.candidate.evidence,
    }),
    actorLogin: input.actorLogin,
    context: input.context,
    signal: input.signal,
});

const lockedPermissionFailure = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issues: ReadonlyArray<LiveIssue>;
    readonly actorLogin: string;
    readonly checker: LockedPermissionChecker | undefined;
    readonly signal?: AbortSignal;
    readonly context: WorkingContext;
}): Promise<RelationshipMutationResult | undefined> => {
    const ordered = [...input.issues].sort(
        (left, right) => left.number - right.number,
    );
    for (const issue of ordered) {
        const permitted = await canCommentOnLockedIssue(
            input.client,
            input.repository,
            issue,
            input.actorLogin,
            input.checker,
            input.signal,
        );
        if (permitted === undefined) {
            return skipped(
                input.context,
                "locked-comment-permission-unknown",
                `issue #${String(issue.number)} is locked and GitHub did not confirm that the authenticated actor may comment`,
            );
        }
        if (!permitted) {
            return skipped(
                input.context,
                "locked-comment-not-permitted",
                `issue #${String(issue.number)} is locked and GitHub did not grant the authenticated actor comment permission`,
            );
        }
    }
    return undefined;
};

const ensureDuplicateLink = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<CommentMutationResult> => {
    const pairKey = maintenanceRelationshipPairKey(
        "duplicate",
        input.issue.number,
        input.target.number,
    );
    return ensureRelationshipComment(
        relationshipCommentInput({ ...input, pairKey }),
    );
};

const ensureRelatedSide = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: RelatedAction;
    readonly candidate: MaintenanceCandidate;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<CommentMutationResult> => {
    const pairKey = maintenanceRelationshipPairKey(
        "related",
        input.issue.number,
        input.target.number,
    );
    return ensureRelationshipComment(
        relationshipCommentInput({ ...input, pairKey }),
    );
};

const sideFor = (
    issueNumber: number,
    leftNumber: number,
    rightNumber: number,
): RelationshipSide =>
    issueNumber === Math.min(leftNumber, rightNumber)
        ? "lower-issue"
        : "higher-issue";

const pairFailureOutcome = (
    result: PairReadResult,
    context: WorkingContext,
): RelationshipMutationResult => {
    if (result.status === "recovery-required") {
        return recovered(context, "read-pair", result.detail);
    }
    if (result.status === "skipped") {
        return skipped(context, result.reason, result.detail);
    }
    return recovered(
        context,
        "read-pair",
        "relationship pair read returned an unexpected successful result",
    );
};

const candidatePairFailure = (
    pair: Extract<PairReadResult, { status: "ok" }>,
    action: RelationshipAction,
    candidate: MaintenanceCandidate,
    context: WorkingContext,
): RelationshipMutationResult | undefined =>
    pairStateFailure(pair, action, candidate, context);

type SafePairResult =
    | {
          readonly status: "ok";
          readonly pair: Extract<PairReadResult, { status: "ok" }>;
      }
    | {
          readonly status: "outcome";
          readonly outcome: RelationshipMutationResult;
      };

const readSafePair = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: RelationshipAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<SafePairResult> => {
    const pairResult = await readPair(
        input.client,
        input.repository,
        input.action,
        input.context,
        input.signal,
    );
    if (pairResult.status !== "ok") {
        return {
            status: "outcome",
            outcome: pairFailureOutcome(pairResult, input.context),
        };
    }
    const failure = candidatePairFailure(
        pairResult,
        input.action,
        input.candidate,
        input.context,
    );
    return failure === undefined
        ? { status: "ok", pair: pairResult }
        : { status: "outcome", outcome: failure };
};

const duplicateLinkOutcome = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceRelationshipMutationRequest;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly actorLogin: string;
}): Promise<RelationshipMutationResult> => {
    const pair = await readSafePair({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
    if (pair.status !== "ok") return pair.outcome;
    const pairKey = maintenanceRelationshipPairKey(
        "duplicate",
        pair.pair.subject.number,
        pair.pair.target.number,
    );
    const cycleFailure = await duplicateCycleOutcome({
        client: input.client,
        repository: input.repository,
        issue: pair.pair.subject,
        target: pair.pair.target,
        pairKey,
        context: input.context,
        operation: "relationship-comment",
        signal: input.request.signal,
    });
    if (cycleFailure !== undefined) return cycleFailure;
    const permissionFailure = await lockedPermissionFailure({
        client: input.client,
        repository: input.repository,
        issues: [pair.pair.subject],
        actorLogin: input.actorLogin,
        checker: input.request.confirmLockedCommentPermission,
        signal: input.request.signal,
        context: input.context,
    });
    if (permissionFailure !== undefined) return permissionFailure;
    const comment = await ensureDuplicateLink({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        issue: pair.pair.subject,
        target: pair.pair.target,
        actorLogin: input.actorLogin,
        context: input.context,
        signal: input.request.signal,
    });
    return commentOutcome(input.context, comment, "duplicate-linked");
};

type RelatedSideReconciliation =
    | {
          readonly status: "complete";
          readonly side: RelationshipSide;
          readonly changed: boolean;
      }
    | { readonly status: "stop"; readonly comment: CommentMutationResult };

const reconcileRelatedSide = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: RelatedAction;
    readonly candidate: MaintenanceCandidate;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly pair: Extract<PairReadResult, { status: "ok" }>;
    readonly signal?: AbortSignal;
}): Promise<RelatedSideReconciliation> => {
    const comment = await ensureRelatedSide({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        issue: input.issue,
        target: input.target,
        actorLogin: input.actorLogin,
        context: input.context,
        signal: input.signal,
    });
    if (comment.status === "applied" || comment.status === "unchanged") {
        return {
            status: "complete",
            side: sideFor(
                input.issue.number,
                input.pair.subject.number,
                input.pair.target.number,
            ),
            changed: comment.status === "applied",
        };
    }
    return { status: "stop", comment };
};

const relatedPairOutcome = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceRelationshipMutationRequest;
    readonly action: RelatedAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly actorLogin: string;
}): Promise<RelationshipMutationResult> => {
    const pair = await readSafePair({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
    if (pair.status !== "ok") return pair.outcome;
    const pairResult = pair.pair;
    const permissionFailure = await lockedPermissionFailure({
        client: input.client,
        repository: input.repository,
        issues: [pairResult.subject, pairResult.target],
        actorLogin: input.actorLogin,
        checker: input.request.confirmLockedCommentPermission,
        signal: input.request.signal,
        context: input.context,
    });
    if (permissionFailure !== undefined) return permissionFailure;

    const ordered = [pairResult.subject, pairResult.target].sort(
        (left, right) => left.number - right.number,
    );
    const completedSides: RelationshipSide[] = [];
    let changed = false;
    for (const issue of ordered) {
        const target =
            issue.number === pairResult.subject.number
                ? pairResult.target
                : pairResult.subject;
        const sideResult = await reconcileRelatedSide({
            client: input.client,
            repository: input.repository,
            action: input.action,
            candidate: input.candidate,
            issue,
            target,
            actorLogin: input.actorLogin,
            context: input.context,
            pair: pairResult,
            signal: input.request.signal,
        });
        if (sideResult.status === "complete") {
            changed ||= sideResult.changed;
            completedSides.push(sideResult.side);
            continue;
        }
        const comment = sideResult.comment;
        if (completedSides.length > 0) {
            return commentOutcome(
                input.context,
                comment,
                "related-pair-linked",
                "related-pair",
                completedSides,
            );
        }
        return commentOutcome(
            input.context,
            comment,
            "related-pair-linked",
            "related-pair",
        );
    }
    return changed
        ? applied(
              input.context,
              "related-pair-linked",
              "reciprocal related-issue comments were reconciled in deterministic issue-number order",
              { completedSides },
          )
        : unchanged(
              input.context,
              "reciprocal related-issue comments already match the managed pair",
              { completedSides },
          );
};

const confirmManagedLink = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly actorLogin: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<CommentMutationResult> => {
    const pairKey = maintenanceRelationshipPairKey(
        "duplicate",
        input.issue.number,
        input.target.number,
    );
    const desiredBody = renderMaintenanceRelationshipComment({
        issueNumber: input.issue.number,
        targetIssueNumber: input.target.number,
        relation: "duplicate",
        targetUrl: input.target.url,
        pairKey,
        candidateId: input.candidate.candidateId,
        snapshotFingerprint: input.candidate.snapshotFingerprint,
        rationale: input.action.rationale,
        evidence: input.candidate.evidence,
    });
    const commentsResult = await readComments(
        input.client,
        input.repository,
        input.issue.number,
        input.signal,
    );
    if (commentsResult.status !== "ok") {
        check(
            input.context,
            "marker-discovery",
            "not-run",
            commentsResult.detail,
        );
        return commentRecovery(
            `the managed duplicate link could not be confirmed: ${commentsResult.detail}`,
        );
    }
    const discovery = discoverMarkers(
        commentsResult.comments,
        input.issue.number,
        "duplicate",
        input.target.number,
        pairKey,
    );
    const failure = markerFailure(discovery, "duplicate");
    if (failure !== undefined) {
        check(input.context, "marker-discovery", "failed", failure.detail);
        return failure;
    }
    check(
        input.context,
        "marker-discovery",
        "confirmed",
        "the managed duplicate link was rediscovered immediately before closure",
    );
    const matching = discovery.matching[0];
    if (matching === undefined) {
        return commentRecovery(
            "the managed duplicate link is missing after link reconciliation",
        );
    }
    if (!sameActor(matching.comment.authorLogin, input.actorLogin)) {
        return commentSkip(
            "managed-comment-ownership",
            "the managed duplicate link is no longer owned by the authenticated actor",
        );
    }
    if (
        !maintenanceRelationshipMarkerOwnsBody(
            matching.comment.body,
            matching.marker,
        )
    ) {
        return commentSkip(
            "human-edited-managed-comment",
            "the managed duplicate link was edited after reconciliation; the human edit is preserved",
        );
    }
    if (matching.comment.body !== desiredBody) {
        return commentRecovery(
            "the managed duplicate link body no longer matches the validated action",
        );
    }
    return {
        status: "unchanged",
        commentId: matching.comment.id,
        detail: "the managed duplicate link was confirmed before closure",
    };
};

const confirmNoDuplicateCycle = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly pairKey: string;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<
    | { readonly status: "ok" }
    | {
          readonly status: "skipped";
          readonly reason:
              | "duplicate-cycle"
              | "marker-malformed"
              | "duplicate-marker";
          readonly detail: string;
      }
    | { readonly status: "recovery-required"; readonly detail: string }
> => {
    const commentsResult = await readComments(
        input.client,
        input.repository,
        input.target.number,
        input.signal,
    );
    if (commentsResult.status !== "ok") {
        check(
            input.context,
            "marker-discovery",
            "not-run",
            commentsResult.detail,
        );
        return {
            status: "recovery-required",
            detail: `duplicate-cycle check could not read canonical comments: ${commentsResult.detail}`,
        };
    }
    const discovery = discoverMarkers(
        commentsResult.comments,
        input.target.number,
        "duplicate",
        input.issue.number,
        input.pairKey,
    );
    check(
        input.context,
        "marker-discovery",
        "confirmed",
        "canonical relationship comments were inspected for a reciprocal duplicate marker",
    );
    if (discovery.matching.length > 1) {
        return {
            status: "skipped",
            reason: "duplicate-marker",
            detail: "canonical issue has duplicate managed markers for the duplicate issue",
        };
    }
    if (discovery.malformed.length > 0) {
        return {
            status: "skipped",
            reason: "marker-malformed",
            detail: "canonical issue contains a malformed relationship marker; closure is withheld",
        };
    }
    if (discovery.matching.length > 0) {
        return {
            status: "skipped",
            reason: "duplicate-cycle",
            detail: "canonical issue already carries the reciprocal duplicate marker",
        };
    }
    return { status: "ok" };
};

const duplicateCycleOutcome = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly issue: LiveIssue;
    readonly target: LiveIssue;
    readonly pairKey: string;
    readonly context: WorkingContext;
    readonly operation: "relationship-comment" | "close-duplicate";
    readonly signal?: AbortSignal;
}): Promise<RelationshipMutationResult | undefined> => {
    const cycle = await confirmNoDuplicateCycle(input);
    if (cycle.status === "skipped") {
        check(input.context, "duplicate-cycle", "failed", cycle.detail);
        return skipped(input.context, cycle.reason, cycle.detail);
    }
    if (cycle.status === "recovery-required") {
        return recovered(input.context, input.operation, cycle.detail);
    }
    check(
        input.context,
        "duplicate-cycle",
        "confirmed",
        "canonical comments do not already point back to the duplicate",
    );
    return undefined;
};

const closeStateFor = (
    pair: Extract<PairReadResult, { status: "ok" }>,
    action: DuplicateAction,
    candidate: MaintenanceCandidate,
    context: WorkingContext,
): RelationshipMutationResult | undefined => {
    if (
        pair.subject.url !==
            (expectedCandidateUrl(candidate, action.issueNumber) ??
                pair.subject.url) ||
        pair.target.url !== action.targetUrl ||
        !issueMetadataMatchesCandidate(pair.subject, candidate) ||
        !issueMetadataMatchesCandidate(pair.target, candidate)
    ) {
        check(
            context,
            "candidate-metadata",
            "failed",
            "live pair metadata changed while the close response was uncertain",
        );
        return recovered(
            context,
            "close-duplicate",
            "duplicate closure could not be confirmed because live pair evidence changed",
        );
    }
    if (pair.target.state !== "open") {
        check(
            context,
            "close-state",
            "failed",
            "canonical issue is no longer open",
        );
        return skipped(
            context,
            "pair-closed",
            "canonical issue is no longer open; the duplicate was not closed",
        );
    }
    if (pair.subject.state === "closed") {
        check(
            context,
            "close-state",
            pair.subject.stateReason === "duplicate" ? "confirmed" : "failed",
            `duplicate issue is closed with reason ${pair.subject.stateReason ?? "unknown"}`,
        );
        return pair.subject.stateReason === "duplicate"
            ? applied(
                  context,
                  "duplicate-closed",
                  "duplicate closure was confirmed by authoritative live state",
              )
            : skipped(
                  context,
                  "close-conflict",
                  `duplicate issue is already closed with reason ${pair.subject.stateReason ?? "unknown"}; it was not changed`,
              );
    }
    check(
        context,
        "close-state",
        "not-run",
        "duplicate issue remains open after the uncertain close request",
    );
    return recovered(
        context,
        "close-duplicate",
        "duplicate close response was uncertain and live state still shows the duplicate open; do not retry blindly",
    );
};

const reconcileCloseState = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<RelationshipMutationResult> => {
    const pairResult = await readPair(
        input.client,
        input.repository,
        input.action,
        input.context,
        input.signal,
    );
    if (pairResult.status !== "ok") {
        return recovered(
            input.context,
            "close-duplicate",
            `duplicate close response was uncertain and pair refetch failed: ${pairResult.detail}`,
        );
    }
    return (
        closeStateFor(
            pairResult,
            input.action,
            input.candidate,
            input.context,
        ) ??
        recovered(
            input.context,
            "close-duplicate",
            "duplicate close response could not be reconciled",
        )
    );
};

type PreparedDuplicateLink =
    | {
          readonly status: "ok";
          readonly pair: Extract<PairReadResult, { status: "ok" }>;
      }
    | {
          readonly status: "outcome";
          readonly outcome: RelationshipMutationResult;
      };

const prepareDuplicateLink = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceRelationshipMutationRequest;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly actorLogin: string;
}): Promise<PreparedDuplicateLink> => {
    const pair = await readSafePair({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
    if (pair.status !== "ok")
        return { status: "outcome", outcome: pair.outcome };
    const permissionFailure = await lockedPermissionFailure({
        client: input.client,
        repository: input.repository,
        issues: [pair.pair.subject],
        actorLogin: input.actorLogin,
        checker: input.request.confirmLockedCommentPermission,
        signal: input.request.signal,
        context: input.context,
    });
    if (permissionFailure !== undefined) {
        return { status: "outcome", outcome: permissionFailure };
    }
    const link = await ensureDuplicateLink({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        issue: pair.pair.subject,
        target: pair.pair.target,
        actorLogin: input.actorLogin,
        context: input.context,
        signal: input.request.signal,
    });
    if (link.status === "applied" || link.status === "unchanged") {
        return { status: "ok", pair: pair.pair };
    }
    return link.status === "skipped"
        ? {
              status: "outcome",
              outcome: commentOutcome(input.context, link, "duplicate-linked"),
          }
        : {
              status: "outcome",
              outcome: recovered(
                  input.context,
                  "relationship-comment",
                  `duplicate close is withheld until the link is reconciled: ${link.detail}`,
              ),
          };
};

const preflightDuplicateClose = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly signal?: AbortSignal;
}): Promise<PreparedDuplicateLink> => {
    const pair = await readSafePair({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.signal,
    });
    if (pair.status !== "ok")
        return { status: "outcome", outcome: pair.outcome };
    const pairKey = maintenanceRelationshipPairKey(
        "duplicate",
        pair.pair.subject.number,
        pair.pair.target.number,
    );
    const cycleFailure = await duplicateCycleOutcome({
        client: input.client,
        repository: input.repository,
        issue: pair.pair.subject,
        target: pair.pair.target,
        pairKey,
        context: input.context,
        operation: "close-duplicate",
        signal: input.signal,
    });
    return cycleFailure === undefined
        ? { status: "ok", pair: pair.pair }
        : { status: "outcome", outcome: cycleFailure };
};

const closeDuplicateOutcome = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceRelationshipMutationRequest;
    readonly action: DuplicateAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
    readonly actorLogin: string;
}): Promise<RelationshipMutationResult> => {
    const preflight = await preflightDuplicateClose({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
    if (preflight.status !== "ok") return preflight.outcome;
    const prepared = await prepareDuplicateLink({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        request: input.request,
        actorLogin: input.actorLogin,
    });
    if (prepared.status !== "ok") return prepared.outcome;

    const freshPair = await readSafePair({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
    if (freshPair.status !== "ok") return freshPair.outcome;
    const freshPairResult = freshPair.pair;
    const pairKey = maintenanceRelationshipPairKey(
        "duplicate",
        freshPairResult.subject.number,
        freshPairResult.target.number,
    );
    const cycleFailure = await duplicateCycleOutcome({
        client: input.client,
        repository: input.repository,
        issue: freshPairResult.subject,
        target: freshPairResult.target,
        pairKey,
        context: input.context,
        operation: "close-duplicate",
        signal: input.request.signal,
    });
    if (cycleFailure !== undefined) return cycleFailure;
    const linkConfirmation = await confirmManagedLink({
        client: input.client,
        repository: input.repository,
        issue: freshPairResult.subject,
        target: freshPairResult.target,
        action: input.action,
        candidate: input.candidate,
        actorLogin: input.actorLogin,
        context: input.context,
        signal: input.request.signal,
    });
    if (linkConfirmation.status === "skipped") {
        return commentOutcome(
            input.context,
            linkConfirmation,
            "duplicate-linked",
        );
    }
    if (linkConfirmation.status === "recovery-required") {
        return recovered(
            input.context,
            "relationship-comment",
            `duplicate close is withheld until the link is confirmed: ${linkConfirmation.detail}`,
        );
    }
    check(
        input.context,
        "marker-ownership",
        "confirmed",
        "the duplicate link marker and body are still owned by the authenticated actor",
    );
    const labelResult = await ensureDuplicateLabel({
        client: input.client,
        repository: input.repository,
        issue: freshPairResult.subject,
        context: input.context,
        signal: input.request.signal,
    });
    if (labelResult.status === "outcome") return labelResult.outcome;
    const endpoint = endpointFor(input.client, "issues", "update");
    if (endpoint === undefined) {
        return recovered(
            input.context,
            "close-duplicate",
            "GitHub issues.update is unavailable for the duplicate closure",
        );
    }
    try {
        await endpoint({
            ...repositoryParameters(input.repository),
            issue_number: freshPairResult.subject.number,
            state: "closed",
            state_reason: "duplicate",
            ...requestOptions(input.request.signal),
        });
    } catch (cause) {
        if (isAbortCause(cause, input.request.signal)) throw cause;
        return reconcileCloseState({
            client: input.client,
            repository: input.repository,
            action: input.action,
            candidate: input.candidate,
            context: input.context,
            signal: input.request.signal,
        });
    }
    return reconcileCloseState({
        client: input.client,
        repository: input.repository,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        signal: input.request.signal,
    });
};

const isRelationshipAction = (
    action: IssueMaintenanceAction,
): action is RelationshipAction =>
    action.action === "link-duplicate" ||
    action.action === "close-duplicate" ||
    action.action === "link-related";

const candidateValidationOutcome = (
    context: WorkingContext,
    validation: CandidateValidation,
): RelationshipMutationResult | undefined => {
    if (validation.status === "ok") {
        check(
            context,
            "candidate",
            "confirmed",
            "candidate identity, kind, eligibility, and fingerprint match the action",
        );
        return undefined;
    }
    check(context, "candidate", "failed", validation.detail);
    return skipped(context, validation.reason, validation.detail);
};

export type GitHubIssueMaintenanceRelationshipService = {
    /** Reconcile one validated duplicate or related-issue action. */
    readonly reconcile: (
        client: Octokit,
        repository: string,
        request: MaintenanceRelationshipMutationRequest,
    ) => Promise<RelationshipMutationResult>;
};

export type IssueMaintenanceRelationshipService =
    GitHubIssueMaintenanceRelationshipService;
export type MaintenanceRelationshipPolicyService =
    GitHubIssueMaintenanceRelationshipService;

const unsupportedTarget = (action: IssueMaintenanceAction): number =>
    "targetIssueNumber" in action &&
    typeof action.targetIssueNumber === "number"
        ? action.targetIssueNumber
        : 0;

const repositoryValidationFailure = (
    repository: string,
): string | undefined => {
    try {
        repositoryParameters(repository);
        return undefined;
    } catch (cause) {
        return `invalid GitHub repository: ${detailOf(cause)}`;
    }
};

const reconcileValidatedRelationshipAction = async (input: {
    readonly client: Octokit;
    readonly repository: string;
    readonly request: MaintenanceRelationshipMutationRequest;
    readonly action: RelationshipAction;
    readonly candidate: MaintenanceCandidate;
    readonly context: WorkingContext;
}): Promise<RelationshipMutationResult> => {
    const actor = await actorFor(input.client, input.request);
    if (actor.status !== "ok") {
        return skipped(
            input.context,
            "authenticated-actor-unavailable",
            actor.detail,
        );
    }
    if (input.action.action === "link-related") {
        return relatedPairOutcome({
            client: input.client,
            repository: input.repository,
            request: input.request,
            action: input.action,
            candidate: input.candidate,
            context: input.context,
            actorLogin: actor.login,
        });
    }
    if (input.action.action === "close-duplicate") {
        return closeDuplicateOutcome({
            client: input.client,
            repository: input.repository,
            request: input.request,
            action: input.action,
            candidate: input.candidate,
            context: input.context,
            actorLogin: actor.login,
        });
    }
    return duplicateLinkOutcome({
        client: input.client,
        repository: input.repository,
        request: input.request,
        action: input.action,
        candidate: input.candidate,
        context: input.context,
        actorLogin: actor.login,
    });
};

/** Create the mutation adapter for duplicate and reciprocal relationship policy. */
export const makeGitHubIssueMaintenanceRelationshipService =
    (): GitHubIssueMaintenanceRelationshipService => ({
        reconcile: async (client, repository, request) => {
            throwIfAborted(request.signal);
            const parsed = issueMaintenanceActionSchema.safeParse(
                request.action,
            );
            if (!parsed.success) {
                const context = contextFor("relationship:invalid", 0, 0);
                return skipped(
                    context,
                    "invalid-action",
                    "relationship action failed schema validation",
                );
            }
            const action = parsed.data;
            const actionKey = maintenanceActionKey(action);
            const context = contextFor(
                actionKey,
                action.issueNumber,
                unsupportedTarget(action),
            );
            if (!isRelationshipAction(action)) {
                return skipped(
                    context,
                    "unsupported-action",
                    "only link-duplicate, close-duplicate, and link-related actions belong to this relationship policy adapter",
                );
            }
            const repositoryFailure = repositoryValidationFailure(repository);
            if (repositoryFailure !== undefined) {
                return skipped(
                    context,
                    "invalid-repository",
                    repositoryFailure,
                );
            }
            const validation = validateCandidate(
                action,
                request.candidate,
                request.snapshotFingerprint,
            );
            const candidate =
                validation.status === "ok" ? validation.candidate : undefined;
            const candidateContext = contextFor(
                actionKey,
                action.issueNumber,
                action.targetIssueNumber,
                candidate,
            );
            const candidateFailure = candidateValidationOutcome(
                candidateContext,
                validation,
            );
            if (candidateFailure !== undefined) return candidateFailure;
            return reconcileValidatedRelationshipAction({
                client,
                repository,
                request,
                action,
                candidate: candidate as MaintenanceCandidate,
                context: candidateContext,
            });
        },
    });

export const makeIssueMaintenanceRelationshipService =
    makeGitHubIssueMaintenanceRelationshipService;
export const makeGitHubMaintenanceRelationshipService =
    makeGitHubIssueMaintenanceRelationshipService;
export const makeMaintenanceRelationshipPolicyService =
    makeGitHubIssueMaintenanceRelationshipService;
export const GitHubIssueMaintenanceRelationshipsLive =
    makeGitHubIssueMaintenanceRelationshipService;
export const MaintenanceRelationshipPolicyLive =
    makeGitHubIssueMaintenanceRelationshipService;