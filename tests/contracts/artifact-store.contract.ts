import { describe, expect, test } from "bun:test";

import {
    IssueArtifactKind,
    type IssueArtifactStore,
} from "../../src/issues/app/artifacts.ts";
import { ReviewVerdict } from "../../src/issues/domain/decisions.ts";
import type { ReviewAttempt } from "../../src/issues/app/recovery.ts";

export type ArtifactStoreHarness = {
    readonly name: string;
    readonly make: () => Promise<{
        readonly store: IssueArtifactStore;
        readonly cleanup: () => Promise<void>;
    }>;
};

const reviewFor = (attempt: number): ReviewAttempt => ({
    attempt,
    sessionID: `review-session-${attempt}`,
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: `Review ${attempt} is approved.`,
        findings: [],
    },
});

/**
 * Shared behavioral contract for every `IssueArtifactStore` adapter.
 *
 * The in-memory and durable implementations run the same suite so the
 * application tests using the memory store exercise real store semantics.
 */
export const issueArtifactStoreContract = (
    harness: ArtifactStoreHarness,
): void => {
    describe(`${harness.name} artifact store contract`, () => {
        test("round-trips a written artifact", async () => {
            const { store, cleanup } = await harness.make();
            try {
                expect(store.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(
                    false,
                );
                await store.write(IssueArtifactKind.CreatedIssueNumbers, {
                    alpha: 1,
                });
                expect(store.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(
                    true,
                );
                expect(
                    await store.read(IssueArtifactKind.CreatedIssueNumbers),
                ).toEqual({ alpha: 1 });
            } finally {
                await cleanup();
            }
        });

        test("refuses to overwrite a produced artifact", async () => {
            const { store, cleanup } = await harness.make();
            try {
                await store.write(IssueArtifactKind.CreatedIssueNumbers, {
                    alpha: 1,
                });
                await expect(
                    store.write(IssueArtifactKind.CreatedIssueNumbers, {
                        beta: 2,
                    }),
                ).rejects.toThrow();
                expect(
                    await store.read(IssueArtifactKind.CreatedIssueNumbers),
                ).toEqual({ alpha: 1 });
            } finally {
                await cleanup();
            }
        });

        test("keeps appended reviews in order", async () => {
            const { store, cleanup } = await harness.make();
            try {
                await store.appendReview(reviewFor(1));
                await store.appendReview(reviewFor(2));
                expect(
                    await store.read(IssueArtifactKind.ReviewAttempts),
                ).toEqual([reviewFor(1), reviewFor(2)]);
            } finally {
                await cleanup();
            }
        });

        test("rejects an out-of-order review attempt", async () => {
            const { store, cleanup } = await harness.make();
            try {
                await expect(
                    store.appendReview(reviewFor(2)),
                ).rejects.toThrow();
                expect(store.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
            } finally {
                await cleanup();
            }
        });
    });
};