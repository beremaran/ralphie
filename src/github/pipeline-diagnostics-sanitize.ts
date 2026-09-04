/**
 * Sanitization helpers for pipeline-diagnostics text.
 *
 * Only terminal control sequences are stripped: ANSI/OSC escape sequences,
 * C0 cursor/erase/bell controls, DEL, and C1 controls are removed so no
 * control can repaint or corrupt a prompt-safe sink, and newlines are
 * preserved. Nothing else is altered: values pass through verbatim per the
 * GH-180 unredacted output contract, so credential-like content
 * (`github_pat_...`, `gh[pousr]_...`, Bearer tokens, environment-secret
 * values) is never redacted, masked, normalized, or truncated away.
 */
import { stripTerminalControls } from "../shared/terminal.ts";

export { stripTerminalControls };

/**
 * Sanitize one diagnostics excerpt before it enters a typed record: strip
 * terminal control sequences only and preserve all supplied text verbatim.
 */
export const sanitizeDiagnosticExcerpt = (text: string): string =>
    stripTerminalControls(text);