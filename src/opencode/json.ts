/**
 * JSON-in-text helpers for the OpenCode backend.
 *
 * OpenCode's external server exposes no mandatory structured-result tool, so
 * every decision is returned as assistant text. Structured callers ask the
 * model for exactly one fenced `json` block matching their schema and retry
 * with a follow-up prompt when parsing or validation fails. A blocked task
 * may additionally emit a fenced `needs-attention` block carrying a
 * `{ reason, message? }` payload; that side channel is parsed independently
 * so ordinary decisions stay strict.
 */

const FENCED_BLOCK_PATTERN = /```(?:json|needs-attention)\s*\n([\s\S]*?)```/gi;

const NEEDS_ATTENTION_FENCE_PATTERN = /```needs-attention\s*\n([\s\S]*?)```/i;

const JSON_FENCE_PATTERN = /```json\s*\n([\s\S]*?)```/i;

type JsonScanState = {
    depth: number;
    inString: boolean;
    escaped: boolean;
};

const initialScanState = (): JsonScanState => ({
    depth: 0,
    inString: false,
    escaped: false,
});

const stepInString = (
    state: JsonScanState,
    character: string,
): JsonScanState => {
    if (state.escaped) return { ...state, escaped: false };
    if (character === "\\") return { ...state, escaped: true };
    if (character === '"') return { ...state, inString: false };
    return state;
};

const stepOutOfString = (
    state: JsonScanState,
    character: string,
): JsonScanState => {
    if (character === '"') return { ...state, inString: true };
    if (character === "{") return { ...state, depth: state.depth + 1 };
    if (character === "}") return { ...state, depth: state.depth - 1 };
    return state;
};

const stepScan = (state: JsonScanState, character: string): JsonScanState =>
    state.inString
        ? stepInString(state, character)
        : stepOutOfString(state, character);

const balancedJsonCandidate = (text: string): string | undefined => {
    const start = text.indexOf("{");
    if (start === -1) return undefined;
    let state = initialScanState();
    for (let index = start; index < text.length; index += 1) {
        state = stepScan(state, text[index]!);
        if (!state.inString && state.depth === 0 && index > start) {
            return text.slice(start, index + 1);
        }
    }
    return undefined;
};

const tryParseJson = (candidate: string): unknown | undefined => {
    try {
        return JSON.parse(candidate);
    } catch {
        return undefined;
    }
};

/** All fenced JSON candidates in source order (json + needs-attention). */
export const fencedJsonCandidates = (text: string): string[] => {
    const candidates: string[] = [];
    FENCED_BLOCK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCED_BLOCK_PATTERN.exec(text)) !== null) {
        const candidate = match[1];
        if (candidate !== undefined) candidates.push(candidate.trim());
    }
    return candidates;
};

/**
 * Extract the primary structured payload from assistant text.
 *
 * Prefers an explicit ```json block, then any fenced block, then the first
 * balanced `{...}` span. Returns undefined when nothing parses as JSON.
 */
export const extractStructuredJson = (text: string): unknown | undefined => {
    const jsonFence = JSON_FENCE_PATTERN.exec(text)?.[1]?.trim();
    if (jsonFence !== undefined) {
        const parsed = tryParseJson(jsonFence);
        if (parsed !== undefined) return parsed;
    }
    for (const candidate of fencedJsonCandidates(text)) {
        const parsed = tryParseJson(candidate);
        if (parsed !== undefined) return parsed;
    }
    const balanced = balancedJsonCandidate(text);
    if (balanced !== undefined) {
        const parsed = tryParseJson(balanced);
        if (parsed !== undefined) return parsed;
    }
    return undefined;
};

/** Extract an optional ```needs-attention JSON side channel. */
export const extractNeedsAttentionJson = (
    text: string,
): unknown | undefined => {
    const fenced = NEEDS_ATTENTION_FENCE_PATTERN.exec(text)?.[1]?.trim();
    if (fenced !== undefined) {
        const parsed = tryParseJson(fenced);
        if (parsed !== undefined) return parsed;
    }
    return undefined;
};