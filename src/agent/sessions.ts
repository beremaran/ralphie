import type {
    HarnessFailure,
    HarnessRole,
    HarnessService,
    SessionAccess,
    SessionRequest,
} from "../harness/ports.ts";
import type { RoleAssignments } from "../harness/app/roles.ts";
import { RalphieError } from "../shared/error.ts";

/** What the issue workflow needs to start sessions: a harness and the roles. */
export type AgentSessions = {
    readonly harness: HarnessService;
    readonly roles: RoleAssignments;
};

const MINUTE_MS = 60_000;

/** Wall-clock limit of one invocation in a role that edits the checkout. */
export const EDIT_SESSION_TIMEOUT_MS = 60 * MINUTE_MS;

/** Wall-clock limit of one invocation in a read-only role. */
export const READ_ONLY_SESSION_TIMEOUT_MS = 15 * MINUTE_MS;

const EDITING_ROLES: ReadonlyArray<HarnessRole> = ["implementer", "fixer"];

/** The access a role gets unless a request narrows it. */
export const accessForRole = (role: HarnessRole): SessionAccess =>
    EDITING_ROLES.includes(role) ? "safe" : "read-only";

export type SessionInput = {
    readonly role: HarnessRole;
    /** Narrow the role's default access, for example a read-only commit message. */
    readonly access?: SessionAccess;
    readonly directory: string;
    readonly title: string;
    readonly prompt: string;
    readonly signal?: AbortSignal;
};

/** Build the harness request for a role from the configured assignments. */
export const sessionRequest = (
    sessions: AgentSessions,
    input: SessionInput,
): SessionRequest => {
    const assignment = sessions.roles[input.role];
    const access = input.access ?? accessForRole(input.role);
    return {
        role: input.role,
        harness: assignment.harness,
        prompt: input.prompt,
        directory: input.directory,
        access,
        timeoutMs:
            access === "read-only"
                ? READ_ONLY_SESSION_TIMEOUT_MS
                : EDIT_SESSION_TIMEOUT_MS,
        title: input.title,
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
        ...(assignment.effort === undefined
            ? {}
            : { effort: assignment.effort }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
};

/** The error a failed session raises; the failure stays on `cause`. */
export const sessionFailure = (
    role: HarnessRole,
    failure: HarnessFailure,
): RalphieError =>
    new RalphieError({
        message: `The ${role} session failed (${failure.kind}): ${failure.message}`,
        cause: failure,
    });

/** Stable, non-empty session id for artifacts when a harness reports none. */
export const sessionIdFor = (harnessSessionID: string | undefined): string =>
    harnessSessionID ?? "unreported";