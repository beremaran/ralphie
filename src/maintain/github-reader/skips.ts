/**
 * Record-level skip classification for the maintenance GitHub reader.
 *
 * This boundary is intentionally narrower than transport diagnostics. A
 * missing, transferred, deleted, or permission-inaccessible record can be
 * retained in a maintenance snapshot as a typed skip. Rate limits and
 * pagination/envelope failures are operation failures instead: they are
 * rethrown (or wrapped) as `MaintainGitHubReaderDiagnosticError` and can never
 * be downgraded to a skip.
 */
import {
    isMaintainReaderRateLimited,
    MaintainGitHubReaderDiagnosticError,
} from "./diagnostics.ts";
import {
    createMaintainableIssue,
    createMaintainableSkip,
    type MaintainableIssue,
    type MaintainableIssueInput,
    type MaintainableSkipReason,
    type MaintainableSkip,
} from "../../maintain-issues-snapshot.ts";

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const statusFrom = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const responseStatus = isRecord(value.response)
        ? value.response.status
        : undefined;
    const status = responseStatus ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const causeMessage = (cause: unknown): string => {
    if (cause instanceof Error && cause.message.trim().length > 0)
        return cause.message;
    if (typeof cause === "string" && cause.trim().length > 0) return cause;
    if (cause === undefined) return "record is unavailable";
    try {
        return String(cause);
    } catch {
        return "record is unavailable";
    }
};

const detailFor = (cause: unknown, fallback: string): string => {
    const status = statusFrom(cause);
    const message = causeMessage(cause);
    return status === undefined
        ? `${fallback}: ${message}`
        : `${fallback} (HTTP ${String(status)}): ${message}`;
};

const skip = (
    reason: MaintainableSkipReason,
    detail: string,
    issueNumber: number,
): MaintainableSkip => {
    const result = createMaintainableSkip({ reason, detail, issueNumber });
    // The arguments are fixed by this module, so the contract creator cannot
    // reject them. Keep a defensive failure for future contract changes.
    if (result === undefined)
        throw new Error("Could not create a maintenance record skip.");
    return result;
};

const diagnosticForHardFailure = (
    cause: unknown,
    issueNumber: number,
    repository: string,
    kind: "rate limit" | "pagination",
): MaintainGitHubReaderDiagnosticError =>
    new MaintainGitHubReaderDiagnosticError({
        repository,
        endpoint: `repos/{owner}/{repo}/issues/${String(issueNumber)}`,
        message: `${kind} failure cannot be classified as a record skip: ${causeMessage(cause)}`,
        cause,
    });

/**
 * Pagination failures that already crossed the diagnostics boundary are
 * identifiable by type. Raw errors from adapters may carry one of the
 * explicit flags/codes below; a conservative message check covers simple
 * test doubles without treating ordinary 404/403 messages as pagination.
 */
export const isMaintainReaderPaginationFailure = (cause: unknown): boolean => {
    if (!isRecord(cause)) {
        return cause instanceof Error && /pagination/i.test(cause.message);
    }
    if (
        cause.paginationFailure === true ||
        cause.pagination === true ||
        cause.code === "PAGINATION_FAILURE" ||
        cause.code === "ERR_PAGINATION"
    ) {
        return true;
    }
    return cause instanceof Error && /pagination/i.test(cause.message);
};

export const isPullRequestRecord = (value: unknown): boolean =>
    isRecord(value) && hasOwn(value, "pull_request");

/** Classify a pull-request-shaped REST record before issue mapping. */
export const classifyPullRequestRecord = (
    value: unknown,
    issueNumber: number,
): MaintainableSkip | undefined =>
    isPullRequestRecord(value)
        ? skip(
              "unavailable",
              "REST record is a pull request, not an issue; it was skipped.",
              issueNumber,
          )
        : undefined;

/**
 * Classify a record-level failure. HTTP 301 means the issue was transferred,
 * 410 means it was deleted, and permission-style 403/404 responses are
 * inaccessible. Other non-hard failures remain explicitly unavailable.
 */
export const classifyRecordUnavailable = (
    cause: unknown,
    issueNumber: number,
    repository = "unknown/unknown",
): MaintainableSkip => {
    if (cause instanceof MaintainGitHubReaderDiagnosticError) throw cause;
    if (isMaintainReaderRateLimited(cause))
        throw diagnosticForHardFailure(
            cause,
            issueNumber,
            repository,
            "rate limit",
        );
    if (isMaintainReaderPaginationFailure(cause))
        throw diagnosticForHardFailure(
            cause,
            issueNumber,
            repository,
            "pagination",
        );

    const status = statusFrom(cause);
    if (status === 301)
        return skip(
            "transferred",
            detailFor(cause, "record was transferred"),
            issueNumber,
        );
    if (status === 410)
        return skip(
            "deleted",
            detailFor(cause, "record was deleted"),
            issueNumber,
        );
    if (status === 403 || status === 404)
        return skip(
            "inaccessible",
            detailFor(cause, "record is permission-inaccessible"),
            issueNumber,
        );
    return skip(
        "unavailable",
        detailFor(cause, "record is unavailable"),
        issueNumber,
    );
};

export const classifyMaintainableRecordUnavailable = classifyRecordUnavailable;
export const classifyMaintenanceRecordUnavailable = classifyRecordUnavailable;

/**
 * Classify a detail payload before it reaches `createMaintainableIssue`.
 * Presence of `pull_request` is significant even when its value is null or
 * undefined; the REST list/detail contract uses the key to distinguish PRs.
 */
export const classifyRecord = (
    value: unknown,
    issueNumber: number,
    repository = "unknown/unknown",
): MaintainableSkip | undefined =>
    classifyPullRequestRecord(value, issueNumber) ??
    (isRecord(value)
        ? undefined
        : classifyRecordUnavailable(value, issueNumber, repository));

export const classifyMaintainableRecord = classifyRecord;

/** Map an arbitrary issue-shaped record without throwing on null/unknown fields. */
export const mapMaintainableIssueRecord = (
    value: unknown,
    issueNumber?: number,
): MaintainableIssue => {
    const input = (isRecord(value) ? value : {}) as MaintainableIssueInput;
    return createMaintainableIssue({
        ...input,
        ...(issueNumber === undefined ? {} : { number: issueNumber }),
        ...(isRecord(value) && value.author === null ? { author: null } : {}),
    });
};

export const mapRecordToMaintainableIssue = mapMaintainableIssueRecord;