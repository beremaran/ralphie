import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { Context, Effect, Layer } from "effect";

import { RalphieError } from "../shared/error.ts";

export type OpenCodeServer = {
  readonly url: string;
  readonly client: OpencodeClient;
  readonly close: () => void;
};

export type OpenCodeService = {
  readonly start: Effect.Effect<OpenCodeServer, RalphieError>;
};

export const OpenCode =
  Context.GenericTag<OpenCodeService>("ralphie/OpenCode");

export const OpenCodeLive = Layer.succeed(OpenCode, {
  start: Effect.tryPromise({
    try: async () => {
      const instance = await createOpencode();
      return {
        url: instance.server.url,
        client: instance.client,
        close: () => instance.server.close(),
      };
    },
    catch: (cause) =>
      new RalphieError({
        message: "Failed to start the OpenCode server.",
        cause,
      }),
  }),
});
