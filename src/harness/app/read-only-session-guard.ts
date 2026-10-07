import type {
    HarnessOutcome,
    HarnessService,
    SessionRequest,
    WorkingTreeFingerprint,
} from "../ports.ts";

/** Fail closed when a read-only session changed the working tree or index. */
export const guardReadOnlySessions = (
    inner: HarnessService,
    fingerprint: WorkingTreeFingerprint,
): HarnessService => {
    const run = async (
        request: SessionRequest,
    ): Promise<HarnessOutcome<unknown>> => {
        if (request.access !== "read-only") return await inner.run(request);
        const before = await fingerprint(request.directory, request.signal);
        const outcome = await inner.run(request);
        const after = await fingerprint(request.directory, request.signal);
        if (before === after) return outcome;
        return {
            ok: false,
            failure: {
                kind: "access",
                message: `The read-only ${request.role} session changed the working tree or index of ${request.directory}.`,
                ...(outcome.ok
                    ? { harnessSessionID: outcome.harnessSessionID }
                    : outcome.failure.harnessSessionID === undefined
                      ? {}
                      : {
                            harnessSessionID: outcome.failure.harnessSessionID,
                        }),
            },
        };
    };
    return { run: run as HarnessService["run"] };
};