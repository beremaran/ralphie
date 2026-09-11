/**
 * Client-side safety denylist for unattended agent sessions.
 *
 * Agent sessions may inspect and edit files, but deterministic Ralphie code
 * owns the index, refs, commits, pushes, and remote workflow state. The prompt
 * contract forbids these commands, the tool guard rejects them before
 * execution, and the deterministic repository-invariant check fails the task
 * when the checkout was mutated anyway.
 */

const deniedGitSubcommands =
    "commit|push|branch|checkout|switch|worktree|reset|clean|merge|rebase|cherry-pick|revert|restore|add|rm|mv|update-index|read-tree|write-tree|tag";

const deniedGitCommand = new RegExp(
    `(?:^|\\s)git(?:\\s+\\S+){0,8}\\s+(?:${deniedGitSubcommands})\\b`,
    "i",
);

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