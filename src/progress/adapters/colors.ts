/**
 * ANSI color and style helpers for progress rendering.
 *
 * Each function wraps text in the corresponding escape sequence,
 * or returns the text unchanged if colors are disabled.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const colorsEnabled = (): boolean => {
    if (process.env.NO_COLOR !== undefined) return false;
    const stderr = process.stderr as { readonly isTTY?: unknown };
    if (stderr.isTTY !== true) return false;
    return true;
};

const makeColor =
    (code: string) =>
    (text: string): string =>
        colorsEnabled() ? `${code}${text}${RESET}` : text;

export const dim = makeColor(DIM);
export const green = makeColor(GREEN);
export const red = makeColor(RED);
export const yellow = makeColor(YELLOW);
export const cyan = makeColor(CYAN);