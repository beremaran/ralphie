import { createOpencode } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";
import { z } from "zod";

import { requestStructuredOutput } from "../src/opencode/structured-output.ts";

enum ProbeDecision {
  Proceed = "proceed",
  Stop = "stop",
}

const decisionSchema = z.object({
  decision: z
    .enum(ProbeDecision)
    .describe("Whether the stated condition is true."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the decision, from 0 to 1."),
  reason: z.string().min(1).describe("A short explanation for the decision."),
});

const instance = await createOpencode();

try {
  const result = await requestStructuredOutput(instance.client, {
    directory: process.cwd(),
    title: "Ralphie structured-output probe",
    prompt:
      "Decide whether two plus two equals four. Choose proceed when it does, or stop when it does not.",
    schema: decisionSchema,
  }).pipe(Effect.runPromise);

  console.log(JSON.stringify(result, null, 2));
} finally {
  instance.server.close();
}
