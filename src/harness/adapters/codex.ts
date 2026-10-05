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
    makeCodexStreamReader,
    type CodexStreamSummary,
} from "./codex-stream.ts";
import type { SchemaFile, SchemaFileWriter } from "./schema-file.ts";

const EXECUTABLE = "codex";

const optionalFlag = (
    flag: string,
    value: string | number | undefined,
): readonly string[] => (value === undefined ? [] : [flag, String(value)]);

/**
 * Sandbox flags. `exec resume` has no `--sandbox`, so a resumed turn sets the
 * same policy through `-c`. Safe mode opens network access inside the
 * workspace sandbox, because verification and package installs need it.
 */
const sandboxArguments = (
    access: SessionAccess,
    resumed: boolean,
): readonly string[] => {
    if (access === "yolo") {
        return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    const mode = access === "safe" ? "workspace-write" : "read-only";
    const select = resumed
        ? ["-c", `sandbox_mode="${mode}"`]
        : ["--sandbox", mode];
    return access === "safe"
        ? [...select, "-c", "sandbox_workspace_write.network_access=true"]
        : select;
};

/**
 * Command line for one turn. The prompt travels on stdin through `-`, and no
 * prompt argument is given alongside piped stdin.
 */
const buildArguments = (
    turn: TurnRequest,
    schemaPath: string | undefined,
): readonly string[] => [
    "exec",
    ...(turn.resumeSessionID === undefined ? [] : ["resume"]),
    "--json",
    ...sandboxArguments(turn.access, turn.resumeSessionID !== undefined),
    ...optionalFlag("--model", turn.model),
    ...(turn.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort="${turn.effort}"`]),
    ...optionalFlag("--output-schema", schemaPath),
    ...(turn.resumeSessionID === undefined ? [] : [turn.resumeSessionID]),
    "-",
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

const MODEL_REJECTION = /model.*(not supported|not found|does not exist)/i;

const parseStructured = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        // Not JSON: the service asks the session to correct itself.
        return undefined;
    }
};

const unfinished = (
    summary: CodexStreamSummary,
    exit: { readonly exitCode: number; readonly stderr: string },
): TurnOutcome => {
    const detail = exit.stderr === "" ? "" : `: ${exit.stderr}`;
    return exit.exitCode === 0
        ? failure(
              "harness",
              "Codex ended without completing the turn.",
              summary.threadID,
          )
        : failure(
              "exit",
              `Codex exited with code ${exit.exitCode}${detail}`,
              summary.threadID,
          );
};

/** Settle a finished process: a reported turn outcome wins over the exit code. */
const settle = (
    summary: CodexStreamSummary,
    exit: { readonly exitCode: number; readonly stderr: string },
    wantsSchema: boolean,
): TurnOutcome => {
    const { threadID, failureMessage } = summary;
    if (failureMessage !== undefined) {
        return failure(
            MODEL_REJECTION.test(failureMessage) ? "model" : "harness",
            failureMessage,
            threadID,
        );
    }
    if (!summary.completed) return unfinished(summary, exit);
    if (exit.exitCode !== 0) {
        return failure(
            "exit",
            `Codex exited with code ${exit.exitCode} after completing the turn.`,
            threadID,
        );
    }
    const text = summary.finalText ?? "";
    const structured = wantsSchema ? parseStructured(text) : undefined;
    return {
        ok: true,
        harnessSessionID: threadID,
        text,
        ...(structured === undefined ? {} : { structured }),
    };
};

/** Codex through `codex exec --json`. */
export const makeCodexAdapter = (deps: {
    readonly runner: CommandRunnerService;
    readonly schemaFiles: SchemaFileWriter;
}): HarnessAdapter => ({
    name: "codex",
    capabilities: { nativeSchema: true, budgetCap: false },
    runTurn: async (turn) => {
        let schemaFile: SchemaFile | undefined;
        try {
            schemaFile =
                turn.jsonSchema === undefined
                    ? undefined
                    : await deps.schemaFiles.write(
                          JSON.stringify(turn.jsonSchema),
                      );
            const reader = makeCodexStreamReader({ onEvent: turn.onEvent });
            const exit = await deps.runner.run(
                EXECUTABLE,
                buildArguments(turn, schemaFile?.path),
                {
                    cwd: turn.directory,
                    timeoutMs: turn.timeoutMs,
                    stdin: turn.prompt,
                    onStdoutLine: reader.feed,
                    trimStdout: false,
                    processGroup: true,
                    ...(turn.signal === undefined
                        ? {}
                        : { signal: turn.signal }),
                    ...(turn.env === undefined ? {} : { env: turn.env }),
                },
            );
            return settle(reader.summary(), exit, schemaFile !== undefined);
        } catch (error) {
            return classifyThrown(error);
        } finally {
            await schemaFile?.dispose();
        }
    },
});