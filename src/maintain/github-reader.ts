/**
 * Composed, read-only maintenance snapshot reader.
 *
 * A single invocation performs one list phase and one selected-detail phase.
 * It never delegates to the small issue-queue service and exposes only the
 * GET-backed records needed by maintenance planning. Hard diagnostics reject
 * the operation; unavailable records are retained as typed skips by the
 * detail collector.
 */
import type { Octokit } from "octokit";

import { IssueOrder, IssueSort } from "../github/issues.ts";
import {
    collectMaintainReaderDetails,
    type MaintainReaderDetailOptions,
    type MaintainReaderDetails,
} from "./github-reader/details.ts";
import {
    collectMaintainReaderLists,
    type MaintainableIssueSummary,
    type MaintainReaderLists,
    type MaintainRepositoryIdentity,
} from "./github-reader/lists.ts";
import { throwIfAborted } from "./github-reader/diagnostics.ts";
import type {
    MaintainableIssue,
    MaintainableLabel,
    MaintainableSkip,
} from "../maintain-issues-snapshot.ts";

export type MaintainSelectionInput = {
    readonly maxIssues?: number;
    readonly issueLabels?: ReadonlyArray<string>;
    readonly issueSort?: IssueSort;
    readonly issueOrder?: IssueOrder;
};

export type MaintainReaderSelection = MaintainSelectionInput;

const DEFAULT_SELECTION: Required<
    Pick<MaintainSelectionInput, "issueLabels" | "issueSort" | "issueOrder">
> = {
    issueLabels: [],
    issueSort: IssueSort.Created,
    issueOrder: IssueOrder.Ascending,
};

const normalizedSelection = (
    input: MaintainSelectionInput = {},
): MaintainSelectionInput => {
    if (
        input.maxIssues !== undefined &&
        (!Number.isSafeInteger(input.maxIssues) || input.maxIssues < 0)
    ) {
        throw new RangeError("maxIssues must be a non-negative integer.");
    }
    return Object.freeze({
        ...(input.maxIssues === undefined
            ? {}
            : { maxIssues: input.maxIssues }),
        issueLabels: Object.freeze([
            ...(input.issueLabels ?? DEFAULT_SELECTION.issueLabels),
        ]),
        issueSort: input.issueSort ?? DEFAULT_SELECTION.issueSort,
        issueOrder: input.issueOrder ?? DEFAULT_SELECTION.issueOrder,
    });
};

const labelMatches = (
    summary: MaintainableIssueSummary,
    labels: ReadonlyArray<string>,
): boolean => {
    if (labels.length === 0) return true;
    const available = new Set(
        summary.labels.map((label) => label.name.toLowerCase()),
    );
    return labels.every((label) => available.has(label.toLowerCase()));
};

const sortValue = (
    summary: MaintainableIssueSummary,
    sort: IssueSort,
): string | number => {
    if (sort === IssueSort.Comments) return summary.commentCount;
    if (sort === IssueSort.Updated) return summary.updatedAt;
    return summary.createdAt;
};

const compareSummaries = (
    left: MaintainableIssueSummary,
    right: MaintainableIssueSummary,
    selection: MaintainSelectionInput,
): number => {
    const sort = selection.issueSort ?? DEFAULT_SELECTION.issueSort;
    const order = selection.issueOrder ?? DEFAULT_SELECTION.issueOrder;
    const leftValue = sortValue(left, sort);
    const rightValue = sortValue(right, sort);
    const valueComparison =
        leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    if (valueComparison !== 0)
        return order === IssueOrder.Descending
            ? -valueComparison
            : valueComparison;
    return left.number - right.number;
};

export const selectMaintainableIssueNumbers = (
    summaries: ReadonlyArray<MaintainableIssueSummary>,
    selection: MaintainSelectionInput = {},
): ReadonlyArray<number> => {
    const normalized = normalizedSelection(selection);
    const selected = summaries
        .filter((summary) =>
            labelMatches(summary, normalized.issueLabels ?? []),
        )
        .filter((summary) => summary.isOpen)
        .sort((left, right) => compareSummaries(left, right, normalized));
    const capped =
        normalized.maxIssues === undefined
            ? selected
            : selected.slice(0, normalized.maxIssues);
    return Object.freeze(capped.map((summary) => summary.number));
};

export const selectMaintainableIssues = selectMaintainableIssueNumbers;

export type MaintainableSnapshot = {
    readonly repository: MaintainRepositoryIdentity;
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly openIssueSummaries: ReadonlyArray<MaintainableIssueSummary>;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly selectedDetails: ReadonlyArray<
        MaintainReaderDetails["details"][number]
    >;
    readonly selectedIssues: ReadonlyArray<MaintainableIssue>;
    readonly skips: ReadonlyArray<MaintainableSkip>;
    readonly selection: MaintainSelectionInput;
};

export type MaintainableMaintenanceSnapshot = MaintainableSnapshot;
export type MaintainSnapshot = MaintainableSnapshot;

const assembleSnapshot = (
    lists: MaintainReaderLists,
    details: MaintainReaderDetails,
    selection: MaintainSelectionInput,
    selectedIssueNumbers: ReadonlyArray<number>,
): MaintainableSnapshot =>
    Object.freeze({
        repository: lists.repository,
        labels: lists.labels,
        openIssueSummaries: lists.openIssueSummaries,
        selectedIssueNumbers,
        selectedDetails: details.details,
        selectedIssues: details.issues,
        skips: details.skips,
        selection,
    });

/** Execute one complete list → selected detail/comment snapshot operation. */
export const loadMaintainabilitySnapshot = async (
    client: Octokit,
    repository: string,
    selection: MaintainSelectionInput = {},
    signal?: AbortSignal,
    detailOptions: MaintainReaderDetailOptions = {},
): Promise<MaintainableSnapshot> => {
    const normalized = normalizedSelection(selection);
    const lists = await collectMaintainReaderLists(client, repository, signal);
    throwIfAborted(signal);
    const selectedIssueNumbers = selectMaintainableIssueNumbers(
        lists.openIssueSummaries,
        normalized,
    );
    const details = await collectMaintainReaderDetails(
        client,
        repository,
        selectedIssueNumbers,
        signal,
        detailOptions,
    );
    throwIfAborted(signal);
    return assembleSnapshot(lists, details, normalized, selectedIssueNumbers);
};

export const collectMaintainabilitySnapshot = loadMaintainabilitySnapshot;
export const loadMaintainableSnapshot = loadMaintainabilitySnapshot;
export const readMaintainabilitySnapshot = loadMaintainabilitySnapshot;