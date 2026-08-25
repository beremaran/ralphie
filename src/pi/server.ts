import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { join } from "node:path";

import { RalphieError } from "../shared/error.ts";
import { makePiClient, type PiClient } from "./client.ts";

export type PiRuntime = {
  readonly url: string;
  readonly client: PiClient;
  readonly close: () => void;
};

export type PiService = {
  readonly start: Effect.Effect<PiRuntime, RalphieError>;
};

export const Pi = Context.GenericTag<PiService>("ralphie/Pi");

export const PiLive = Layer.succeed(Pi, {
  start: Effect.tryPromise({
    try: async () => {
      const agentDir = getAgentDir();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const client = makePiClient(modelRuntime);
      return {
        url: "embedded://pi",
        client,
        close: client.close ?? (() => undefined),
      };
    },
    catch: (cause) =>
      new RalphieError({
        message: "Failed to start the Pi runtime.",
        cause,
      }),
  }),
});
