import { type CommandRunnerService } from "../../process/ports.ts";
import type { HarnessAdapter, TurnOutcome, TurnRequest } from "../ports.ts";
import { makePiStreamReader, type PiStreamSummary } from "./pi-cli-stream.ts";
import { classifyThrown, failure } from "./outcome.ts";

const EXECUTABLE = "pi";

/**
 * Tools a read-only session may use. Pi has no approval system and no plan
 * mode, so withholding the editing and shell tools is the only restriction.
 */
const READ_ONLY_TOOLS = "read,grep,find,ls";

const optionalFlag = (
    flag: string,
    value: string | undefined,
): readonly string[] => (value === undefined ? [] : [flag, value]);

/**
 * Command line for one turn. The prompt travels on stdin. Pi never asks for
 * approval, so editing is only offered as `yolo`; `safe` is refused before
 * this is built.
 */
const buildArguments = (turn: TurnRequest): readonly string[] => [
    "-p",
    "--mode",
    "json",
    ...(turn.access === "read-only" ? ["--tools", READ_ONLY_TOOLS] : []),
    ...optionalFlag("--model", turn.model),
    ...optionalFlag("--thinking", turn.effort),
    ...optionalFlag("--session", turn.resumeSessionID),
];

/**
 * Settle a finished process. Pi exits 0 even when the response failed, so
 * the last assistant message decides, not the exit code. Earlier errors that
 * a retry recovered from do not count.
 */
const settle = (
    summary: PiStreamSummary,
    exit: { readonly exitCode: number; readonly stderr: string },
): TurnOutcome => {
    const { final, sessionID } = summary;
    const detail = exit.stderr === "" ? "" : `: ${exit.stderr}`;
    if (final === undefined) {
        return exit.exitCode === 0
            ? failure("harness", "pi ended without a response.", sessionID)
            : failure(
                  "exit",
                  `pi exited with code ${exit.exitCode}${detail}`,
                  sessionID,
              );
    }
    if (final.failed) {
        return failure("harness", final.errorMessage, sessionID);
    }
    if (exit.exitCode !== 0) {
        return failure(
            "exit",
            `pi exited with code ${exit.exitCode} after responding${detail}`,
            sessionID,
        );
    }
    return { ok: true, harnessSessionID: sessionID, text: final.text };
};

/**
 * The pi CLI in `--mode json`. Pi has no native schema output, so structured
 * results use the service's JSON block fallback, and no spend cap.
 */
export const makePiCliAdapter = (deps: {
    readonly runner: CommandRunnerService;
}): HarnessAdapter => ({
    name: "pi",
    capabilities: { nativeSchema: false, budgetCap: false },
    runTurn: async (turn) => {
        if (turn.access === "safe") {
            return failure(
                "access",
                'pi has no safe edit mode; editing sessions need access "yolo" for this harness.',
            );
        }
        const reader = makePiStreamReader({ onEvent: turn.onEvent });
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
                    ...(turn.signal === undefined
                        ? {}
                        : { signal: turn.signal }),
                    ...(turn.env === undefined ? {} : { env: turn.env }),
                },
            );
            return settle(reader.finish(), exit);
        } catch (error) {
            return classifyThrown(error);
        }
    },
});