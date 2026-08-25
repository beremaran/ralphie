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

export const dim = (text: string): string => `${DIM}${text}${RESET}`;
export const green = (text: string): string => `${GREEN}${text}${RESET}`;
export const red = (text: string): string => `${RED}${text}${RESET}`;
export const yellow = (text: string): string => `${YELLOW}${text}${RESET}`;
export const cyan = (text: string): string => `${CYAN}${text}${RESET}`;
