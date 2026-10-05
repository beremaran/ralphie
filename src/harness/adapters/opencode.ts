import {
    CommandAbortedError,
    CommandTimeoutError,
    type CommandRunnerService,
} from "../../process/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import type {
    HarnessAdapter,
    HarnessFailure,
    TurnOutcome,
    TurnRequest,
} from "../ports.ts";
import {
    makeOpenCodeStreamReader,
    type OpenCodeStreamSummary,
} from "./opencode-stream.ts";

const EXECUTABLE = "opencode";

/**
 * OpenCode has no sandbox and no attended-but-safe mode, so editing is only
 * offered as yolo (`--auto`). Read-only uses the built-in `plan` agent, which
 * denies edit tools but, as of v2.0.22, still allows shell commands.
 */
const accessArguments = (
    access: TurnRequest["access"],
): readonly string[] | undefined => {
    switch (access) {
        case "read-only":
            return ["--agent", "plan"];
        case "yolo":
            return ["--auto"];
        case "safe":
            return undefined;
    }
};

/** `provider/model#variant`; OpenCode has no separate effort flag. */
const modelArgument = (turn: TurnRequest): readonly string[] => {
    if (turn.model === undefined) return [];
    const variant = turn.effort === undefined ? "" : `#${turn.effort}`;
    return ["--model", `${turn.model}${variant}`];
};

/**
 * Always `--standalone`: a private server picks up this invocation's working
 * directory and environment instead of the shared background service's. The
 * prompt travels on stdin; with none, OpenCode refuses to start.
 */
const buildArguments = (
    turn: TurnRequest,
    access: readonly string[],
): readonly string[] => [
    "run",
    "--standalone",
    "--format",
    "json",
    ...access,
    ...modelArgument(turn),
    ...(turn.resumeSessionID === undefined
        ? []
        : ["--session", turn.resumeSessionID]),
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

const errorKind = (type: string | undefined): HarnessFailure["kind"] =>
    type !== undefined && /no-route|model/u.test(type) ? "model" : "harness";

/**
 * OpenCode has no terminal result event: a run succeeded when it exited 0,
 * printed no `error` event, and produced a final message.
 */
const settle = (
    summary: OpenCodeStreamSummary,
    exit: { readonly exitCode: number; readonly stderr: string },
): TurnOutcome => {
    const { sessionID, text, error } = summary;
    if (error !== undefined) {
        return failure(errorKind(error.type), error.message, sessionID);
    }
    if (exit.exitCode !== 0) {
        const detail = exit.stderr === "" ? "" : `: ${exit.stderr}`;
        return failure(
            "exit",
            `OpenCode exited with code ${exit.exitCode}${detail}`,
            sessionID,
        );
    }
    if (text === undefined || sessionID === undefined) {
        return failure(
            "harness",
            "OpenCode ended without reporting a result.",
            sessionID,
        );
    }
    return { ok: true, harnessSessionID: sessionID, text };
};

/** OpenCode v2 through `opencode run --format json`. */
export const makeOpenCodeAdapter = (deps: {
    readonly runner: CommandRunnerService;
}): HarnessAdapter => ({
    name: "opencode",
    capabilities: { nativeSchema: false, budgetCap: false },
    runTurn: async (turn) => {
        const access = accessArguments(turn.access);
        if (access === undefined) {
            return failure(
                "access",
                'OpenCode has no safe edit mode; editing sessions need access "yolo" for this harness.',
            );
        }
        const reader = makeOpenCodeStreamReader({ onEvent: turn.onEvent });
        try {
            const exit = await deps.runner.run(
                EXECUTABLE,
                buildArguments(turn, access),
                {
                    cwd: turn.directory,
                    timeoutMs: turn.timeoutMs,
                    stdin: turn.prompt,
                    onStdoutLine: reader.feed,
                    trimStdout: false,
                    ...(turn.signal === undefined
                        ? {}
                        : { signal: turn.signal }),
                    ...(turn.env === undefined ? {} : { env: turn.env }),
                },
            );
            reader.finish();
            return settle(reader.summary(), exit);
        } catch (error) {
            return classifyThrown(error);
        }
    },
});