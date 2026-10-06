import {
    EDITING_ROLES,
    type HarnessFailure,
    type HarnessRole,
    type HarnessService,
    type SessionAccess,
    type SessionRequest,
} from "../harness/ports.ts";
import type { RoleAssignments, SessionApproval } from "../harness/app/roles.ts";
import { RalphieError } from "../shared/error.ts";

/** What the issue workflow needs to start sessions: a harness and the roles. */
export type AgentSessions = {
    readonly harness: HarnessService;
    readonly roles: RoleAssignments;
    /** Session limits; the defaults below apply when omitted. */
    readonly limits?: SessionLimits;
};

/** Wall-clock and spend limits applied to every session. */
export type SessionLimits = {
    readonly editTimeoutMs: number;
    readonly readOnlyTimeoutMs: number;
    /** Spend cap in US dollars, passed to harnesses that can enforce it. */
    readonly maxBudgetUsd?: number;
};

const MINUTE_MS = 60_000;

/** Wall-clock limit of one invocation in a role that edits the checkout. */
export const EDIT_SESSION_TIMEOUT_MS = 60 * MINUTE_MS;

/** Wall-clock limit of one invocation in a read-only role. */
export const READ_ONLY_SESSION_TIMEOUT_MS = 15 * MINUTE_MS;

/** The limits of a configuration that sets none. */
export const DEFAULT_SESSION_LIMITS: SessionLimits = {
    editTimeoutMs: EDIT_SESSION_TIMEOUT_MS,
    readOnlyTimeoutMs: READ_ONLY_SESSION_TIMEOUT_MS,
};

/** The access a role gets unless a request narrows it. */
export const accessForRole = (
    role: HarnessRole,
    approval: SessionApproval,
): SessionAccess => (EDITING_ROLES.includes(role) ? approval : "read-only");

export type SessionInput = {
    readonly role: HarnessRole;
    /** Narrow the role's default access, for example a read-only commit message. */
    readonly access?: SessionAccess;
    readonly directory: string;
    readonly title: string;
    readonly prompt: string;
    /** Continue this harness-native session instead of starting a new one. */
    readonly resumeSessionID?: string;
    readonly signal?: AbortSignal;
};

/** Build the harness request for a role from the configured assignments. */
export const sessionRequest = (
    sessions: AgentSessions,
    input: SessionInput,
): SessionRequest => {
    const assignment = sessions.roles[input.role];
    const access =
        input.access ?? accessForRole(input.role, assignment.approval);
    const limits = sessions.limits ?? DEFAULT_SESSION_LIMITS;
    return {
        role: input.role,
        harness: assignment.harness,
        prompt: input.prompt,
        directory: input.directory,
        access,
        timeoutMs:
            access === "read-only"
                ? limits.readOnlyTimeoutMs
                : limits.editTimeoutMs,
        title: input.title,
        ...(limits.maxBudgetUsd === undefined
            ? {}
            : { maxBudgetUsd: limits.maxBudgetUsd }),
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
        ...(assignment.effort === undefined
            ? {}
            : { effort: assignment.effort }),
        ...(input.resumeSessionID === undefined
            ? {}
            : { resumeSessionID: input.resumeSessionID }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
};

/** Whether an error came from the harness failing a session (not a Ralphie check). */
export const isSessionFailure = (error: unknown): boolean => {
    const cause = error instanceof RalphieError ? error.cause : undefined;
    return (
        typeof cause === "object" &&
        cause !== null &&
        "kind" in cause &&
        typeof cause.kind === "string" &&
        "message" in cause &&
        typeof cause.message === "string"
    );
};

/** Whether a session failure was the caller cancelling it (a user stop). */
export const isAbortedSession = (error: unknown): boolean =>
    isSessionFailure(error) &&
    (error as { cause: { kind: string } }).cause.kind === "aborted";

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