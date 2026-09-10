/**
 * JSON-in-text helpers for assistant responses.
 *
 * Pi agents return decisions as assistant text. Structured callers ask the
 * model for exactly one fenced `json` block matching their schema and retry
 * with a follow-up prompt when parsing or validation fails. A blocked task
 * may additionally emit a fenced `needs-attention` block carrying a
 * `{ reason, message? }` payload; that side channel is parsed independently
 * so ordinary decisions stay strict.
 */

const fencedPatternFor = (tags: string, flags: string): RegExp =>
    new RegExp(`\`\`\`(?:${tags})\\s*\\n([\\s\\S]*?)\`\`\``, flags);

const FENCED_BLOCK_PATTERN = fencedPatternFor("json|needs-attention", "gi");

const fencedContent = (
    text: string,
    tag: "json" | "needs-attention",
): string | undefined => fencedPatternFor(tag, "i").exec(text)?.[1]?.trim();

type JsonScanState = {
    depth: number;
    inString: boolean;
    escaped: boolean;
};

const advanceScanState = (state: JsonScanState, character: string): void => {
    if (state.inString) {
        if (state.escaped) state.escaped = false;
        else if (character === "\\") state.escaped = true;
        else if (character === '"') state.inString = false;
    } else if (character === '"') state.inString = true;
    else if (character === "{") state.depth += 1;
    else if (character === "}") state.depth -= 1;
};

const balancedJsonCandidate = (text: string): string | undefined => {
    const start = text.indexOf("{");
    if (start === -1) return undefined;
    const state: JsonScanState = { depth: 0, inString: false, escaped: false };
    for (let index = start; index < text.length; index += 1) {
        advanceScanState(state, text[index]!);
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
const fencedJsonCandidates = (text: string): string[] => {
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
    const jsonFence = fencedContent(text, "json");
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
    const fenced = fencedContent(text, "needs-attention");
    if (fenced === undefined) return undefined;
    return tryParseJson(fenced);
};