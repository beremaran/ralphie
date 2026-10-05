import type {
    SessionEvent,
    SessionEventContext,
    SessionEventListener,
} from "../../harness/ports.ts";
import type { ProgressOutput } from "./progress.ts";
import { toolTarget } from "./tool-line.ts";

type PlainTranscriptOptions = {
    readonly mode: "plain" | "json";
    readonly output: ProgressOutput;
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const clip = (value: string, limit: number): string =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/**
 * Append-only transcript for non-interactive modes.
 *
 * JSON mode emits one `session_event` record per session event; plain mode
 * emits compact session blocks. Assistant and thinking text are buffered per
 * block so a token stream becomes complete lines instead of raw fragments.
 */
export const makePlainTranscript = (
    options: PlainTranscriptOptions,
): SessionEventListener => {
    const buffers = { text: "", thinking: "" };
    let open = false;

    const line = (value: string): void => {
        options.output.writeLine(value);
    };

    const flush = (kind: "text" | "thinking"): void => {
        const value = buffers[kind].trim();
        buffers[kind] = "";
        const prefix = kind === "thinking" ? "│  ✦ " : "│  ";
        for (const part of value.split("\n")) {
            if (part.trim() !== "") line(`${prefix}${part}`);
        }
    };

    const flushAll = (): void => {
        flush("text");
        flush("thinking");
    };

    const startSession = (context: SessionEventContext): void => {
        flushAll();
        open = true;
        const title =
            context.title === undefined ? "" : ` · ${oneLine(context.title)}`;
        line(`╭─ ${oneLine(context.harness)}${title}`);
    };

    const endSession = (): void => {
        flushAll();
        if (open) line("╰─ done");
        open = false;
    };

    const toolResult = (
        event: Extract<SessionEvent, { type: "tool_result" }>,
    ): void => {
        if (!event.isError) {
            line(`│  ✓ ${event.name} done`);
            return;
        }
        const suffix =
            event.output.trim() === ""
                ? ""
                : `: ${clip(oneLine(event.output), 200)}`;
        line(`│  ✗ ${event.name} failed${suffix}`);
    };

    const assistantText = (
        event: Extract<SessionEvent, { type: "assistant_text" }>,
    ): void => {
        buffers[event.kind] += event.text;
        if (event.done) flush(event.kind);
    };

    const writeJson = (
        event: SessionEvent,
        context: SessionEventContext,
    ): void => {
        options.output.writeLine(
            JSON.stringify({
                type: "session_event",
                sessionID: context.sessionID,
                directory: context.directory,
                harness: context.harness,
                ...(context.title === undefined
                    ? {}
                    : { title: context.title }),
                event,
            }),
        );
    };

    const handlePlain = (
        event: SessionEvent,
        context: SessionEventContext,
    ): void => {
        switch (event.type) {
            case "session_started":
                return startSession(context);
            case "session_finished":
                return endSession();
            case "assistant_text":
                return assistantText(event);
            case "tool_call":
                flushAll();
                return line(`│  ${toolTarget(event.name, event.input)}`);
            case "tool_result":
                return toolResult(event);
            case "error":
                flushAll();
                return line(`│  ✗ ${oneLine(event.message)}`);
            case "usage":
                return;
        }
    };

    return (event, context) => {
        if (options.mode === "json") {
            writeJson(event, context);
            return;
        }
        handlePlain(event, context);
    };
};