import type { PipelineSnapshot } from "../github/pipeline-snapshot.ts";

/**
 * Normalize a failure for lifecycle detection without baking the immutable
 * commit identity into the failure identity. Provider IDs and raw records are
 * useful diagnostics, but run/commit-specific values must not allow the same
 * failing check to spin through every newly pushed SHA.
 */
export const pipelineFailureFingerprint = (
    snapshot: PipelineSnapshot,
): string =>
    JSON.stringify({
        state: snapshot.state,
        reason: snapshot.reason,
        items: snapshot.items.map((item) => ({
            source: item.source,
            provider: item.provider,
            name: item.name,
            status: item.status,
            rawState: item.rawState,
            errors: item.diagnostic.errors,
        })),
        sourceErrors: snapshot.sourceErrors.map(({ source, message }) => ({
            source,
            message,
        })),
        completenessErrors: snapshot.completenessErrors,
    });