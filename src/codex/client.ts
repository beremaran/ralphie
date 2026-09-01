import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RalphieError } from "../shared/error.ts";

export type CodexModel = {
    readonly providerID?: string;
    readonly modelID: string;
};
export type CodexSandbox = "read-only" | "workspace-write";
/** Internal task-session request shape. */
export type CodexPermissionRuleset =
    | CodexSandbox
    | ReadonlyArray<{
          readonly permission: string;
          readonly pattern: string;
          readonly action: "allow" | "deny";
      }>;
export type CodexAssistantError = {
    readonly name: string;
    readonly data?: { readonly message?: string; readonly retries?: number };
};
export type CodexAssistantMessage = {
    readonly id: string;
    readonly role: "assistant";
    readonly error?: CodexAssistantError;
    readonly structured?: unknown;
    readonly text?: string;
    readonly [key: string]: unknown;
};
export type CodexPart = {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
};

/** Raw JSONL stays behind this adapter; UI components consume normalized events. */
export type CodexSessionEvent = any;
export type CodexEventContext = {
    readonly sessionID: string;
    readonly directory: string;
    readonly title?: string;
};
export type CodexEventListener = (
    event: CodexSessionEvent,
    context: CodexEventContext,
) => void;

type CreateSessionInput = {
    readonly directory: string;
    readonly title?: string;
    readonly model?: CodexModel;
    readonly sandbox?: CodexPermissionRuleset;
};
type PromptInput = {
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: CodexModel;
    readonly variant?: string;
    readonly parts: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
    }>;
    readonly format?: {
        readonly type: "json_schema";
        readonly schema: unknown;
    };
};
type ApiResult<Value> = { readonly data?: Value; readonly error?: unknown };
export type CodexClient = {
    readonly session: {
        create: (
            input: CreateSessionInput,
            options?: { readonly signal?: AbortSignal },
        ) => Promise<ApiResult<{ readonly id: string }>>;
        prompt: (
            input: PromptInput,
            options?: { readonly signal?: AbortSignal },
        ) => Promise<
            ApiResult<{
                readonly info: CodexAssistantMessage;
                readonly parts: ReadonlyArray<CodexPart>;
            }>
        >;
    };
    readonly close?: () => void;
};
export type CodexClientOptions = {
    readonly command?: string;
    readonly eventListener?: CodexEventListener;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly docker?: boolean;
};
type PendingSession = CreateSessionInput;

const STDERR_LIMIT = 8_192;
const REASONING_EFFORTS = new Set([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
]);

const filteredEnvironment = (
    supplied: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> => {
    const source = supplied ?? process.env;
    const allowed = new Set([
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "CODEX_HOME",
        "CODEX_API_KEY",
        "LANG",
        "LC_ALL",
    ]);
    return Object.fromEntries(
        Object.entries(source).filter(
            ([key, value]) => value !== undefined && allowed.has(key),
        ),
    ) as Record<string, string>;
};

const createSchemaFile = async (
    schema: unknown,
): Promise<{ readonly directory: string; readonly path: string }> => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-codex-schema-"));
    const path = join(directory, "response.schema.json");
    await writeFile(path, JSON.stringify(schema), {
        encoding: "utf8",
        mode: 0o600,
    });
    return { directory, path };
};

const parseJsonLines = (
    stdout: string,
): ReadonlyArray<Record<string, unknown>> =>
    stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => {
            try {
                const value: unknown = JSON.parse(line);
                if (
                    typeof value !== "object" ||
                    value === null ||
                    Array.isArray(value)
                ) {
                    throw new Error("not an object");
                }
                return value as Record<string, unknown>;
            } catch (cause) {
                throw new RalphieError({
                    message: "Codex emitted malformed JSONL.",
                    cause,
                });
            }
        });

const agentText = (event: Record<string, unknown>): string | undefined => {
    const item = event.item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return undefined;
    }
    const record = item as Record<string, unknown>;
    return record.type === "agent_message" && typeof record.text === "string"
        ? record.text
        : undefined;
};

const errorEventDetail = (
    events: ReadonlyArray<Record<string, unknown>>,
): string | undefined => {
    const errors = events.filter((event) => event.type === "error");
    if (errors.length === 0) return undefined;
    return JSON.stringify(errors.at(-1)).slice(0, STDERR_LIMIT);
};

type RunInput = {
    readonly command: string;
    readonly request: PromptInput;
    readonly session: PendingSession;
    readonly listener?: CodexEventListener;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly docker: boolean;
    readonly signal?: AbortSignal;
};
type RunResult = {
    readonly info: CodexAssistantMessage;
    readonly parts: ReadonlyArray<CodexPart>;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: process cleanup and failure normalization share one resource scope.
const run = async (input: RunInput): Promise<RunResult> => {
    const schema =
        input.request.format === undefined
            ? undefined
            : await createSchemaFile(input.request.format.schema);
    try {
        if (
            input.request.variant !== undefined &&
            !REASONING_EFFORTS.has(input.request.variant)
        ) {
            throw new RalphieError({
                message: `Unsupported Codex reasoning effort: ${input.request.variant}.`,
            });
        }
        const args = [
            "exec",
            "--json",
            "--ephemeral",
            "--color",
            "never",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            typeof input.session.sandbox === "string"
                ? input.session.sandbox
                : "read-only",
            "--cd",
            input.request.directory,
            "--config",
            'approval_policy="never"',
            "--config",
            "features.multi_agent=false",
            "--config",
            'web_search="disabled"',
            ...(input.docker
                ? ["--dangerously-bypass-approvals-and-sandbox"]
                : []),
            ...(input.request.model === undefined
                ? []
                : ["--model", input.request.model.modelID]),
            ...(input.request.variant === undefined
                ? []
                : [
                      "--config",
                      `model_reasoning_effort=\"${input.request.variant}\"`,
                  ]),
            ...(schema === undefined ? [] : ["--output-schema", schema.path]),
            "-",
        ];
        const child = Bun.spawn([input.command, ...args], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: filteredEnvironment(input.environment),
        });
        const abort = () => child.kill();
        input.signal?.addEventListener("abort", abort, { once: true });
        try {
            child.stdin.write(
                input.request.parts.map((part) => part.text).join("\n"),
            );
            child.stdin.end();
            const [exitCode, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            if (input.signal?.aborted) {
                throw new RalphieError({
                    message: "Codex task was cancelled.",
                });
            }
            const events = parseJsonLines(stdout);
            let threadID: string | undefined;
            let finalText: string | undefined;
            for (const event of events) {
                if (
                    event.type === "thread.started" &&
                    typeof event.thread_id === "string"
                ) {
                    threadID = event.thread_id;
                }
                const text = agentText(event);
                if (text !== undefined) finalText = text;
                input.listener?.(event, {
                    sessionID: threadID ?? input.request.sessionID,
                    directory: input.request.directory,
                    title: input.session.title,
                });
            }
            if (exitCode !== 0) {
                const detail =
                    stderr.slice(0, STDERR_LIMIT).trim() ||
                    errorEventDetail(events) ||
                    "no diagnostics";
                throw new RalphieError({
                    message: `Codex exited with status ${exitCode}: ${detail}`,
                });
            }
            if (threadID === undefined || finalText === undefined) {
                throw new RalphieError({
                    message:
                        "Codex completed without a thread ID or final response.",
                });
            }
            const structured =
                schema === undefined
                    ? undefined
                    : (() => {
                          try {
                              return JSON.parse(finalText);
                          } catch (cause) {
                              throw new RalphieError({
                                  message:
                                      "Codex final response did not satisfy the requested JSON schema.",
                                  cause,
                              });
                          }
                      })();
            const info: CodexAssistantMessage = {
                id: threadID,
                role: "assistant",
                text: finalText,
                ...(schema === undefined ? {} : { structured }),
            };
            return { info, parts: [{ type: "text", text: finalText }] };
        } finally {
            input.signal?.removeEventListener("abort", abort);
        }
    } finally {
        if (schema !== undefined) {
            await rm(schema.directory, { recursive: true, force: true });
        }
    }
};

/** Construct a fresh-process client. It never retains Codex thread state. */
export const makeCodexClient = (
    options: CodexClientOptions = {},
): CodexClient => {
    const pending = new Map<string, PendingSession>();
    return {
        session: {
            create: async (request) => {
                const id = randomUUID();
                pending.set(id, request);
                return { data: { id } };
            },
            prompt: async (request, runOptions) => {
                const session = pending.get(request.sessionID);
                pending.delete(request.sessionID);
                if (session === undefined) {
                    return {
                        error: new Error(
                            "Unknown or already used Codex request.",
                        ),
                    };
                }
                try {
                    return {
                        data: await run({
                            command: options.command ?? "codex",
                            request,
                            session,
                            listener: options.eventListener,
                            environment: options.environment,
                            docker: options.docker ?? false,
                            signal: runOptions?.signal,
                        }),
                    };
                } catch (error) {
                    return { error };
                }
            },
        },
    };
};