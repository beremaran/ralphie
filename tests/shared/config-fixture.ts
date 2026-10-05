import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    runCommand,
    type CommandFactories,
    type RunCommandInput,
} from "../../src/command.ts";
import type { WorkflowOptions } from "../../src/workflow/ports.ts";
import { makeTestProgressRecorder } from "./progress-recorder.ts";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

/** A temporary directory removed after the current test. */
export const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-config-"));
    directories.push(directory);
    return directory;
};

/** Write `content` to `relativePath` under a fresh temporary directory. */
export const writeTemporaryFile = async (
    content: string,
    relativePath = "config.yaml",
): Promise<string> => {
    const path = join(await temporaryDirectory(), relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
};

/** Fakes for everything after configuration, recording the workflow options. */
export const recordingFactories = (
    record: (options: WorkflowOptions) => void,
    overrides: CommandFactories = {},
): CommandFactories => ({
    makeCoordinator: () => ({
        progress: makeTestProgressRecorder([]),
        piListener: () => {},
        ready: Promise.resolve(),
        dispose: async () => {},
    }),
    makeAgentRuntime: () => ({
        start: async () => undefined as never,
    }),
    makeRuntime: () => ({}) as never,
    runWorkflow: async (options) => {
        record(options);
        return undefined as never;
    },
    githubLogin: async () => {
        throw new Error("unexpected gh login lookup");
    },
    ...overrides,
});

/**
 * Run the command with an isolated environment and return the options the
 * workflow received. No real config location or gh login is consulted.
 */
export const workflowOptionsFor = async (
    args: ReadonlyArray<string>,
    input: Omit<RunCommandInput, "factories"> & {
        readonly factories?: CommandFactories;
    } = {},
): Promise<WorkflowOptions> => {
    let captured: WorkflowOptions | undefined;
    try {
        await runCommand(args, {
            environment: {},
            homeDirectory: "/nonexistent/ralphie-test-home",
            ...input,
            factories: recordingFactories((options) => {
                captured = options;
            }, input.factories),
        });
    } finally {
        process.exitCode = 0;
    }
    if (captured === undefined) throw new Error("workflow did not run");
    return captured;
};
