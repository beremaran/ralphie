/**
 * Client-side safety denylist for unattended agent sessions.
 *
 * Agent sessions may inspect and edit files, but deterministic Ralphie code
 * owns the index, refs, commits, pushes, and remote workflow state. The prompt
 * contract forbids these commands, the tool guard rejects them before
 * execution, and the deterministic repository-invariant check fails the task
 * when the checkout was mutated anyway.
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

export const isTaskCommandAllowed = (command: string): boolean => {
    const trimmed = command.trim();
    return (
        trimmed.length > 0 &&
        !deniedGitCommand.test(trimmed) &&
        !deniedGithubCommand.test(trimmed)
    );
};

/** Shell resources that must never run in an unattended agent session. */
export const DENIED_SHELL_PATTERNS: ReadonlyArray<string> = [
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
 * True when a shell command targets a denied command. Matching is
 * intentionally conservative: any denied substring rejects the command.
 */
export const isDeniedShellResource = (resource: string): boolean => {
    const normalized = resource.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (/\bgh(\s|$)/.test(normalized)) return true;
    return deniedGitCommand.test(normalized);
};