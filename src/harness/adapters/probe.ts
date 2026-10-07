import {
    CommandAbortedError,
    type CommandRunnerService,
} from "../../process/ports.ts";
import type { HarnessAdapter, HarnessProbe, ProbeResult } from "../ports.ts";
import { errorMessage } from "../../shared/error.ts";

/** Startup probes must answer within seconds, never wait on a model. */
export const PROBE_TIMEOUT_MS = 15_000;

type Dependencies = {
    readonly runner: CommandRunnerService;
    readonly adapters: Readonly<Record<string, HarnessAdapter>>;
};

/** The oldest release of each harness CLI Ralphie is verified against. */
export const MINIMUM_HARNESS_VERSIONS: Readonly<Record<string, string>> = {
    claude: "2.1.289",
    codex: "0.160.0",
    opencode: "2.0.22",
    pi: "1.0.2",
};

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

const parseVersion = (output: string): ReadonlyArray<number> | undefined => {
    const match = VERSION_PATTERN.exec(output);
    return match === null
        ? undefined
        : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isOlder = (
    actual: ReadonlyArray<number>,
    minimum: ReadonlyArray<number>,
): boolean => {
    for (const [index, part] of minimum.entries()) {
        const found = actual[index] ?? 0;
        if (found !== part) return found < part;
    }
    return false;
};

/** Compare `--version` output with the harness's minimum version. */
const versionResult = (executable: string, output: string): ProbeResult => {
    const minimum = MINIMUM_HARNESS_VERSIONS[executable];
    if (minimum === undefined) return { ok: true };
    const actual = parseVersion(output);
    if (actual === undefined) {
        return {
            ok: true,
            warning: `Could not read the ${executable} version from its --version output; Ralphie needs ${executable} ${minimum} or newer.`,
        };
    }
    const required = parseVersion(minimum) ?? [];
    return isOlder(actual, required)
        ? {
              ok: false,
              message: `${executable} ${actual.join(".")} is older than the minimum supported ${executable} ${minimum}; upgrade ${executable} to ${minimum} or newer`,
          }
        : { ok: true };
};

const installed = async (
    runner: CommandRunnerService,
    executable: string,
): Promise<ProbeResult> => {
    try {
        const result = await runner.run(executable, ["--version"], {
            timeoutMs: PROBE_TIMEOUT_MS,
            processGroup: true,
        });
        return result.exitCode === 0
            ? versionResult(executable, `${result.stdout}\n${result.stderr}`)
            : {
                  ok: false,
                  message: `${executable} --version exited with code ${result.exitCode}`,
              };
    } catch (error) {
        return { ok: false, message: errorMessage(error) };
    }
};

/** The permission mode a stream-json init line reports, if it is one. */
const initPermissionMode = (line: string): string | undefined => {
    try {
        const record: unknown = JSON.parse(line);
        if (
            typeof record === "object" &&
            record !== null &&
            "type" in record &&
            record.type === "system" &&
            "subtype" in record &&
            record.subtype === "init" &&
            "permissionMode" in record &&
            typeof record.permissionMode === "string"
        ) {
            return record.permissionMode;
        }
    } catch {
        // Not a JSON line; keep waiting for the init event.
    }
    return undefined;
};

/**
 * Claude Code reports the permission mode it actually granted in its init
 * event, before any model call. Start a session in auto mode and stop it as
 * soon as that event arrives. Auto mode can be silently refused (for example
 * on models or plans that do not support it), which is why it is probed.
 */
const claudeSafeAccess = async (
    runner: CommandRunnerService,
): Promise<ProbeResult> => {
    const stop = new AbortController();
    let granted: string | undefined;
    try {
        await runner.run(
            "claude",
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "auto",
            ],
            {
                stdin: "Reply with ok.",
                timeoutMs: PROBE_TIMEOUT_MS,
                processGroup: true,
                signal: stop.signal,
                onStdoutLine: (line) => {
                    const mode = initPermissionMode(line);
                    if (mode === undefined) return;
                    granted = mode;
                    stop.abort();
                },
            },
        );
    } catch (error) {
        if (!(error instanceof CommandAbortedError)) {
            return { ok: false, message: errorMessage(error) };
        }
    }
    if (granted === "auto") return { ok: true };
    return {
        ok: false,
        message:
            granted === undefined
                ? "Claude Code did not report its permission mode"
                : `Claude Code granted ${granted} mode instead of auto`,
    };
};

/** Probes the harness CLIs through the process port. */
export const makeHarnessProbe = ({
    runner,
    adapters,
}: Dependencies): HarnessProbe => ({
    capabilities: (name) => adapters[name]?.capabilities,
    installed: (name) => installed(runner, name),
    safeAccess: async (name) =>
        name === "claude" ? await claudeSafeAccess(runner) : { ok: true },
});