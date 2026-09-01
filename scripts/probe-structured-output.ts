#!/usr/bin/env bun

import { z } from "zod";

import { requestStructuredOutput } from "../src/agent/structured-output.ts";
import { makeCodexClient } from "../src/codex/client.ts";

const decisionSchema = z.object({
    decision: z.enum(["proceed", "stop"]),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
});

const result = await requestStructuredOutput(makeCodexClient(), {
    directory: process.cwd(),
    title: "Ralphie Codex structured-output probe",
    prompt: "Decide whether two plus two equals four.",
    schema: decisionSchema,
});

console.log(JSON.stringify(result, null, 2));