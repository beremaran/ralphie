import {
    haltingFailure,
    isSessionFailure,
    sessionIdFor,
    type AgentSessions,
} from "../../agent/sessions.ts";
import {
    runAgentTask,
    type AgentTaskRequest,
    type AgentTaskResult,
} from "../../agent/task-session.ts";
import { errorMessage } from "../../shared/error.ts";

/**
 * Prompt plus reply characters after which a fix session counts as near its
 * context limit (about 100k tokens, half of a common window). Harnesses do not
 * report context use, so this is an estimate.
 */
export const FIX_SESSION_CONTEXT_CHARS = 400_000;

/** The implementer's session, which fixes continue for as long as it is healthy. */
export type FixSession = {
    /** Harness that ran the session; a fixer on another harness cannot resume it. */
    readonly harness: string;
    /** Harness-native id of the session to continue, when one is known. */
    sessionID: string | undefined;
    /** Estimated characters the session has consumed so far. */
    consumedChars: number;
};

export const newFixSession = (harness: string): FixSession => ({
    harness,
    sessionID: undefined,
    consumedChars: 0,
});

/** Remember the session a turn ran in and what it consumed. */
export const recordFixTurn = (
    fix: FixSession,
    turn: {
        readonly sessionID: string;
        readonly consumedChars: number;
        /** True when the turn continued the session instead of starting one. */
        readonly resumed: boolean;
    },
): void => {
    fix.sessionID =
        turn.sessionID === sessionIdFor(undefined) ? undefined : turn.sessionID;
    fix.consumedChars = turn.resumed
        ? fix.consumedChars + turn.consumedChars
        : turn.consumedChars;
};

export type FixRequest = Omit<
    AgentTaskRequest,
    "role" | "prompt" | "resumeSessionID"
> & {
    /** Continues the implementer's session: skill invocation plus findings. */
    readonly resumePrompt: string;
    /** Starts a fresh fixer session from the issue, the diff and the findings. */
    readonly freshPrompt: string;
    /** Tells the operator a resume was skipped or failed. */
    readonly onFreshSession: (reason: string) => Promise<void>;
};

const resumeBlocker = (
    sessions: AgentSessions,
    fix: FixSession,
): string | undefined => {
    if (sessions.roles.fixer.harness !== fix.harness) {
        return "the fixer uses a different harness than the implementer";
    }
    if (fix.consumedChars >= FIX_SESSION_CONTEXT_CHARS) {
        return "the implementer session is near its context limit";
    }
    return undefined;
};

/** Resume the session quietly: a failed resume is not a failed stage. */
const tryResume = async (
    sessions: AgentSessions,
    fix: FixSession,
    sessionID: string,
    request: FixRequest,
): Promise<AgentTaskResult | { readonly failure: string }> => {
    const {
        resumePrompt,
        freshPrompt: _fresh,
        onFreshSession: _on,
        ...rest
    } = request;
    const { progress: _progress, ...task } = rest;
    try {
        const result = await runAgentTask(sessions, {
            ...task,
            role: "fixer",
            prompt: resumePrompt,
            resumeSessionID: sessionID,
        });
        recordFixTurn(fix, {
            sessionID: result.sessionID,
            consumedChars: resumePrompt.length + result.text.length,
            resumed: true,
        });
        return result;
    } catch (error) {
        if (
            request.signal?.aborted === true ||
            !isSessionFailure(error) ||
            haltingFailure(error) !== undefined
        ) {
            throw error;
        }
        return { failure: errorMessage(error) };
    }
};

/**
 * Run one fix. The implementer's session is resumed when it can be; when it
 * cannot, or resuming fails, a fresh fixer session starts from the issue, the
 * diff and the findings. Either way the session that did the work is the one
 * the next fix continues.
 */
export const runFix = async (
    sessions: AgentSessions,
    fix: FixSession,
    request: FixRequest,
): Promise<AgentTaskResult> => {
    const { sessionID } = fix;
    if (sessionID !== undefined) {
        const blocker = resumeBlocker(sessions, fix);
        if (blocker === undefined) {
            const resumed = await tryResume(sessions, fix, sessionID, request);
            if ("text" in resumed) return resumed;
            await request.onFreshSession(
                `resuming the implementer session failed (${resumed.failure})`,
            );
        } else {
            await request.onFreshSession(blocker);
        }
    }
    const {
        freshPrompt,
        resumePrompt: _resume,
        onFreshSession: _on,
        ...task
    } = request;
    const result = await runAgentTask(sessions, {
        ...task,
        role: "fixer",
        prompt: freshPrompt,
    });
    recordFixTurn(fix, {
        sessionID: result.sessionID,
        consumedChars: freshPrompt.length + result.text.length,
        resumed: false,
    });
    return result;
};