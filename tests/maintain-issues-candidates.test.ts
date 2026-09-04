import { describe, expect, test } from "bun:test";

import {
    analyzeMaintenanceCandidates,
    makeMaintenanceCandidateService,
    normalizeMaintenanceTitle,
} from "../src/maintain-issues-candidates.ts";
import type { MaintenanceSnapshot } from "../src/maintain-issues-snapshot-service.ts";
import {
    createMaintainableIssue,
    type MaintainableIssue,
    type MaintainableLabel,
} from "../src/maintain-issues-snapshot.ts";
import type { MaintainableIssueSummary } from "../src/maintain/github-reader/lists.ts";

type IssueSpec = {
    readonly number: number;
    readonly title: string;
    readonly body?: string | null;
    readonly state?: "open" | "closed";
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly labels?: ReadonlyArray<string>;
    readonly accessible?: boolean;
};

const labelsFor = (
    labels: ReadonlyArray<string> = [],
): ReadonlyArray<MaintainableLabel> =>
    labels.map((name) => ({ name, description: null, color: null }));

const issueUrl = (number: number): string =>
    `https://github.com/owner/repository/issues/${String(number)}`;

const makeIssue = ({
    number,
    title,
    body = null,
    state = "open",
    createdAt = `2026-01-${String((number % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt = "2026-09-05T00:00:00.000Z",
    labels = [],
    accessible = true,
}: IssueSpec): MaintainableIssue =>
    createMaintainableIssue({
        number,
        nodeId: `I_${String(number)}`,
        title,
        body,
        url: issueUrl(number),
        state,
        labels: labelsFor(labels),
        createdAt,
        updatedAt,
        selectedThread: { comments: [] },
        availability: accessible
            ? { kind: "available", reason: null, detail: null }
            : {
                  kind: "unavailable",
                  reason: "inaccessible",
                  detail: "fixture denies issue detail access",
              },
    });

const makeSummary = ({
    number,
    title,
    state = "open",
    createdAt = `2026-01-${String((number % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt = "2026-09-05T00:00:00.000Z",
    labels = [],
}: IssueSpec): MaintainableIssueSummary =>
    ({
        number,
        nodeId: `I_${String(number)}`,
        title,
        url: issueUrl(number),
        htmlUrl: issueUrl(number),
        labels: labelsFor(labels),
        author: null,
        createdAt,
        updatedAt,
        commentCount: 0,
        state,
        isOpen: state === "open",
        raw: Object.freeze({}),
    }) as MaintainableIssueSummary;

const makeSnapshot = (
    selectedIssues: ReadonlyArray<MaintainableIssue>,
    openIssueSummaries: ReadonlyArray<MaintainableIssueSummary> = selectedIssues.map(
        (issue) =>
            makeSummary({
                number: issue.number,
                title: issue.title,
                state: issue.state === "open" ? "open" : "closed",
                createdAt: issue.createdAt,
                updatedAt: issue.updatedAt,
                labels: issue.labels.map((label) => label.name),
            }),
    ),
    fingerprint = "snapshot-fingerprint",
): MaintenanceSnapshot =>
    ({
        fingerprint,
        openIssueSummaries,
        selectedIssues,
    }) as unknown as MaintenanceSnapshot;

const candidateFor = (
    analysis: ReturnType<typeof analyzeMaintenanceCandidates>,
    issueNumber: number,
) =>
    analysis.candidates.find(
        (candidate) => candidate.targetIssueNumber === issueNumber,
    );

describe("maintenance candidate analysis", () => {
    test("normalizes titles and distinguishes exact, related, and uncertain evidence", () => {
        const subject = makeIssue({
            number: 1,
            title: " Database—Connection  TIMEOUT ",
            body: "The connection pool timed out in staging.",
            labels: ["Backend"],
        });
        const summaries = [
            makeSummary({
                number: 1,
                title: subject.title,
                labels: ["Backend"],
            }),
            makeSummary({
                number: 2,
                title: "database connection timeout",
                labels: ["Backend"],
            }),
            makeSummary({
                number: 3,
                title: "database timeout diagnostics",
                labels: ["Backend"],
            }),
            makeSummary({ number: 4, title: "database timeout" }),
            makeSummary({ number: 5, title: "unrelated deployment" }),
        ];

        expect(normalizeMaintenanceTitle(subject.title)).toBe(
            "database connection timeout",
        );
        const analysis = analyzeMaintenanceCandidates(
            makeSnapshot([subject], summaries),
            1,
        );

        expect(analysis.status).toBe("analyzed");
        expect(
            analysis.candidates.map((candidate) => candidate.targetIssueNumber),
        ).toEqual([2, 3, 4]);
        expect(candidateFor(analysis, 2)).toMatchObject({
            kind: "duplicate",
            mutationEligible: true,
        });
        expect(
            candidateFor(analysis, 2)?.evidence.map((item) => item.kind),
        ).toContain("exact-title");
        expect(candidateFor(analysis, 3)).toMatchObject({
            kind: "related",
            mutationEligible: true,
        });
        expect(candidateFor(analysis, 4)).toMatchObject({
            kind: "uncertain",
            mutationEligible: false,
        });
        expect(analysis.candidates).not.toContainEqual(
            expect.objectContaining({ targetIssueNumber: 1 }),
        );
        expect(analysis.candidates).not.toContainEqual(
            expect.objectContaining({ targetIssueNumber: 5 }),
        );
    });

    test("keeps an explicit related reference useful even when titles are not similar", () => {
        const subject = makeIssue({
            number: 10,
            title: "Payments timeout",
            body: "This remains related to #11.",
        });
        const analysis = analyzeMaintenanceCandidates(
            makeSnapshot(
                [subject],
                [
                    makeSummary({ number: 10, title: subject.title }),
                    makeSummary({ number: 11, title: "Billing migration" }),
                ],
            ),
            10,
        );

        expect(analysis.candidates).toHaveLength(1);
        expect(analysis.candidates[0]).toMatchObject({
            targetIssueNumber: 11,
            kind: "related",
            mutationEligible: true,
        });
        expect(analysis.candidates[0]?.evidence).toContainEqual(
            expect.objectContaining({ kind: "explicit-related" }),
        );
    });

    test("selects canonical issues by creation time and tie-breaks by issue number", () => {
        const subject = makeIssue({
            number: 20,
            title: "Service timeout",
            createdAt: "2026-01-02T00:00:00.000Z",
        });
        const summaries = [
            makeSummary({
                number: 20,
                title: subject.title,
                createdAt: subject.createdAt,
            }),
            makeSummary({
                number: 19,
                title: subject.title,
                createdAt: subject.createdAt,
            }),
            makeSummary({
                number: 21,
                title: subject.title,
                createdAt: "2026-01-03T00:00:00.000Z",
            }),
        ];
        const snapshot = makeSnapshot([subject], summaries, "fingerprint-20");
        const first = analyzeMaintenanceCandidates(snapshot, 20, {
            maxCandidates: 2,
        });
        const second = analyzeMaintenanceCandidates(snapshot, 20, {
            maxCandidates: 2,
        });

        expect(
            first.candidates.map((candidate) => candidate.targetIssueNumber),
        ).toEqual([19, 21]);
        expect(
            first.candidates.map((candidate) => candidate.canonical),
        ).toEqual([
            {
                status: "resolved",
                issueNumber: 19,
                source: "oldest-open",
            },
            {
                status: "resolved",
                issueNumber: 20,
                source: "oldest-open",
            },
        ]);
        expect(JSON.stringify(first.candidates)).toBe(
            JSON.stringify(second.candidates),
        );
        expect(first.candidates[0]?.pairId).toBe("issue:20->19");
        expect(first.candidates[0]?.candidateId).toBe("issue:20->19");
        expect(first.candidates[0]?.snapshotFingerprint).toBe("fingerprint-20");
    });

    test("honors an explicit canonical target over age", () => {
        const subject = makeIssue({
            number: 30,
            title: "API failure",
            body: "Duplicate of #32; canonical issue: #32.",
            createdAt: "2026-01-03T00:00:00.000Z",
        });
        const candidate = makeSummary({
            number: 31,
            title: subject.title,
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const canonical = makeSummary({
            number: 32,
            title: "Stable API failure",
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const analysis = analyzeMaintenanceCandidates(
            makeSnapshot(
                [subject],
                [
                    makeSummary({ number: 30, title: subject.title }),
                    candidate,
                    canonical,
                ],
            ),
            30,
        );

        expect(candidateFor(analysis, 31)?.canonical).toEqual({
            status: "resolved",
            issueNumber: 32,
            source: "explicit",
        });
        expect(candidateFor(analysis, 31)?.mutationEligible).toBe(true);
    });

    test("reports self-links and directed duplicate cycles as non-actionable", () => {
        const subject = makeIssue({
            number: 40,
            title: "Cyclic duplicate",
            body: "Duplicate of #41.",
        });
        const target = makeIssue({
            number: 41,
            title: subject.title,
            body: "Duplicate of #40.",
        });
        const selfLink = makeIssue({
            number: 42,
            title: "Self link",
            body: "Duplicate of #42.",
        });
        const analysis = analyzeMaintenanceCandidates(
            makeSnapshot(
                [subject, target, selfLink],
                [
                    makeSummary({ number: 40, title: subject.title }),
                    makeSummary({ number: 41, title: target.title }),
                    makeSummary({ number: 42, title: selfLink.title }),
                ],
            ),
            40,
        );

        expect(candidateFor(analysis, 41)).toMatchObject({
            kind: "duplicate",
            mutationEligible: false,
            canonical: {
                status: "revalidate",
                reason: "duplicate-cycle",
            },
        });
        expect(analysis.skips).toContainEqual(
            expect.objectContaining({ reason: "self-link", issueNumber: 42 }),
        );
        expect(analysis.skips).toContainEqual(
            expect.objectContaining({ reason: "duplicate-cycle" }),
        );
    });

    test("revalidates missing, closed, inaccessible, changed, and ambiguous canonical targets", () => {
        const missingSubject = makeIssue({
            number: 50,
            title: "Missing canonical",
            body: "Canonical issue: #59.",
        });
        const missing = analyzeMaintenanceCandidates(
            makeSnapshot(
                [missingSubject],
                [
                    makeSummary({ number: 50, title: missingSubject.title }),
                    makeSummary({ number: 51, title: missingSubject.title }),
                ],
            ),
            50,
        );
        expect(candidateFor(missing, 51)?.canonical).toMatchObject({
            status: "revalidate",
            issueNumber: 59,
            reason: "canonical-target-missing",
        });

        const closedSubject = makeIssue({
            number: 60,
            title: "Closed canonical",
            body: "Duplicate of #69.",
        });
        const closed = analyzeMaintenanceCandidates(
            makeSnapshot(
                [closedSubject],
                [
                    makeSummary({ number: 60, title: closedSubject.title }),
                    makeSummary({ number: 61, title: closedSubject.title }),
                    makeSummary({
                        number: 69,
                        title: "Closed canonical target",
                        state: "closed",
                    }),
                ],
            ),
            60,
        );
        expect(candidateFor(closed, 61)?.canonical).toMatchObject({
            status: "revalidate",
            issueNumber: 69,
            reason: "canonical-target-closed",
        });

        const inaccessibleSubject = makeIssue({
            number: 70,
            title: "Inaccessible canonical",
            body: "Canonical issue: #79.",
        });
        const inaccessibleTarget = makeIssue({
            number: 79,
            title: "Inaccessible canonical target",
            accessible: false,
        });
        const inaccessible = analyzeMaintenanceCandidates(
            makeSnapshot(
                [inaccessibleSubject, inaccessibleTarget],
                [
                    makeSummary({
                        number: 70,
                        title: inaccessibleSubject.title,
                    }),
                    makeSummary({
                        number: 71,
                        title: inaccessibleSubject.title,
                    }),
                    makeSummary({
                        number: 79,
                        title: inaccessibleTarget.title,
                    }),
                ],
            ),
            70,
        );
        expect(candidateFor(inaccessible, 71)?.canonical).toMatchObject({
            status: "revalidate",
            issueNumber: 79,
            reason: "canonical-target-inaccessible",
        });

        const changedSubject = makeIssue({
            number: 80,
            title: "Changed canonical",
            body: "Canonical issue: #89.",
        });
        const changedDetail = makeIssue({
            number: 89,
            title: "Canonical source",
            updatedAt: "2026-09-05T00:00:01.000Z",
        });
        const changed = analyzeMaintenanceCandidates(
            makeSnapshot(
                [changedSubject, changedDetail],
                [
                    makeSummary({ number: 80, title: changedSubject.title }),
                    makeSummary({ number: 81, title: changedSubject.title }),
                    makeSummary({
                        number: 89,
                        title: changedDetail.title,
                        updatedAt: "2026-09-04T00:00:00.000Z",
                    }),
                ],
            ),
            80,
        );
        expect(candidateFor(changed, 81)?.canonical).toMatchObject({
            status: "revalidate",
            issueNumber: 89,
            reason: "canonical-target-changed",
        });

        const ambiguousSubject = makeIssue({
            number: 90,
            title: "Ambiguous canonical",
            body: "Duplicate of #91 and duplicate of #92.",
        });
        const ambiguous = analyzeMaintenanceCandidates(
            makeSnapshot(
                [ambiguousSubject],
                [
                    makeSummary({ number: 90, title: ambiguousSubject.title }),
                    makeSummary({ number: 91, title: ambiguousSubject.title }),
                    makeSummary({ number: 92, title: "Another canonical" }),
                ],
            ),
            90,
        );
        expect(candidateFor(ambiguous, 91)?.canonical).toMatchObject({
            status: "revalidate",
            reason: "ambiguous-canonical",
        });
        expect(
            ambiguous.candidates.every(
                (candidate) => !candidate.mutationEligible,
            ),
        ).toBe(true);
    });

    test("excludes non-open and inaccessible candidate records", () => {
        const subject = makeIssue({ number: 100, title: "Access boundary" });
        const inaccessible = makeIssue({
            number: 101,
            title: subject.title,
            accessible: false,
        });
        const closed = makeSummary({
            number: 102,
            title: subject.title,
            state: "closed",
        });
        const analysis = analyzeMaintenanceCandidates(
            makeSnapshot(
                [subject, inaccessible],
                [
                    makeSummary({ number: 100, title: subject.title }),
                    makeSummary({ number: 101, title: subject.title }),
                    closed,
                ],
            ),
            100,
        );

        expect(analysis.candidates).toHaveLength(0);
        expect(analysis.skips).toContainEqual(
            expect.objectContaining({
                reason: "candidate-inaccessible",
                issueNumber: 101,
            }),
        );
        expect(analysis.skips).toContainEqual(
            expect.objectContaining({
                reason: "candidate-not-open",
                issueNumber: 102,
            }),
        );
    });

    test("returns a typed skip when the subject is absent, inaccessible, or closed", () => {
        const absent = analyzeMaintenanceCandidates(makeSnapshot([], []), 200);
        expect(absent).toMatchObject({
            status: "skipped",
            skips: [expect.objectContaining({ reason: "subject-missing" })],
        });

        const inaccessibleIssue = makeIssue({
            number: 201,
            title: "Subject",
            accessible: false,
        });
        const inaccessible = analyzeMaintenanceCandidates(
            makeSnapshot([inaccessibleIssue]),
            201,
        );
        expect(inaccessible.skips[0]?.reason).toBe("subject-inaccessible");

        const closedIssue = makeIssue({
            number: 202,
            title: "Subject",
            state: "closed",
        });
        const closed = analyzeMaintenanceCandidates(
            makeSnapshot([closedIssue]),
            202,
        );
        expect(closed.skips[0]?.reason).toBe("subject-not-open");
    });

    test("is available as a dependency-free service object", () => {
        const subject = makeIssue({ number: 300, title: "Service boundary" });
        const snapshot = makeSnapshot([
            subject,
            makeIssue({ number: 301, title: subject.title }),
        ]);
        const direct = analyzeMaintenanceCandidates(snapshot, 300);
        const service = makeMaintenanceCandidateService();
        expect(service.analyze({ snapshot, subjectIssueNumber: 300 })).toEqual(
            direct,
        );
    });
});