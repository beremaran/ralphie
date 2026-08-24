import { Data } from "effect";

export class RalphieError extends Data.TaggedError("RalphieError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
