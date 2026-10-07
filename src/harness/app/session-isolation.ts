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

/** Variables through which a session could reach an SSH agent or prompt. */
export const SSH_AGENT_VARIABLES: ReadonlyArray<string> = [
    "SSH_AUTH_SOCK",
    "SSH_ASKPASS",
    "GIT_ASKPASS",
];

/**
 * The environment of an isolated session: no GitHub tokens or SSH agent (an
 * undefined value removes the variable), a `gh` config directory that is
 * empty, git configuration that cannot supply credential helpers (global and
 * system files are `/dev/null`, and the repository's own helper list is reset
 * through `GIT_CONFIG_COUNT`), no terminal prompts, and an ssh command that
 * always fails. These entries win over the request's own.
 */
export const isolatedEnvironment = (
    env: SessionRequest["env"],
    configDirectory: string,
): NonNullable<SessionRequest["env"]> => ({
    ...env,
    ...Object.fromEntries(
        [...GITHUB_CREDENTIAL_VARIABLES, ...SSH_AGENT_VARIABLES].map((name) => [
            name,
            undefined,
        ]),
    ),
    GH_CONFIG_DIR: configDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
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