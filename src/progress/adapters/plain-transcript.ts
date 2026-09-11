import type {
    AgentEventContext,
    AgentEventListener,
    AgentSessionEvent,
} from "../../agent/ports.ts";
import type { ProgressOutput } from "./progress.ts";
import { contentText, toolTarget } from "./tool-line.ts";

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
 * JSON mode emits lossless `agent_event` records; plain mode emits compact
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

    const startSession = (context: AgentEventContext): void => {
        flushText();
        flushThinking();
        open = true;
        const title =
            context.title === undefined ? "" : ` · ${oneLine(context.title)}`;
        line(`╭─ pi${title}`);
    };

    const endSession = (): void => {
        flushText();
        flushThinking();
        if (open) line("╰─ done");
        open = false;
    };

    const toolStart = (event: AgentSessionEvent): void => {
        flushText();
        flushThinking();
        const value = event as { toolName?: unknown; args?: unknown };
        line(`│  ${toolTarget(value.toolName, value.args)}`);
    };

    const toolEnd = (event: AgentSessionEvent): void => {
        const value = event as {
            toolName?: unknown;
            isError?: unknown;
            result?: unknown;
        };
        const name = String(value.toolName ?? "tool");
        if (value.isError !== true) {
            line(`│  ✓ ${name} done`);
            return;
        }
        const detail = contentText(value.result);
        const suffix =
            detail === undefined || detail.trim() === ""
                ? ""
                : `: ${clip(oneLine(detail), 200)}`;
        line(`│  ✗ ${name} failed${suffix}`);
    };

    const messageUpdate = (event: AgentSessionEvent): void => {
        const update = (
            event as {
                assistantMessageEvent?: { type?: unknown; delta?: unknown };
            }
        ).assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
            text += update.delta;
            return;
        }
        if (
            update?.type === "thinking_delta" &&
            typeof update.delta === "string"
        ) {
            thinking += update.delta;
            return;
        }
        if (update?.type === "text_end") flushText();
        if (update?.type === "thinking_end") flushThinking();
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
        const type = (event as { type?: unknown }).type;
        if (type === "agent_start") return startSession(context);
        if (type === "agent_end") return endSession();
        if (type === "tool_execution_start") return toolStart(event);
        if (type === "tool_execution_end") return toolEnd(event);
        if (type === "message_update") messageUpdate(event);
    };

    return (event, context) => {
        if (options.mode === "json") {
            writeJson(event, context);
            return;
        }
        handlePlain(event, context);
    };
};