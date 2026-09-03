/**
 * Client-side safety denylist for the external OpenCode server.
 *
 * The server owns tool execution, so Ralphie cannot prevent a dangerous
 * command the way the embedded runtime could. These helpers provide
 * defense in depth: prompts forbid the commands, a background permission
 * watcher rejects them when they surface as pending approvals, and the
 * deterministic repository-invariant check fails the task when the checkout
 * was mutated anyway.
 */

const deniedTaskCommand =
    /(?:^|\s)(?:git\s+(?:commit|push|branch|checkout|switch|worktree|reset|clean)|gh(?:\s|$))/i;

export const isOpenCodeTaskCommandAllowed = (command: string): boolean => {
    const trimmed = command.trim();
    return trimmed.length > 0 && !deniedTaskCommand.test(trimmed);
};

/** Shell resources that must never run in an unattended agent session. */
export const OPENCODE_DENIED_SHELL_PATTERNS: ReadonlyArray<string> = [
    "git commit*",
    "git push*",
    "git branch*",
    "git checkout*",
    "git switch*",
    "git worktree*",
    "git reset*",
    "git clean*",
    "gh *",
];

/**
 * True when a pending OpenCode shell permission request targets a denied
 * command. Matching is intentionally conservative: any denied substring
 * rejects the request.
 */
export const isDeniedShellResource = (resource: string): boolean => {
    const normalized = resource.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (/\bgh(\s|$)/.test(normalized)) return true;
    const gitDenied =
        /git\s+(commit|push|branch|checkout|switch|worktree|reset|clean)\b/;
    return gitDenied.test(normalized);
};