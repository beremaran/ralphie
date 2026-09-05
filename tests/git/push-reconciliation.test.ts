import { describe, expect, test } from "bun:test";

import { reconcilePipelinePush } from "../../src/git/push-reconciliation.ts";

const CREATED = "a".repeat(40);
const PRIOR = "b".repeat(40);
const UNRELATED = "c".repeat(40);

describe("reconcilePipelinePush", () => {
    test("confirms when the remote matches the created commit", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: CREATED,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "accepted",
            }),
        ).toBe("confirmed");
    });

    test("confirms after response loss when the remote proves arrival", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: CREATED,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "rejected",
                failureKind: "other",
            }),
        ).toBe("confirmed-after-response-loss");
    });

    test("rejects a non-fast-forward that leaves the remote at the prior", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: PRIOR,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "rejected",
                failureKind: "non-fast-forward",
            }),
        ).toBe("rejected");
    });

    test("is ambiguous when the remote is unchanged without a rejection", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: PRIOR,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "rejected",
            }),
        ).toBe("ambiguous");
    });

    test("reports external movement for an unrelated SHA", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: UNRELATED,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "accepted",
            }),
        ).toBe("external-movement");
    });

    test("reports external movement when the branch is missing", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: "",
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "rejected",
            }),
        ).toBe("external-movement");
    });

    test("is ambiguous when the authoritative read failed", () => {
        expect(
            reconcilePipelinePush({
                remoteSha: undefined,
                expectedSha: CREATED,
                priorSha: PRIOR,
                response: "rejected",
            }),
        ).toBe("ambiguous");
    });
});