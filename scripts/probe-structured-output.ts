import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { z } from "zod";

import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import { makePiClient } from "../src/pi/client.ts";

enum ProbeDecision {
  Proceed = "proceed",
  Stop = "stop",
}

const decisionSchema = z.object({
  decision: z.enum(ProbeDecision).describe("Whether the stated condition is true."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the decision, from 0 to 1."),
  reason: z.string().min(1).describe("A short explanation for the decision."),
});

const client = makePiClient(await ModelRuntime.create());

try {
  const result = await requestStructuredOutput(client, {
    directory: process.cwd(),
    title: "Ralphie structured-output probe",
    prompt:
      "Decide whether two plus two equals four. Choose proceed when it does, or stop when it does not.",
    schema: decisionSchema,
  }).pipe(Effect.runPromise);

  console.log(JSON.stringify(result, null, 2));
} finally {
  client.close?.();
}
