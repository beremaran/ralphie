export type PipelinePushReconciliationStatus =
    | "confirmed"
    | "confirmed-after-response-loss"
    | "rejected"
    | "ambiguous"
    | "external-movement";

export type PipelinePushReconciliationInput = {
    /** Authoritative remote head after the push; undefined when the read failed, "" when the branch is absent. */
    readonly remoteSha: string | undefined;
    /** The Created pipeline commit the push attempted to deliver. */
    readonly expectedSha: string;
    /** The remote head the push attempted to extend. */
    readonly priorSha: string;
    readonly response: "accepted" | "rejected";
    readonly failureKind?: "non-fast-forward" | "other";
};

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

/**
 * Reconcile a non-force push against the authoritative remote read.
 * Owns the missing-read split: a failed read is ambiguous, a missing
 * branch is external movement, per the push reconciliation glossary.
 */
export const reconcilePipelinePush = (
    input: PipelinePushReconciliationInput,
): PipelinePushReconciliationStatus => {
    if (input.remoteSha === undefined) return "ambiguous";
    if (input.remoteSha === "") return "external-movement";
    if (sameSha(input.remoteSha, input.expectedSha)) {
        return input.response === "accepted"
            ? "confirmed"
            : "confirmed-after-response-loss";
    }
    if (sameSha(input.remoteSha, input.priorSha)) {
        return input.failureKind === "non-fast-forward"
            ? "rejected"
            : "ambiguous";
    }
    return "external-movement";
};