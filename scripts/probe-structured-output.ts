import { z } from "zod";

import {
    agentModelSchema,
    agentModelVariantSchema,
} from "../src/agent/model.ts";
import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import { groundingDecisionSchema } from "../src/issues/decisions.ts";
import { makeOpenCodeService } from "../src/opencode/server.ts";

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
            "                        discriminated union behind issue readiness).",
            "  --model provider/id   Target a specific OpenCode model.",
            "  --agent name          Target a specific OpenCode agent.",
            "  --variant name        OpenCode model variant.",
            "  --url <url>           OpenCode server URL (defaults to discovered service).",
        ].join("\n"),
    );
    process.exit(2);
}

type ProbeOptions = {
    union: boolean;
    model?: string;
    agent?: string;
    variant?: string;
    url?: string;
};

const valueFlagKey = (
    flag: string,
): "model" | "agent" | "variant" | "url" | undefined => {
    switch (flag) {
        case "--model":
            return "model";
        case "--agent":
            return "agent";
        case "--variant":
            return "variant";
        case "--url":
            return "url";
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
const service = makeOpenCodeService({
    workspace: process.cwd(),
    ...(options.url === undefined ? {} : { baseUrl: options.url }),
});
const runtime = await service.start();
const client = runtime.client;

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
            : { model: agentModelSchema.parse(options.model) }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.variant === undefined
            ? {}
            : { variant: agentModelVariantSchema.parse(options.variant) }),
    });

    console.log(`Probe schema: ${label}`);
    console.log(JSON.stringify(result, null, 2));
};

try {
    if (options.union) {
        await runProbe(
            "grounding decision union",
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
    await runtime.close();
}