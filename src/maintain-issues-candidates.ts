/**
 * Pure duplicate and related-issue candidate analysis.
 *
 * This module consumes an immutable maintenance snapshot and produces
 * deterministic evidence for a later planner. Similarity is never a mutation
 * decision: uncertain candidates are explicitly non-actionable, duplicate
 * pairs carry a canonical-selection/revalidation result, and self-links or
 * directed cycles are reported before any mutation layer can see them.
 */
import type {
    MaintainableIssue,
    MaintainableLabel,
} from "./maintain-issues-snapshot.ts";
import type { MaintenanceSnapshot } from "./maintain-issues-snapshot-service.ts";

const MAX_TITLE_LENGTH = 512;
const MAX_BODY_LENGTH = 16_000;
const MAX_EVIDENCE_TERMS = 8;
const DEFAULT_CANDIDATE_LIMIT = 20;

const STOP_WORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "but",
    "can",
    "for",
    "from",
    "have",
    "into",
    "issue",
    "just",
    "more",
    "not",
    "of",
    "our",
    "that",
    "the",
    "this",
    "with",
]);

const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

const compareNumber = (left: number, right: number): number =>
    left < right ? -1 : left > right ? 1 : 0;

const boundedText = (value: unknown, limit: number): string =>
    typeof value === "string" ? value.slice(0, limit) : "";

const normalizeTitleValue = (value: string): string =>
    value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");

/** Normalize a title for deterministic exact and near-title comparisons. */
export const normalizeMaintenanceTitle = (value: string): string =>
    normalizeTitleValue(boundedText(value, MAX_TITLE_LENGTH));

export const normalizeCandidateTitle = normalizeMaintenanceTitle;

const tokensFor = (value: string): ReadonlyArray<string> => {
    const tokens = new Set<string>();
    for (const token of normalizeTitleValue(value).split(" ")) {
        if (token.length < 3 || STOP_WORDS.has(token) || tokens.has(token)) {
            continue;
        }
        tokens.add(token);
    }
    return [...tokens].sort(compareText);
};

const intersection = (
    left: ReadonlyArray<string>,
    right: ReadonlyArray<string>,
): ReadonlyArray<string> => {
    const rightSet = new Set(right);
    return left.filter((token) => rightSet.has(token));
};

const titleSimilarity = (
    left: string,
    right: string,
): {
    readonly exact: boolean;
    readonly near: boolean;
    readonly score: number;
} => {
    const normalizedLeft = normalizeMaintenanceTitle(left);
    const normalizedRight = normalizeMaintenanceTitle(right);
    if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
        return { exact: false, near: false, score: 0 };
    }
    if (normalizedLeft === normalizedRight) {
        return { exact: true, near: true, score: 100 };
    }
    const leftTokens = tokensFor(normalizedLeft);
    const rightTokens = tokensFor(normalizedRight);
    const shared = intersection(leftTokens, rightTokens).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const score = union === 0 ? 0 : Math.floor((shared * 100) / union);
    return {
        exact: false,
        near:
            score >= 50 ||
            (shared >= 2 &&
                (normalizedLeft.includes(normalizedRight) ||
                    normalizedRight.includes(normalizedLeft))),
        score,
    };
};

const labelsFor = (
    labels: ReadonlyArray<MaintainableLabel>,
): ReadonlyArray<string> =>
    [
        ...new Set(
            labels
                .map((label) => label.name.trim().toLocaleLowerCase("en-US"))
                .filter((label) => label.length > 0),
        ),
    ].sort(compareText);

const sharedLabels = (
    left: ReadonlyArray<MaintainableLabel>,
    right: ReadonlyArray<MaintainableLabel>,
): ReadonlyArray<string> => intersection(labelsFor(left), labelsFor(right));

const bodyTerms = (body: string | null): ReadonlyArray<string> =>
    tokensFor(boundedText(body, MAX_BODY_LENGTH));

const sharedBodyTerms = (
    left: string | null,
    right: string | null,
): ReadonlyArray<string> =>
    intersection(bodyTerms(left), bodyTerms(right)).slice(
        0,
        MAX_EVIDENCE_TERMS,
    );

const issueNumberFromText = (value: string): number | undefined => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

type ExplicitReferenceKind = "duplicate" | "canonical" | "related";

type ExplicitReference = {
    readonly kind: ExplicitReferenceKind;
    readonly issueNumber: number;
};

const referencePatterns: ReadonlyArray<{
    readonly kind: ExplicitReferenceKind;
    readonly pattern: RegExp;
}> = [
    {
        kind: "duplicate",
        pattern:
            /\b(?:duplicate(?:d)?|dupe|superseded)\s+(?:of|by|to)\s+#?(\d+)\b/giu,
    },
    {
        kind: "canonical",
        pattern: /\bcanonical(?:\s+issue)?\s*[:#]?\s*#?(\d+)\b/giu,
    },
    {
        kind: "related",
        pattern: /\b(?:related|see|tracks?)\s+(?:to|issue)?\s*#(\d+)\b/giu,
    },
];

const explicitReferences = (
    body: string | null,
): ReadonlyArray<ExplicitReference> => {
    if (body === null || body.length === 0) return Object.freeze([]);
    const references: ExplicitReference[] = [];
    const bounded = boundedText(body, MAX_BODY_LENGTH);
    for (const { kind, pattern } of referencePatterns) {
        pattern.lastIndex = 0;
        for (const match of bounded.matchAll(pattern)) {
            const issueNumber = issueNumberFromText(match[1] ?? "");
            if (issueNumber !== undefined)
                references.push({ kind, issueNumber });
        }
        pattern.lastIndex = 0;
    }
    const unique = new Map<string, ExplicitReference>();
    for (const reference of references) {
        const key = `${reference.kind}:${String(reference.issueNumber)}`;
        if (!unique.has(key)) unique.set(key, reference);
    }
    return Object.freeze(
        [...unique.values()].sort(
            (left, right) =>
                compareText(left.kind, right.kind) ||
                compareNumber(left.issueNumber, right.issueNumber),
        ),
    );
};

const referencesOfKind = (
    references: ReadonlyArray<ExplicitReference>,
    kind: ExplicitReferenceKind,
): ReadonlyArray<number> =>
    references
        .filter((reference) => reference.kind === kind)
        .map((reference) => reference.issueNumber);

export type MaintenanceCandidateKind = "duplicate" | "related" | "uncertain";

export type MaintenanceCandidateEvidenceKind =
    | "exact-title"
    | "near-title"
    | "shared-label"
    | "shared-body-term"
    | "explicit-duplicate"
    | "explicit-canonical"
    | "explicit-related";

export type MaintenanceCandidateEvidence = {
    readonly kind: MaintenanceCandidateEvidenceKind;
    readonly detail: string;
    readonly value: string | null;
};

export type MaintenanceCandidateSkipReason =
    | "subject-missing"
    | "subject-inaccessible"
    | "subject-not-open"
    | "candidate-inaccessible"
    | "candidate-not-open"
    | "self-link"
    | "duplicate-cycle"
    | "canonical-target-missing"
    | "canonical-target-closed"
    | "canonical-target-inaccessible"
    | "canonical-target-changed"
    | "ambiguous-canonical";

export type MaintenanceCandidateSkip = {
    readonly reason: MaintenanceCandidateSkipReason;
    readonly issueNumber: number | null;
    readonly detail: string;
};

export type MaintenanceCanonicalSelection =
    | {
          readonly status: "resolved";
          readonly issueNumber: number;
          readonly source: "explicit" | "oldest-open";
      }
    | {
          readonly status: "revalidate";
          readonly issueNumber: number | null;
          readonly reason:
              | "canonical-target-missing"
              | "canonical-target-closed"
              | "canonical-target-inaccessible"
              | "canonical-target-changed"
              | "duplicate-cycle"
              | "ambiguous-canonical";
          readonly detail: string;
      }
    | {
          readonly status: "skip";
          readonly issueNumber: number;
          readonly reason:
              | "self-link"
              | "candidate-inaccessible"
              | "candidate-not-open";
          readonly detail: string;
      };

export type MaintenanceCandidate = {
    /** Stable directed pair key; it never depends on object identity. */
    readonly pairId: string;
    readonly candidateId: string;
    readonly subjectIssueNumber: number;
    readonly subjectUrl: string;
    readonly targetIssueNumber: number;
    readonly targetUrl: string;
    readonly targetTitle: string;
    readonly targetCreatedAt: string;
    readonly kind: MaintenanceCandidateKind;
    /** Deterministic evidence score, not a model confidence value. */
    readonly evidenceScore: number;
    readonly evidence: ReadonlyArray<MaintenanceCandidateEvidence>;
    readonly canonical: MaintenanceCanonicalSelection | undefined;
    /** False for uncertain/revalidation/skip outcomes. */
    readonly mutationEligible: boolean;
    readonly snapshotFingerprint: string;
};

export type MaintenanceCandidateAnalysis = {
    readonly status: "analyzed" | "skipped";
    readonly subjectIssueNumber: number;
    readonly snapshotFingerprint: string;
    readonly candidates: ReadonlyArray<MaintenanceCandidate>;
    readonly skips: ReadonlyArray<MaintenanceCandidateSkip>;
};

export type MaintenanceCandidateAnalysisOptions = {
    /** Maximum number of returned candidates across all kinds. */
    readonly maxCandidates?: number;
    readonly limit?: number;
};

export type MaintenanceCandidateService = {
    readonly analyze: (
        input: MaintenanceCandidateAnalysisInput,
    ) => MaintenanceCandidateAnalysis;
};

export type MaintenanceCandidateAnalysisInput = {
    readonly snapshot: MaintenanceSnapshot;
    readonly subjectIssueNumber: number;
    readonly options?: MaintenanceCandidateAnalysisOptions;
};

type ComparableIssue = {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly url: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly labels: ReadonlyArray<MaintainableLabel>;
    readonly open: boolean;
    readonly accessible: boolean;
    readonly references: ReadonlyArray<ExplicitReference>;
};

type SnapshotIssueIndex = {
    readonly byNumber: ReadonlyMap<number, ComparableIssue>;
    readonly summaries: ReadonlyMap<number, ComparableIssue>;
    readonly details: ReadonlyArray<ComparableIssue>;
    readonly detailsByNumber: ReadonlyMap<number, ComparableIssue>;
};

const issueFromDetail = (issue: MaintainableIssue): ComparableIssue => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labels: issue.labels,
    open: issue.state === "open" && issue.isOpen,
    accessible:
        issue.availability.kind === "available" && issue.skip === undefined,
    references: explicitReferences(issue.body),
});

const issueFromSummary = (
    summary: MaintenanceSnapshot["openIssueSummaries"][number],
): ComparableIssue => ({
    number: summary.number,
    title: summary.title,
    body: null,
    url: summary.url,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    labels: summary.labels,
    open: summary.state === "open" && summary.isOpen,
    accessible: true,
    references: Object.freeze([]),
});

const snapshotIssueIndex = (
    snapshot: MaintenanceSnapshot,
): SnapshotIssueIndex => {
    const byNumber = new Map<number, ComparableIssue>();
    const summaries = [...snapshot.openIssueSummaries].map(issueFromSummary);
    for (const summary of summaries) byNumber.set(summary.number, summary);
    const details = snapshot.selectedIssues.map(issueFromDetail);
    for (const detail of details) byNumber.set(detail.number, detail);
    return {
        byNumber,
        summaries: new Map(
            summaries.map((summary) => [summary.number, summary]),
        ),
        details: Object.freeze(details),
        detailsByNumber: new Map(
            details.map((detail) => [detail.number, detail]),
        ),
    };
};

const issueKey = (subject: number, target: number): string =>
    `issue:${String(subject)}->${String(target)}`;

const evidence = (
    kind: MaintenanceCandidateEvidenceKind,
    detail: string,
    value: string | null = null,
): MaintenanceCandidateEvidence => Object.freeze({ kind, detail, value });

type CandidateEvidenceMatch = {
    readonly kind: MaintenanceCandidateKind;
    readonly score: number;
    readonly evidence: ReadonlyArray<MaintenanceCandidateEvidence>;
    readonly subjectReferences: ReadonlyArray<ExplicitReference>;
    readonly targetReferences: ReadonlyArray<ExplicitReference>;
};

type PairEvidenceSignals = {
    readonly explicitDuplicate: boolean;
    readonly explicitCanonical: boolean;
    readonly explicitRelated: boolean;
};

const pairReferenceSignals = (
    subject: ComparableIssue,
    target: ComparableIssue,
): PairEvidenceSignals => {
    const subjectDuplicates = referencesOfKind(subject.references, "duplicate");
    const targetDuplicates = referencesOfKind(target.references, "duplicate");
    const subjectCanonical = referencesOfKind(subject.references, "canonical");
    const targetCanonical = referencesOfKind(target.references, "canonical");
    const subjectRelated = referencesOfKind(subject.references, "related");
    const targetRelated = referencesOfKind(target.references, "related");
    return {
        explicitDuplicate:
            subjectDuplicates.includes(target.number) ||
            targetDuplicates.includes(subject.number),
        explicitCanonical:
            subjectCanonical.includes(target.number) ||
            targetCanonical.includes(subject.number),
        explicitRelated:
            subjectRelated.includes(target.number) ||
            targetRelated.includes(subject.number),
    };
};

const titleEvidence = (
    title: ReturnType<typeof titleSimilarity>,
): {
    readonly score: number;
    readonly items: ReadonlyArray<MaintenanceCandidateEvidence>;
} => {
    if (title.exact) {
        return {
            score: title.score + 100,
            items: Object.freeze([
                evidence("exact-title", "normalized titles are identical"),
            ]),
        };
    }
    if (!title.near) return { score: title.score, items: Object.freeze([]) };
    return {
        score: title.score,
        items: Object.freeze([
            evidence(
                "near-title",
                "normalized titles share deterministic token evidence",
                String(title.score),
            ),
        ]),
    };
};

const contextEvidence = (
    shared: ReadonlyArray<string>,
    body: ReadonlyArray<string>,
): {
    readonly score: number;
    readonly items: ReadonlyArray<MaintenanceCandidateEvidence>;
} => {
    const items: MaintenanceCandidateEvidence[] = [];
    let score = 0;
    if (shared.length > 0) {
        items.push(
            evidence(
                "shared-label",
                "issues share repository labels",
                shared.slice(0, MAX_EVIDENCE_TERMS).join(","),
            ),
        );
        score += Math.min(shared.length, MAX_EVIDENCE_TERMS) * 5;
    }
    if (body.length > 0) {
        items.push(
            evidence(
                "shared-body-term",
                "issue bodies share distinctive bounded terms",
                body.join(","),
            ),
        );
        score += Math.min(body.length, MAX_EVIDENCE_TERMS) * 8;
    }
    return { score, items: Object.freeze(items) };
};

const explicitEvidence = (
    signals: PairEvidenceSignals,
): {
    readonly score: number;
    readonly items: ReadonlyArray<MaintenanceCandidateEvidence>;
} => {
    const items: MaintenanceCandidateEvidence[] = [];
    let score = 0;
    if (signals.explicitDuplicate) {
        items.push(
            evidence(
                "explicit-duplicate",
                "an issue body explicitly names this duplicate pair",
            ),
        );
        score += 100;
    }
    if (signals.explicitCanonical) {
        items.push(
            evidence(
                "explicit-canonical",
                "an issue body explicitly names the canonical pair",
            ),
        );
        score += 90;
    }
    if (signals.explicitRelated) {
        items.push(
            evidence(
                "explicit-related",
                "an issue body explicitly names a related pair",
            ),
        );
        score += 40;
    }
    return { score, items: Object.freeze(items) };
};

const candidateKind = (
    title: ReturnType<typeof titleSimilarity>,
    shared: ReadonlyArray<string>,
    body: ReadonlyArray<string>,
    signals: PairEvidenceSignals,
): MaintenanceCandidateKind => {
    const duplicate =
        title.exact ||
        signals.explicitDuplicate ||
        signals.explicitCanonical ||
        (title.near && body.length >= 2);
    if (duplicate) return "duplicate";
    if (signals.explicitRelated || shared.length > 0 || body.length > 0) {
        return "related";
    }
    return "uncertain";
};

const candidateEvidence = (
    subject: ComparableIssue,
    target: ComparableIssue,
): CandidateEvidenceMatch | undefined => {
    const title = titleSimilarity(subject.title, target.title);
    const shared = sharedLabels(subject.labels, target.labels);
    const body = sharedBodyTerms(subject.body, target.body);
    const subjectReferences = subject.references;
    const targetReferences = target.references;
    const signals = pairReferenceSignals(subject, target);
    if (
        !title.near &&
        !signals.explicitDuplicate &&
        !signals.explicitCanonical &&
        !signals.explicitRelated
    ) {
        return undefined;
    }
    const titlePart = titleEvidence(title);
    const contextPart = contextEvidence(shared, body);
    const explicitPart = explicitEvidence(signals);
    return {
        kind: candidateKind(title, shared, body, signals),
        score: titlePart.score + contextPart.score + explicitPart.score,
        evidence: Object.freeze([
            ...titlePart.items,
            ...contextPart.items,
            ...explicitPart.items,
        ]),
        subjectReferences,
        targetReferences,
    };
};

const duplicateEdges = (
    index: SnapshotIssueIndex,
): ReadonlyMap<number, ReadonlyArray<number>> => {
    const edges = new Map<number, ReadonlyArray<number>>();
    for (const issue of index.details) {
        const targets = referencesOfKind(issue.references, "duplicate");
        edges.set(
            issue.number,
            Object.freeze([...new Set(targets)].sort(compareNumber)),
        );
    }
    return edges;
};

const pathFrom = (
    edges: ReadonlyMap<number, ReadonlyArray<number>>,
    start: number,
    target: number,
): ReadonlyArray<number> | undefined => {
    const queue: Array<ReadonlyArray<number>> = [[start]];
    const visited = new Set<number>();
    while (queue.length > 0) {
        const path = queue.shift() as ReadonlyArray<number>;
        const current = path[path.length - 1] as number;
        if (current === target) return path;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const next of edges.get(current) ?? []) {
            queue.push([...path, next]);
        }
    }
    return undefined;
};

const hasDuplicateCycle = (
    edges: ReadonlyMap<number, ReadonlyArray<number>>,
    left: number,
    right: number,
): boolean =>
    pathFrom(edges, left, right) !== undefined &&
    pathFrom(edges, right, left) !== undefined;

const candidateSkip = (
    reason: MaintenanceCandidateSkipReason,
    detail: string,
    issueNumber: number | null,
): MaintenanceCandidateSkip => Object.freeze({ reason, detail, issueNumber });

const compareCreatedAt = (
    left: ComparableIssue,
    right: ComparableIssue,
): number => {
    if (left.createdAt.length === 0 && right.createdAt.length > 0) return 1;
    if (left.createdAt.length > 0 && right.createdAt.length === 0) return -1;
    return (
        compareText(left.createdAt, right.createdAt) ||
        compareNumber(left.number, right.number)
    );
};

const metadataChanged = (
    detail: ComparableIssue,
    summary: ComparableIssue,
): boolean =>
    detail.number !== summary.number ||
    detail.title !== summary.title ||
    detail.url !== summary.url ||
    detail.createdAt !== summary.createdAt ||
    detail.updatedAt !== summary.updatedAt ||
    detail.open !== summary.open;

type ExplicitCanonicalSelection =
    | { readonly status: "none" }
    | { readonly status: "ambiguous" }
    | { readonly status: "target"; readonly issueNumber: number };

const canonicalReferences = (issue: ComparableIssue): ReadonlyArray<number> => [
    ...referencesOfKind(issue.references, "duplicate"),
    ...referencesOfKind(issue.references, "canonical"),
];

const explicitCanonicalForPair = (
    subject: ComparableIssue,
    target: ComparableIssue,
): ExplicitCanonicalSelection => {
    const unique = [
        ...new Set([
            ...canonicalReferences(subject),
            ...canonicalReferences(target),
        ]),
    ].sort(compareNumber);
    if (unique.length === 0) return { status: "none" };
    if (unique.length > 1) return { status: "ambiguous" };
    return {
        status: "target",
        issueNumber: unique[0] as number,
    };
};

const canonicalTargetRevalidation = (
    canonicalNumber: number,
    index: SnapshotIssueIndex,
): MaintenanceCanonicalSelection | undefined => {
    const canonical = index.byNumber.get(canonicalNumber);
    if (canonical === undefined) {
        return {
            status: "revalidate",
            issueNumber: canonicalNumber,
            reason: "canonical-target-missing",
            detail: `explicit canonical target #${String(canonicalNumber)} is absent from the snapshot`,
        };
    }
    if (!canonical.accessible) {
        return {
            status: "revalidate",
            issueNumber: canonicalNumber,
            reason: "canonical-target-inaccessible",
            detail: `explicit canonical target #${String(canonicalNumber)} is inaccessible or skipped`,
        };
    }
    if (!canonical.open) {
        return {
            status: "revalidate",
            issueNumber: canonicalNumber,
            reason: "canonical-target-closed",
            detail: `explicit canonical target #${String(canonicalNumber)} is not open`,
        };
    }
    const canonicalSummary = index.summaries.get(canonicalNumber);
    const canonicalDetail = index.detailsByNumber.get(canonicalNumber);
    if (
        canonicalSummary !== undefined &&
        canonicalDetail !== undefined &&
        metadataChanged(canonicalDetail, canonicalSummary)
    ) {
        return {
            status: "revalidate",
            issueNumber: canonicalNumber,
            reason: "canonical-target-changed",
            detail: `explicit canonical target #${String(canonicalNumber)} changed between summary and detail reads`,
        };
    }
    return undefined;
};

const resolveCanonical = (
    subject: ComparableIssue,
    target: ComparableIssue,
    index: SnapshotIssueIndex,
    edges: ReadonlyMap<number, ReadonlyArray<number>>,
): MaintenanceCanonicalSelection => {
    if (subject.number === target.number) {
        return {
            status: "skip",
            issueNumber: subject.number,
            reason: "self-link",
            detail: "candidate pair points to the subject issue itself",
        };
    }
    const selfLink = [subject, target].find((issue) =>
        canonicalReferences(issue).includes(issue.number),
    );
    if (selfLink !== undefined) {
        return {
            status: "skip",
            issueNumber: selfLink.number,
            reason: "self-link",
            detail: `issue #${String(selfLink.number)} explicitly references itself as a duplicate or canonical target`,
        };
    }
    if (hasDuplicateCycle(edges, subject.number, target.number)) {
        return {
            status: "revalidate",
            issueNumber: null,
            reason: "duplicate-cycle",
            detail: `duplicate references form a directed cycle between #${String(subject.number)} and #${String(target.number)}`,
        };
    }
    const explicit = explicitCanonicalForPair(subject, target);
    if (explicit.status === "ambiguous") {
        return {
            status: "revalidate",
            issueNumber: null,
            reason: "ambiguous-canonical",
            detail: "explicit canonical information does not identify exactly one canonical target",
        };
    }
    if (explicit.status === "target") {
        return (
            canonicalTargetRevalidation(explicit.issueNumber, index) ?? {
                status: "resolved",
                issueNumber: explicit.issueNumber,
                source: "explicit",
            }
        );
    }
    if (!subject.open || !target.open) {
        return {
            status: "skip",
            issueNumber: !subject.open ? subject.number : target.number,
            reason: "candidate-not-open",
            detail: "duplicate canonical selection requires both issues to be open",
        };
    }
    return {
        status: "resolved",
        issueNumber:
            compareCreatedAt(subject, target) <= 0
                ? subject.number
                : target.number,
        source: "oldest-open",
    };
};

const canonicalSortKey = (candidate: MaintenanceCandidate): string =>
    `${candidate.kind}:${String(100_000 - candidate.evidenceScore)}:${String(candidate.targetIssueNumber).padStart(12, "0")}:${candidate.pairId}`;

const compareCandidates = (
    left: MaintenanceCandidate,
    right: MaintenanceCandidate,
): number => {
    const kindRank: Record<MaintenanceCandidateKind, number> = {
        duplicate: 0,
        related: 1,
        uncertain: 2,
    };
    return (
        compareNumber(kindRank[left.kind], kindRank[right.kind]) ||
        compareNumber(right.evidenceScore, left.evidenceScore) ||
        compareNumber(left.targetIssueNumber, right.targetIssueNumber) ||
        compareText(canonicalSortKey(left), canonicalSortKey(right))
    );
};

const validateLimit = (value: number | undefined): number => {
    const limit = value ?? DEFAULT_CANDIDATE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError("maxCandidates must be a non-negative integer.");
    }
    return limit;
};

const deduplicateSkips = (
    skips: ReadonlyArray<MaintenanceCandidateSkip>,
): ReadonlyArray<MaintenanceCandidateSkip> => {
    const unique = new Map<string, MaintenanceCandidateSkip>();
    for (const skip of skips) {
        const key = `${skip.reason}:${String(skip.issueNumber)}:${skip.detail}`;
        if (!unique.has(key)) unique.set(key, skip);
    }
    return Object.freeze(
        [...unique.values()].sort(
            (left, right) =>
                compareText(left.reason, right.reason) ||
                compareNumber(left.issueNumber ?? 0, right.issueNumber ?? 0) ||
                compareText(left.detail, right.detail),
        ),
    );
};

const selfLinkSkips = (
    index: SnapshotIssueIndex,
): ReadonlyArray<MaintenanceCandidateSkip> =>
    index.details
        .filter((issue) => canonicalReferences(issue).includes(issue.number))
        .map((issue) =>
            candidateSkip(
                "self-link",
                `issue #${String(issue.number)} explicitly references itself as a duplicate or canonical target`,
                issue.number,
            ),
        );

const skippedSubjectAnalysis = (
    subjectIssueNumber: number,
    fingerprint: string,
    reason: "subject-missing" | "subject-inaccessible" | "subject-not-open",
    detail: string,
): MaintenanceCandidateAnalysis =>
    Object.freeze({
        status: "skipped",
        subjectIssueNumber,
        snapshotFingerprint: fingerprint,
        candidates: Object.freeze([]),
        skips: Object.freeze([
            candidateSkip(reason, detail, subjectIssueNumber),
        ]),
    });

type SubjectCheck =
    | { readonly subject: ComparableIssue }
    | { readonly analysis: MaintenanceCandidateAnalysis };

const checkSubject = (
    subject: ComparableIssue | undefined,
    subjectIssueNumber: number,
    fingerprint: string,
): SubjectCheck => {
    if (subject === undefined) {
        return {
            analysis: skippedSubjectAnalysis(
                subjectIssueNumber,
                fingerprint,
                "subject-missing",
                `subject issue #${String(subjectIssueNumber)} is absent from the snapshot`,
            ),
        };
    }
    if (!subject.accessible) {
        return {
            analysis: skippedSubjectAnalysis(
                subjectIssueNumber,
                fingerprint,
                "subject-inaccessible",
                `subject issue #${String(subjectIssueNumber)} is inaccessible or skipped`,
            ),
        };
    }
    if (!subject.open) {
        return {
            analysis: skippedSubjectAnalysis(
                subjectIssueNumber,
                fingerprint,
                "subject-not-open",
                `subject issue #${String(subjectIssueNumber)} is not open`,
            ),
        };
    }
    return { subject };
};

const canonicalSkips = (
    canonical: MaintenanceCanonicalSelection | undefined,
): ReadonlyArray<MaintenanceCandidateSkip> => {
    if (canonical === undefined || canonical.status === "resolved") {
        return Object.freeze([]);
    }
    return Object.freeze([
        candidateSkip(
            canonical.reason,
            canonical.detail,
            canonical.issueNumber,
        ),
    ]);
};

const makeCandidate = (
    subject: ComparableIssue,
    target: ComparableIssue,
    match: CandidateEvidenceMatch,
    canonical: MaintenanceCanonicalSelection | undefined,
    fingerprint: string,
): MaintenanceCandidate => {
    const pairId = issueKey(subject.number, target.number);
    return Object.freeze({
        pairId,
        candidateId: pairId,
        subjectIssueNumber: subject.number,
        subjectUrl: subject.url,
        targetIssueNumber: target.number,
        targetUrl: target.url,
        targetTitle: target.title,
        targetCreatedAt: target.createdAt,
        kind: match.kind,
        evidenceScore: match.score,
        evidence: match.evidence,
        canonical,
        mutationEligible:
            match.kind !== "uncertain" &&
            (canonical === undefined || canonical.status === "resolved"),
        snapshotFingerprint: fingerprint,
    });
};

type TargetAnalysis = {
    readonly candidate: MaintenanceCandidate | undefined;
    readonly skips: ReadonlyArray<MaintenanceCandidateSkip>;
};

const analyzeTarget = (
    subject: ComparableIssue,
    target: ComparableIssue,
    index: SnapshotIssueIndex,
    edges: ReadonlyMap<number, ReadonlyArray<number>>,
    fingerprint: string,
): TargetAnalysis => {
    if (target.number === subject.number) {
        return { candidate: undefined, skips: Object.freeze([]) };
    }
    if (!target.accessible) {
        return {
            candidate: undefined,
            skips: Object.freeze([
                candidateSkip(
                    "candidate-inaccessible",
                    `candidate issue #${String(target.number)} is inaccessible or skipped`,
                    target.number,
                ),
            ]),
        };
    }
    if (!target.open) {
        return {
            candidate: undefined,
            skips: Object.freeze([
                candidateSkip(
                    "candidate-not-open",
                    `candidate issue #${String(target.number)} is not open`,
                    target.number,
                ),
            ]),
        };
    }
    const match = candidateEvidence(subject, target);
    if (match === undefined) {
        return { candidate: undefined, skips: Object.freeze([]) };
    }
    const canonical =
        match.kind === "duplicate"
            ? resolveCanonical(subject, target, index, edges)
            : undefined;
    return {
        candidate: makeCandidate(
            subject,
            target,
            match,
            canonical,
            fingerprint,
        ),
        skips: canonicalSkips(canonical),
    };
};

const analyzeSnapshot = (
    input: MaintenanceCandidateAnalysisInput,
): MaintenanceCandidateAnalysis => {
    const { snapshot, subjectIssueNumber } = input;
    const fingerprint = snapshot.fingerprint;
    const index = snapshotIssueIndex(snapshot);
    const subjectCheck = checkSubject(
        index.byNumber.get(subjectIssueNumber),
        subjectIssueNumber,
        fingerprint,
    );
    if ("analysis" in subjectCheck) return subjectCheck.analysis;
    const { subject } = subjectCheck;
    const edges = duplicateEdges(index);
    const skips: MaintenanceCandidateSkip[] = [...selfLinkSkips(index)];
    const candidates: MaintenanceCandidate[] = [];
    for (const target of index.byNumber.values()) {
        const result = analyzeTarget(
            subject,
            target,
            index,
            edges,
            fingerprint,
        );
        skips.push(...result.skips);
        if (result.candidate !== undefined) {
            candidates.push(result.candidate);
        }
    }
    candidates.sort(compareCandidates);
    const limit = validateLimit(
        input.options?.maxCandidates ?? input.options?.limit,
    );
    return Object.freeze({
        status: "analyzed",
        subjectIssueNumber,
        snapshotFingerprint: fingerprint,
        candidates: Object.freeze(candidates.slice(0, limit)),
        skips: deduplicateSkips(skips),
    });
};

/** Analyze one subject issue without OpenCode, Git, GitHub, or mutation services. */
export const analyzeMaintenanceCandidates = (
    snapshot: MaintenanceSnapshot,
    subjectIssueNumber: number,
    options: MaintenanceCandidateAnalysisOptions = {},
): MaintenanceCandidateAnalysis =>
    analyzeSnapshot({ snapshot, subjectIssueNumber, options });

export const findMaintenanceCandidates = analyzeMaintenanceCandidates;
export const analyzeIssueCandidates = analyzeMaintenanceCandidates;

export const makeMaintenanceCandidateService =
    (): MaintenanceCandidateService => ({
        analyze: analyzeSnapshot,
    });

export const makeMaintainIssuesCandidateService =
    makeMaintenanceCandidateService;
export const MaintenanceCandidateAnalysisLive =
    makeMaintenanceCandidateService();