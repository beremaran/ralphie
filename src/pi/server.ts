import { ModelRuntime as ModelRuntimeClass } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { join } from "node:path";

import { RalphieError } from "../shared/error.ts";
import {
  cleanupPiAgentDir,
  resolvePiAgentDir,
  type PiProviderConfig,
} from "./config.ts";
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

/**
 * Build the Pi layer for a resolved run configuration.
 *
 * Unlike a static `Layer.succeed`, this factory resolves (and, for Option B,
 * writes) the agent directory from the run's model configuration so that
 * credentials never leak into the operator's real Pi home.
 */
export const PiLive = (config: PiProviderConfig) =>
  Layer.effect(
    Pi,
    Effect.gen(function* () {
      const resolved = yield* Effect.tryPromise(() =>
        resolvePiAgentDir(config),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RalphieError({
              message: "Failed to configure the Pi runtime.",
              cause,
            }),
        ),
      );

      let client: PiClient | undefined;

      const start: Effect.Effect<PiRuntime, RalphieError> = Effect.tryPromise(
        () =>
          ModelRuntimeClass.create({
            authPath: resolved.authPath,
            modelsPath: resolved.modelsPath,
          }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RalphieError({
              message: "Failed to start the Pi runtime.",
              cause,
            }),
        ),
        Effect.map((modelRuntime) => {
          client = makePiClient(modelRuntime);
          return {
            url: "embedded://pi",
            client,
            close: () => {
              client?.close?.();
              if (resolved.cleanup) void cleanupPiAgentDir(resolved.dir);
            },
          };
        }),
      );

      return {
        start,
      };
    }),
  );