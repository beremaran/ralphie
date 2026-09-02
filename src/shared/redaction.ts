const REDACTED = "[REDACTED]";
const sensitiveKey =
    /token|authorization|password|passwd|secret|credential|api[-_]?key/i;

const ANSI_ESCAPE =
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]/g;
/** C0 cursor/erase/bell controls (except newline and tab), DEL, and C1 controls. */
const TERMINAL_CONTROL_CODE =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g;

/**
 * Remove terminal state from arbitrary text without altering newlines.
 *
 * Normalizes carriage returns, drops ESC-based ANSI/OSC sequences, C0
 * cursor/erase/bell controls (other than newline), DEL, and C1 controls such
 * as U+009B (CSI), so no control can repaint or corrupt an append-only sink.
 */
export const stripTerminalControls = (text: string): string =>
    text
        .replace(/\r\n?/g, "\n")
        .replace(ANSI_ESCAPE, "")
        .replace(TERMINAL_CONTROL_CODE, "");

export const redactSensitiveText = (value: string): string => {
    let redacted = value
        .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED)
        .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, REDACTED)
        .replace(
            /\b(Bearer\s+)(?!\[REDACTED\](?=$|[\]\s]))\S+/gi,
            `$1${REDACTED}`,
        )
        .replace(
            /([?&](?:token|access_token|api_key)=)(?!\[REDACTED\](?=$|[\]\s&]))[^&\s]+/gi,
            `$1${REDACTED}`,
        )
        .replace(/(https?:\/\/[^\s/:@]+:)[^\s@]+@/gi, `$1${REDACTED}@`);
    for (const [key, environmentValue] of Object.entries(process.env)) {
        if (
            sensitiveKey.test(key) &&
            environmentValue !== undefined &&
            environmentValue.length > 0
        ) {
            redacted = redacted.split(environmentValue).join(REDACTED);
        }
    }
    return redacted;
};

export const redactSensitiveValue = (value: unknown, key?: string): unknown => {
    if (key !== undefined && sensitiveKey.test(key)) return REDACTED;
    if (typeof value === "string") return redactSensitiveText(value);
    if (Array.isArray(value)) {
        return value.map((entry) => redactSensitiveValue(entry));
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                redactSensitiveValue(entryValue, entryKey),
            ]),
        );
    }
    return value;
};