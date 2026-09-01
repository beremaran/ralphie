import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { piModelSchema, piModelVariantSchema } from "../src/agent/model.ts";
import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import { groundingDecisionSchema } from "../src/issues/decisions.ts";
import { makePiClient } from "../src/pi/client.ts";

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

function usage(): never {
    console.error(
        [
            "Usage: bun run probe:structured-output [options]",
            "",
            "Options:",
            "  --union               Probe with the grounding decision schema (the",
            "                        discriminated union behind issue readiness),",
            "                        flattened exactly as production sends it.",
            "  --model provider/id   Target a specific Pi model.",
            "  --agent name          Target a specific Pi agent.",
            "  --variant level       Pi thinking level (off..max).",
        ].join("\n"),
    );
    process.exit(2);
}

type ProbeOptions = {
    union: boolean;
    model?: string;
    agent?: string;
    variant?: string;
};

const valueFlagKey = (
    flag: string,
): "model" | "agent" | "variant" | undefined => {
    switch (flag) {
        case "--model":
            return "model";
        case "--agent":
            return "agent";
        case "--variant":
            return "variant";
        default:
            return undefined;
    }
};

const parseProbeOptions = (argv: readonly string[]): ProbeOptions => {
    const options: ProbeOptions = { union: false };
    let index = 0;
    while (index < argv.length) {
        const argument = argv[index];
        if (argument === undefined) usage();
        if (argument === "--union") {
            options.union = true;
            index += 1;
            continue;
        }
        const key = valueFlagKey(argument);
        if (key === undefined) usage();
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) usage();
        options[key] = value;
        index += 2;
    }
    return options;
};

const options = parseProbeOptions(process.argv.slice(2));
const client = makePiClient(await ModelRuntime.create());

const runProbe = async <Output>(
    label: string,
    schema: z.ZodType<Output>,
    prompt: string,
): Promise<void> => {
    const result = await requestStructuredOutput(client, {
        directory: process.cwd(),
        title: "Ralphie structured-output probe",
        prompt,
        schema,
        ...(options.model === undefined
            ? {}
            : { model: piModelSchema.parse(options.model) }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.variant === undefined
            ? {}
            : { variant: piModelVariantSchema.parse(options.variant) }),
    });

    console.log(`Probe schema: ${label}`);
    console.log(JSON.stringify(result, null, 2));
};

try {
    if (options.union) {
        await runProbe(
            "grounding decision union (flattened for the wire, as production sends it)",
            groundingDecisionSchema,
            'Return the grounding decision for work that can start right now: use disposition "actionable".',
        );
    } else {
        await runProbe(
            "flat object",
            decisionSchema,
            "Decide whether two plus two equals four. Choose proceed when it does, or stop when it does not.",
        );
    }
} finally {
    client.close?.();
}