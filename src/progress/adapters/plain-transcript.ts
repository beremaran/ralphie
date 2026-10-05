import type {
    AgentEventContext,
    AgentEventListener,
    AgentSessionEvent,
} from "../../agent/ports.ts";
import type { ProgressOutput } from "./progress.ts";
import { toolTarget } from "./tool-line.ts";

type PlainTranscriptOptions = {
    readonly mode: "plain" | "json";
    readonly output: ProgressOutput;
    readonly now?: () => Date;
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const clip = (value: string, limit: number): string =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/**
 * Append-only transcript for non-interactive modes.
 *
 * JSON mode emits one `agent_event` record per normalized session event; plain
 * mode emits compact
 * session blocks. Assistant and thinking text are buffered per part so a
 * token stream becomes complete lines instead of raw fragments.
 */
export const makePlainTranscript = (
    options: PlainTranscriptOptions,
): AgentEventListener => {
    let text = "";
    let thinking = "";
    let open = false;

    const line = (value: string): void => {
        options.output.writeLine(value);
    };

    const flushText = (): void => {
        const value = text.trim();
        text = "";
        for (const part of value.split("\n")) {
            if (part.trim() !== "") line(`│  ${part}`);
        }
    };

    const flushThinking = (): void => {
        const value = thinking.trim();
        thinking = "";
        for (const part of value.split("\n")) {
            if (part.trim() !== "") line(`│  ✦ ${part}`);
        }
    };

    const startSession = (
        event: Extract<AgentSessionEvent, { type: "session_started" }>,
        context: AgentEventContext,
    ): void => {
        flushText();
        flushThinking();
        open = true;
        const title =
            context.title === undefined ? "" : ` · ${oneLine(context.title)}`;
        line(`╭─ ${event.harness ?? "agent"}${title}`);
    };

    const endSession = (): void => {
        flushText();
        flushThinking();
        if (open) line("╰─ done");
        open = false;
    };

    const toolStart = (
        event: Extract<AgentSessionEvent, { type: "tool_call" }>,
    ): void => {
        flushText();
        flushThinking();
        line(`│  ${toolTarget(event.toolName, event.args)}`);
    };

    const toolEnd = (
        event: Extract<AgentSessionEvent, { type: "tool_result" }>,
    ): void => {
        if (!event.isError) {
            line(`│  ✓ ${event.toolName} done`);
            return;
        }
        const detail = event.text;
        const suffix =
            detail === undefined || detail.trim() === ""
                ? ""
                : `: ${clip(oneLine(detail), 200)}`;
        line(`│  ✗ ${event.toolName} failed${suffix}`);
    };

    const textDelta = (
        event: Extract<AgentSessionEvent, { type: "text_delta" }>,
    ): void => {
        if (event.channel === "thinking") thinking += event.text;
        else text += event.text;
    };

    const textEnd = (
        event: Extract<AgentSessionEvent, { type: "text_end" }>,
    ): void => {
        if (event.channel === "thinking") flushThinking();
        else flushText();
    };

    const writeJson = (
        event: AgentSessionEvent,
        context: AgentEventContext,
    ): void => {
        options.output.writeLine(
            JSON.stringify({
                type: "agent_event",
                sessionID: context.sessionID,
                directory: context.directory,
                ...(context.title === undefined
                    ? {}
                    : { title: context.title }),
                event,
            }),
        );
    };

    const handlePlain = (
        event: AgentSessionEvent,
        context: AgentEventContext,
    ): void => {
        switch (event.type) {
            case "session_started":
                return startSession(event, context);
            case "session_finished":
                return endSession();
            case "tool_call":
                return toolStart(event);
            case "tool_result":
                return toolEnd(event);
            case "text_delta":
                return textDelta(event);
            case "text_end":
                return textEnd(event);
            case "error":
                flushText();
                flushThinking();
                return line(`│  ✗ error: ${clip(oneLine(event.message), 200)}`);
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