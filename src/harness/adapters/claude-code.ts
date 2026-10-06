import { kindForStatus } from "../failure-classification.ts";
import {
    CommandAbortedError,
    CommandTimeoutError,
    type CommandRunnerService,
} from "../../process/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import type {
    HarnessAdapter,
    HarnessFailure,
    SessionAccess,
    TurnOutcome,
    TurnRequest,
} from "../ports.ts";
import {
    makeClaudeStreamReader,
    type ClaudeResult,
    type ClaudeStreamSummary,
} from "./claude-code-stream.ts";

const EXECUTABLE = "claude";

/**
 * Permission mode each access level requires. The mode is always passed
 * explicitly, so a session never inherits the user's own default.
 */
const PERMISSION_MODES: Readonly<Record<SessionAccess, string>> = {
    "read-only": "plan",
    safe: "auto",
    yolo: "bypassPermissions",
};

/** Tools a read-only session may use; plan mode also blocks edits. */
const READ_ONLY_TOOLS = "Read,Glob,Grep";

const optionalFlag = (
    flag: string,
    value: string | number | undefined,
): readonly string[] => (value === undefined ? [] : [flag, String(value)]);

/**
 * Command line for one turn. The prompt travels on stdin, because the tool
 * list flags are variadic and a positional prompt would be read as a tool.
 * `--bare` is never used: it disables the keychain login.
 */
const buildArguments = (turn: TurnRequest): readonly string[] => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    PERMISSION_MODES[turn.access],
    ...(turn.access === "read-only" ? ["--tools", READ_ONLY_TOOLS] : []),
    ...optionalFlag("--model", turn.model),
    ...optionalFlag("--effort", turn.effort),
    ...optionalFlag("--max-budget-usd", turn.maxBudgetUsd),
    // Passed on every turn: a resumed session loses the structured output tool.
    ...optionalFlag(
        "--json-schema",
        turn.jsonSchema === undefined
            ? undefined
            : JSON.stringify(turn.jsonSchema),
    ),
    ...optionalFlag("--resume", turn.resumeSessionID),
];

const failure = (
    kind: HarnessFailure["kind"],
    message: string,
    harnessSessionID?: string,
): TurnOutcome => ({
    ok: false,
    failure: {
        kind,
        message,
        ...(harnessSessionID === undefined ? {} : { harnessSessionID }),
    },
});

const classifyThrown = (error: unknown): TurnOutcome => {
    if (error instanceof CommandTimeoutError) {
        return failure("timeout", error.message);
    }
    if (error instanceof CommandAbortedError) {
        return failure("aborted", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(
        error instanceof RalphieError ? "unavailable" : "harness",
        message,
    );
};

const resultFailureKind = (
    result: ClaudeResult,
    summary: ClaudeStreamSummary,
): HarnessFailure["kind"] => {
    if (
        result.subtype === "error_max_budget_usd" ||
        result.terminalReason === "budget_exhausted"
    ) {
        return "budget";
    }
    if (
        summary.assistantError === "model_not_found" ||
        result.apiErrorStatus === 404
    ) {
        return "model";
    }
    if (summary.assistantError === "rate_limit") return "transient";
    if (summary.assistantError === "authentication_failed") return "auth";
    return kindForStatus(result.apiErrorStatus) ?? "harness";
};

const describeResultFailure = (result: ClaudeResult): string => {
    const detail =
        result.errors.length > 0 ? result.errors.join("; ") : result.text;
    return detail === ""
        ? `Claude Code reported an error (${result.subtype ?? "unknown"}).`
        : detail;
};

/** Settle a finished process: a reported result wins over the exit code. */
const settle = (
    summary: ClaudeStreamSummary,
    exit: { readonly exitCode: number; readonly stderr: string },
): TurnOutcome => {
    const { result, sessionID } = summary;
    if (result === undefined) {
        const detail = exit.stderr === "" ? "" : `: ${exit.stderr}`;
        return exit.exitCode === 0
            ? failure(
                  "harness",
                  "Claude Code ended without reporting a result.",
                  sessionID,
              )
            : failure(
                  "exit",
                  `Claude Code exited with code ${exit.exitCode}${detail}`,
                  sessionID,
              );
    }
    if (result.isError) {
        return failure(
            resultFailureKind(result, summary),
            describeResultFailure(result),
            sessionID,
        );
    }
    if (exit.exitCode !== 0) {
        return failure(
            "exit",
            `Claude Code exited with code ${exit.exitCode} after reporting success.`,
            sessionID,
        );
    }
    return {
        ok: true,
        harnessSessionID: sessionID,
        text: result.text,
        ...(result.structured === undefined
            ? {}
            : { structured: result.structured }),
    };
};

const accessFailure = (
    expected: string,
    actual: string | undefined,
    sessionID: string | undefined,
): TurnOutcome =>
    failure(
        "access",
        `Claude Code started in "${actual ?? "an unknown"}" permission mode instead of "${expected}". ` +
            `The ${expected} mode is not available for this model or account, and continuing would stall on approval prompts. ` +
            "Choose a model that supports it or set approval to yolo for this harness.",
        sessionID,
    );

/** Claude Code through its print mode and `stream-json` events. */
export const makeClaudeCodeAdapter = (deps: {
    readonly runner: CommandRunnerService;
}): HarnessAdapter => ({
    name: "claude",
    capabilities: { nativeSchema: true, budgetCap: true },
    runTurn: async (turn) => {
        const expectedMode = PERMISSION_MODES[turn.access];
        const guard = new AbortController();
        let grantedMode: string | undefined;
        let modeRefused = false;
        const reader = makeClaudeStreamReader({
            onEvent: turn.onEvent,
            onInit: (mode) => {
                grantedMode = mode;
                if (mode === expectedMode) return;
                // Stop before the session can do any work in the wrong mode.
                modeRefused = true;
                guard.abort();
            },
        });
        const signal =
            turn.signal === undefined
                ? guard.signal
                : AbortSignal.any([turn.signal, guard.signal]);
        try {
            const exit = await deps.runner.run(
                EXECUTABLE,
                buildArguments(turn),
                {
                    cwd: turn.directory,
                    timeoutMs: turn.timeoutMs,
                    stdin: turn.prompt,
                    onStdoutLine: reader.feed,
                    trimStdout: false,
                    processGroup: true,
                    signal,
                    ...(turn.env === undefined ? {} : { env: turn.env }),
                },
            );
            return modeRefused
                ? accessFailure(
                      expectedMode,
                      grantedMode,
                      reader.summary().sessionID,
                  )
                : settle(reader.summary(), exit);
        } catch (error) {
            return modeRefused
                ? accessFailure(
                      expectedMode,
                      grantedMode,
                      reader.summary().sessionID,
                  )
                : classifyThrown(error);
        }
    },
});