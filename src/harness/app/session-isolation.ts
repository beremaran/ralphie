import type {
    HarnessOutcome,
    HarnessService,
    ScratchDirectoryProvider,
    SessionRequest,
    WorkingTreeFingerprint,
} from "../ports.ts";

/** Variables through which a session could authenticate to GitHub. */
export const GITHUB_CREDENTIAL_VARIABLES: ReadonlyArray<string> = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * The environment of an isolated session: no GitHub tokens (an undefined
 * value removes the variable) and a `gh` config directory that is empty, so
 * no stored login exists. These entries win over the request's own.
 */
export const isolatedEnvironment = (
    env: SessionRequest["env"],
    configDirectory: string,
): NonNullable<SessionRequest["env"]> => ({
    ...env,
    ...Object.fromEntries(
        GITHUB_CREDENTIAL_VARIABLES.map((name) => [name, undefined]),
    ),
    GH_CONFIG_DIR: configDirectory,
});

/** Run every session without GitHub credentials (ADR-0003). */
export const isolateSessions = (
    inner: HarnessService,
    scratch: ScratchDirectoryProvider,
): HarnessService => {
    const run = async (
        request: SessionRequest,
    ): Promise<HarnessOutcome<unknown>> => {
        const directory = await scratch.create();
        try {
            return await inner.run({
                ...request,
                env: isolatedEnvironment(request.env, directory.path),
            });
        } finally {
            await directory.remove().catch(() => {});
        }
    };
    return { run: run as HarnessService["run"] };
};

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