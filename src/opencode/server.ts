import { createOpencodeServer } from "@opencode-ai/sdk";
import { Context, Effect, Layer } from "effect";

import { RalphieError } from "../shared/error.ts";

export type OpenCodeServer = {
  readonly url: string;
  readonly close: () => void;
};

export type OpenCodeService = {
  readonly start: Effect.Effect<OpenCodeServer, RalphieError>;
};

export const OpenCode =
  Context.GenericTag<OpenCodeService>("ralphie/OpenCode");

export const OpenCodeLive = Layer.succeed(OpenCode, {
  start: Effect.tryPromise({
    try: () => createOpencodeServer(),
    catch: (cause) =>
      new RalphieError({
        message: "Failed to start the OpenCode server.",
        cause,
      }),
  }),
});
