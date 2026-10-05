import type { TurnEvent } from "../ports.ts";

/** An `error` event OpenCode printed; its process then exits with code 1. */
export type OpenCodeError = {
    readonly type: string | undefined;
    readonly message: string;
};

export type OpenCodeStreamSummary = {
    readonly sessionID: string | undefined;
    /** Text parts of the last step that produced any: the final message. */
    readonly text: string | undefined;
    readonly error: OpenCodeError | undefined;
};

type JsonRecord = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): JsonRecord | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonRecord)
        : undefined;

const asString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

const parseLine = (line: string): JsonRecord | undefined => {
    if (!line.trim().startsWith("{")) return undefined;
    try {
        return asRecord(JSON.parse(line));
    } catch {
        return undefined;
    }
};

const toolFailed = (state: JsonRecord): boolean =>
    state.status === "error" ||
    asRecord(asRecord(state.metadata)?.metadata)?.error === true;

const renderOutput = (state: JsonRecord): string =>
    asString(state.output) ?? asString(state.error) ?? "";

/**
 * OpenCode reports a finished tool as one `tool_use` event holding input and
 * output, so it becomes a paired call and result.
 */
const toolEvents = (part: JsonRecord): readonly TurnEvent[] => {
    const callId = asString(part.id) ?? asString(part.partID);
    const name = asString(part.tool);
    if (callId === undefined || name === undefined) return [];
    const state = asRecord(part.state) ?? {};
    return [
        {
            type: "tool_call",
            callId,
            name,
            input: asRecord(state.input) ?? {},
        },
        {
            type: "tool_result",
            callId,
            name,
            output: renderOutput(state),
            isError: toolFailed(state),
        },
    ];
};

type Tally = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    steps: number;
};

const addStep = (tally: Tally, part: JsonRecord): void => {
    const tokens = asRecord(part.tokens) ?? {};
    const cache = asRecord(tokens.cache) ?? {};
    tally.inputTokens += asNumber(tokens.input);
    tally.outputTokens += asNumber(tokens.output) + asNumber(tokens.reasoning);
    tally.cacheReadTokens += asNumber(cache.read);
    tally.cacheWriteTokens += asNumber(cache.write);
    tally.costUsd += asNumber(part.cost);
    tally.steps += 1;
};

const readError = (record: JsonRecord): OpenCodeError => {
    const error = asRecord(record.error);
    return {
        type: asString(error?.type),
        message:
            asString(error?.message) ??
            asString(error?.name) ??
            "OpenCode reported an error.",
    };
};

/**
 * Reads `opencode run --format json` lines. Usage is summed over every step
 * and reported once, by `finish`, because the contract wants one delta per
 * turn. Lines that are not JSON objects are ignored.
 */
export const makeOpenCodeStreamReader = (deps: {
    readonly onEvent: (event: TurnEvent) => void;
}): {
    readonly feed: (line: string) => void;
    readonly finish: () => void;
    readonly summary: () => OpenCodeStreamSummary;
} => {
    let sessionID: string | undefined;
    let error: OpenCodeError | undefined;
    let stepText: string[] = [];
    let lastText: string | undefined;
    const tally: Tally = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        steps: 0,
    };

    const onText = (part: JsonRecord, kind: "text" | "thinking"): void => {
        const text = asString(part.text) ?? "";
        if (text === "") return;
        if (kind === "text") {
            stepText.push(text);
            lastText = stepText.join("");
        }
        deps.onEvent({ type: "assistant_text", kind, text, done: true });
    };

    const handle = (record: JsonRecord): void => {
        const id = asString(record.sessionID);
        if (id !== undefined && id !== "") sessionID = id;
        const part = asRecord(record.part) ?? {};
        switch (record.type) {
            case "step_start":
                stepText = [];
                return;
            case "text":
                return onText(part, "text");
            case "reasoning":
                return onText(part, "thinking");
            case "tool_use":
                for (const event of toolEvents(part)) deps.onEvent(event);
                return;
            case "step_finish":
                return addStep(tally, part);
            case "error":
                error = readError(record);
                return;
        }
    };

    return {
        feed: (line) => {
            const record = parseLine(line);
            if (record !== undefined) handle(record);
        },
        finish: () => {
            if (tally.steps === 0) return;
            deps.onEvent({
                type: "usage",
                inputTokens: tally.inputTokens,
                outputTokens: tally.outputTokens,
                cacheReadTokens: tally.cacheReadTokens,
                cacheWriteTokens: tally.cacheWriteTokens,
                ...(tally.costUsd > 0 ? { costUsd: tally.costUsd } : {}),
            });
        },
        summary: () => ({ sessionID, text: lastText, error }),
    };
};