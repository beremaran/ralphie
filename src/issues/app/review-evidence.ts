/** A review input too large for the prompt, written where reviewers can read it. */
export type ReviewEvidenceFile = {
    /** Absolute path of the file inside the checkout. */
    readonly path: string;
    /** Delete the file; safe to call when it is already gone. */
    readonly remove: () => Promise<void>;
};

/**
 * Publishes review evidence as a file inside the checkout. The file must be
 * excluded from git so it can never be staged; implemented in `adapters/`.
 */
export type ReviewEvidenceFiles = {
    readonly publish: (input: {
        readonly repositoryPath: string;
        readonly name: string;
        readonly contents: string;
    }) => Promise<ReviewEvidenceFile>;
};