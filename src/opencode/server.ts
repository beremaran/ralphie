import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

import { RalphieError } from "../shared/error.ts";
import {
    makeOpenCodeClient,
    type AgentClient,
    type AgentEventListener,
    type OpenCodeMessage,
    type OpenCodeTransport,
} from "./client.ts";
import type { OpenCodeProviderConfig } from "./config.ts";

export type OpenCodeRuntime = {
    readonly url: string;
    readonly client: AgentClient;
    readonly close: () => Promise<void>;
};

export type OpenCodeService = {
    readonly start: () => Promise<OpenCodeRuntime>;
};

type OpenCodeHttpClient = ReturnType<typeof OpenCode.make>;

const transportFrom = (client: OpenCodeHttpClient): OpenCodeTransport => ({
    sessionCreate: async (input) => {
        const session = await client.session.create({
            title: input.title,
            agent: input.agent,
            model: input.model,
            location: { directory: input.directory },
        });
        return { id: session.id };
    },
    sessionPrompt: async (input) => {
        await client.session.prompt({
            sessionID: input.sessionID,
            text: input.text,
        });
    },
    sessionWait: async (input) => {
        await client.session.wait(
            { sessionID: input.sessionID },
            input.signal === undefined ? undefined : { signal: input.signal },
        );
    },
    sessionInterrupt: async (input) => {
        await client.session.interrupt({ sessionID: input.sessionID });
    },
    messageList: async (input) => {
        const response = await client.message.list({
            sessionID: input.sessionID,
        });
        const messages = (
            response as unknown as {
                readonly data?: ReadonlyArray<OpenCodeMessage>;
            }
        ).data;
        if (Array.isArray(messages)) return messages;
        if (Array.isArray(response)) {
            return response as unknown as ReadonlyArray<OpenCodeMessage>;
        }
        return [];
    },
    permissionList: async (input) => {
        try {
            const response = await client.permission.list({
                sessionID: input.sessionID,
            });
            if (Array.isArray(response)) {
                return response as unknown as ReadonlyArray<{
                    readonly id: string;
                    readonly sessionID: string;
                    readonly action: string;
                    readonly resources: ReadonlyArray<string>;
                }>;
            }
            return [];
        } catch {
            return [];
        }
    },
    permissionReply: async (input) => {
        await client.permission.reply({
            sessionID: input.sessionID,
            requestID: input.requestID,
            reply: input.reply,
        });
    },
});

const openCodeClientFromConfig = async (
    config: OpenCodeProviderConfig,
): Promise<{ readonly url: string; readonly client: OpenCodeHttpClient }> => {
    if (config.baseUrl !== undefined) {
        const headers =
            config.token === undefined
                ? undefined
                : { authorization: `Bearer ${config.token}` };
        const client = OpenCode.make({
            baseUrl: config.baseUrl,
            ...(headers === undefined ? {} : { headers }),
        });
        try {
            await client.health.get();
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to reach the OpenCode server at ${config.baseUrl}. Start it with \`opencode serve\` and retry.`,
                cause,
            });
        }
        return { url: config.baseUrl, client };
    }
    const endpoint = await Service.discover().catch((cause) => {
        throw new RalphieError({
            message:
                "Failed to discover the OpenCode background service. Start it with `opencode2 serve` and retry.",
            cause,
        });
    });
    if (endpoint === undefined) {
        throw new RalphieError({
            message:
                "No OpenCode background service is running. Start it with `opencode2 serve` and retry.",
        });
    }
    const client = OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint) ?? undefined,
    });
    try {
        await client.health.get();
    } catch (cause) {
        throw new RalphieError({
            message: `Failed to reach the discovered OpenCode server at ${endpoint.url}.`,
            cause,
        });
    }
    return { url: endpoint.url, client };
};

/** Connect to the operator-run external OpenCode server. */
export const makeOpenCodeService = (
    config: OpenCodeProviderConfig,
    eventListener?: AgentEventListener,
): OpenCodeService => ({
    start: async () => {
        try {
            const { url, client } = await openCodeClientFromConfig(config);
            const agent = makeOpenCodeClient(
                transportFrom(client),
                eventListener,
            );
            let closed = false;
            return {
                url,
                client: agent,
                close: async () => {
                    if (closed) return;
                    closed = true;
                    agent.close?.();
                },
            };
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: "Failed to start the OpenCode runtime.",
                cause,
            });
        }
    },
});

export const OpenCodeLive = makeOpenCodeService;