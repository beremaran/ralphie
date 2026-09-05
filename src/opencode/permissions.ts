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

/**
 * Commands that can change delivery state or mutate GitHub. Agent sessions
 * may inspect and edit files, but deterministic Ralphie code owns the index,
 * refs, commits, pushes, and remote workflow state.
 */
const deniedGitSubcommands =
    "commit|push|branch|checkout|switch|worktree|reset|clean|merge|rebase|cherry-pick|revert|restore|add|rm|mv|update-index|read-tree|write-tree|tag";

const deniedGitCommand = new RegExp(
    `(?:^|\\s)git(?:\\s+\\S+){0,8}\\s+(?:${deniedGitSubcommands})\\b`,
    "i",
);
const deniedGithubCommand = /(?:^|\s)gh(?:\s|$)/i;

export const isOpenCodeTaskCommandAllowed = (command: string): boolean => {
    const trimmed = command.trim();
    return (
        trimmed.length > 0 &&
        !deniedGitCommand.test(trimmed) &&
        !deniedGithubCommand.test(trimmed)
    );
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
    "git merge*",
    "git rebase*",
    "git cherry-pick*",
    "git revert*",
    "git restore*",
    "git add*",
    "git rm*",
    "git mv*",
    "git update-index*",
    "git read-tree*",
    "git write-tree*",
    "git tag*",
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
    return deniedGitCommand.test(normalized);
};