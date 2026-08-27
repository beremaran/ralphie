import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "../issues/execution.ts";
import { RalphieError } from "../shared/error.ts";
import { WorkflowMode } from "../options.ts";

export const RUN_STATE_VERSION = 2 as const;

export enum RunStateStatus {
    Active = "active",
    Complete = "complete",
}

const issueSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.string()),
});

const currentOutcomeSchema = z.union([
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Completed),
        completion: z.literal("pushed-commit"),
        commitSha: z.string().min(1),
        reviewCount: z.number().int().positive().optional(),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Completed),
        completion: z.literal("already-resolved"),
        resolutionSummary: z.string().min(1),
        evidence: z.array(z.string().min(1)).min(1),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Decomposed),
        childIssueNumbers: z.array(z.number().int().positive()),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Escalated),
        diagnosticsPath: z.string().min(1),
        reason: z.string().min(1),
        childIssueNumbers: z.array(z.number().int().positive()).optional(),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Skipped),
        reason: z.string().min(1),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Failed),
        message: z.string().min(1),
    }),
]);

const outcomeSchema = z.preprocess((value) => {
    if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === IssueExecutionOutcomeKind.Completed &&
        !("completion" in value) &&
        "commitSha" in value
    ) {
        return {
            ...value,
            completion: "pushed-commit",
        };
    }
    return value;
}, currentOutcomeSchema);

export const runStateSchema = z.object({
    version: z.literal(RUN_STATE_VERSION),
    status: z.enum(RunStateStatus),
    runId: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    workflow: z.enum(WorkflowMode).optional(),
    dryRun: z.boolean().optional(),
    selection: z.object({
        agent: z.string().min(1),
        model: z
            .object({
                providerID: z.string().min(1),
                modelID: z.string().min(1),
            })
            .optional(),
        variant: z.string().min(1).optional(),
    }),
    maxIssues: z.number().int().positive().optional(),
    queue: z.object({
        pending: z.array(issueSchema),
        completedIssueNumbers: z.array(z.number().int().positive()),
        processedCount: z.number().int().nonnegative(),
    }),
    outcomes: z.array(
        z.object({
            issueNumber: z.number().int().positive(),
            outcome: outcomeSchema,
        }),
    ),
    activeIssue: z
        .object({
            issueNumber: z.number().int().positive(),
            stage: z.string().min(1),
        })
        .optional(),
    checkout: z
        .object({
            branch: z.string().min(1),
            head: z.string().min(1),
        })
        .optional(),
    updatedAt: z.string().datetime(),
});

export type RunState = z.infer<typeof runStateSchema>;

export type RunStateStoreService = {
    readonly save: (path: string, state: RunState) => Promise<void>;
    readonly load: (path: string) => Promise<RunState>;
};

export const RunStateStoreLive: RunStateStoreService = {
    save: async (path, state) => {
        try {
            const validated = runStateSchema.parse(state);
            await mkdir(dirname(path), { recursive: true });
            const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
            await writeFile(
                temporaryPath,
                `${JSON.stringify(validated, null, 2)}\n`,
                {
                    flag: "wx",
                },
            );
            await rename(temporaryPath, path);
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to persist run state at ${path}.`,
                cause,
            });
        }
    },

    load: async (path) => {
        try {
            return runStateSchema.parse(
                JSON.parse(await readFile(path, "utf8")),
            );
        } catch (cause) {
            throw new RalphieError({
                message: `Run state at ${path} is invalid or unreadable.`,
                cause,
            });
        }
    },
};