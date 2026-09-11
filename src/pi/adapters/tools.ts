import { realpath } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep } from "node:path";

import {
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool,
} from "@earendil-works/pi-agent-core";
import type {
    AgentHarnessTool,
    AgentHarnessToolInvocation,
    AgentTool,
    BeforeToolCallContext,
    BeforeToolCallResult,
    Context,
    ExecutionEnv,
    ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";

import { isDeniedShellResource } from "./permissions.ts";

export type PiToolPolicy = {
    /** Repository checkout the tools are rooted in. */
    readonly directory: string;
    /** Review sessions may read and run allowed shell commands but not edit files. */
    readonly readOnly?: boolean;
};

export type PiToolSet = {
    readonly tools: ReadonlyArray<AgentTool>;
    readonly beforeToolCall: (
        context: BeforeToolCallContext,
        signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    readonly cleanup: () => Promise<void>;
};

type HarnessTool = AgentHarnessTool<ExecutionToolContext>;

/** Harness tools never use the invocation handle; stub it for the core Agent. */
const invocationStub: AgentHarnessToolInvocation = {
    invocationId: "ralphie",
    operationId: "ralphie",
    turnId: "ralphie",
    getMemo: async () => undefined,
    setMemo: async () => undefined,
};

const contextStub = {} as Context;

const adaptTool = (tool: HarnessTool, env: ExecutionEnv): AgentTool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode === undefined
        ? {}
        : { executionMode: tool.executionMode }),
    execute: async (toolCallId, params, _signal, onUpdate) =>
        await tool.execute(
            toolCallId,
            params as never,
            (partial) => onUpdate?.(partial as never),
            { env },
            invocationStub,
            contextStub,
        ),
});

const isWithin = (root: string, candidate: string): boolean =>
    candidate === root ||
    candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Resolve symlinks at the nearest existing ancestor of a possibly missing path. */
const nearestExistingRealPath = async (path: string): Promise<string> => {
    let current = path;
    for (;;) {
        try {
            return await realpath(current);
        } catch {
            const parent = dirname(current);
            if (parent === current) return path;
            current = parent;
        }
    }
};

const pathIsContained = async (
    directory: string,
    requested: string,
): Promise<boolean> => {
    const root = await nearestExistingRealPath(directory);
    const resolved = await nearestExistingRealPath(
        resolvePath(directory, requested),
    );
    return isWithin(root, resolved);
};

const shellBlock = (
    name: string,
    args: { readonly command?: unknown },
): BeforeToolCallResult | undefined => {
    if (
        name !== "bash" ||
        typeof args.command !== "string" ||
        !isDeniedShellResource(args.command)
    ) {
        return undefined;
    }
    return {
        block: true,
        reason: "Ralphie owns git and GitHub mutations; this command is not allowed in an unattended agent session.",
    };
};

const mutationBlock = (
    name: string,
    policy: PiToolPolicy,
): BeforeToolCallResult | undefined => {
    if (policy.readOnly !== true || (name !== "write" && name !== "edit")) {
        return undefined;
    }
    return {
        block: true,
        reason: "This is a read-only review session; file mutations are not allowed.",
    };
};

const pathBlock = async (
    name: string,
    args: { readonly path?: unknown },
    policy: PiToolPolicy,
): Promise<BeforeToolCallResult | undefined> => {
    if (name !== "read" && name !== "write" && name !== "edit") {
        return undefined;
    }
    if (typeof args.path !== "string") return undefined;
    if (await pathIsContained(policy.directory, args.path)) return undefined;
    return {
        block: true,
        reason: `Path "${args.path}" is outside the repository checkout.`,
    };
};

/**
 * Fail-closed tool guard: deny delivery-state shell commands and file access
 * outside the repository checkout before a tool executes.
 */
export const makePiToolGuard =
    (policy: PiToolPolicy) =>
    async (
        context: BeforeToolCallContext,
    ): Promise<BeforeToolCallResult | undefined> => {
        const name = context.toolCall.name;
        const args = context.args as {
            readonly command?: unknown;
            readonly path?: unknown;
        };

        return (
            shellBlock(name, args) ??
            mutationBlock(name, policy) ??
            (await pathBlock(name, args, policy))
        );
    };

/**
 * Build the pi execution tools for one repository checkout.
 *
 * Tools are pi's built-ins rooted at the checkout, wrapped for the core Agent
 * API. Review sessions get read-only file access.
 */
export const makePiTools = (policy: PiToolPolicy): PiToolSet => {
    const env = new NodeExecutionEnv({ cwd: policy.directory });
    const harnessTools = (policy.readOnly === true
        ? [createReadTool(), createBashTool()]
        : [
              createReadTool(),
              createWriteTool(),
              createEditTool(),
              createBashTool(),
          ]) as unknown as ReadonlyArray<HarnessTool>;

    return {
        tools: harnessTools.map((tool) => adaptTool(tool, env)),
        beforeToolCall: makePiToolGuard(policy),
        cleanup: async () => {
            await env.cleanup(contextStub);
        },
    };
};