import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    DEFAULT_WORKSPACE,
    DEFAULT_DUPLICATE_ACTION,
    DEFAULT_EXECUTION_MODE,
    DEFAULT_WORKFLOW_MODE,
    DEFAULT_NEEDS_ATTENTION_POLICY,
    NeedsAttentionPolicy,
    DuplicateAction,
    ExecutionMode,
    parsePipelineTimeout,
    resolveRalphieConfig,
    WorkflowMode,
} from "../src/options.ts";

describe("CLI configuration", () => {
    test("requires a positional repository", () => {
        expect(() => resolveRalphieConfig({})).toThrow(
            "Missing repository: provide an owner/repository argument.",
        );
    });

    test("resolves defaults from CLI arguments only", () => {
        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
            }),
        ).toEqual({
            repo: "owner/repo",
            mode: DEFAULT_EXECUTION_MODE,
            workflow: DEFAULT_WORKFLOW_MODE,
            onNeedsAttention: DEFAULT_NEEDS_ATTENTION_POLICY,
            notificationsEnabled: false,
            issueLabels: [],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
            verificationCommands: [],
            agent: "build",
            workspace: DEFAULT_WORKSPACE,
            cleanStart: false,
            cleanEnd: false,
            dryRun: false,
            verbose: false,
            json: false,
            quiet: false,
        });
    });

    test("normalizes clone URLs and applies every override", () => {
        expect(
            resolveRalphieConfig({
                repo: "https://github.com/Owner/Repo.git",
                workflow: WorkflowMode.Pr,
                branch: "develop",
                maxIssues: 3,
                issueLabels: ["bug", "ready"],
                issueSort: IssueSort.Updated,
                issueOrder: IssueOrder.Descending,
                model: {
                    providerID: "openai",
                    modelID: "gpt-5",
                },
                thinking: "high",
                piDir: "/tmp/pi",
                workspace: "/tmp/ralphie",
                clean: "both",
                dryRun: true,
                resume: "/tmp/state.json",
                verbose: true,
                json: true,
                onNeedsAttention: NeedsAttentionPolicy.Continue,
                notifyNeedsAttention: true,
                needsAttentionLabel: "  needs-attention  ",
            }),
        ).toMatchObject({
            repo: "Owner/Repo",
            workflow: WorkflowMode.Pr,
            branch: "develop",
            maxIssues: 3,
            issueLabels: ["bug", "ready"],
            issueSort: IssueSort.Updated,
            issueOrder: IssueOrder.Descending,
            model: {
                providerID: "openai",
                modelID: "gpt-5",
            },
            thinking: "high",
            piDir: "/tmp/pi",
            workspace: "/tmp/ralphie",
            cleanStart: true,
            cleanEnd: true,
            dryRun: true,
            resume: "/tmp/state.json",
            verbose: true,
            json: true,
            quiet: false,
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            notificationsEnabled: true,
            needsAttentionLabel: "needs-attention",
        });
    });

    test("rejects a notification label without explicit notification opt-in", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                needsAttentionLabel: "needs-attention",
            }),
        ).toThrow(
            "Option --needs-attention-label requires --notify-needs-attention.",
        );
    });

    test("maps clean to start, end, or both removal", () => {
        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                clean: "start",
            }),
        ).toMatchObject({
            cleanStart: true,
            cleanEnd: false,
        });
        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                clean: "end",
            }),
        ).toMatchObject({
            cleanStart: false,
            cleanEnd: true,
        });
    });

    test("resolves maintenance mode with shared selection and duplicate defaults", () => {
        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.MaintainIssues,
            }),
        ).toEqual({
            repo: "owner/repo",
            mode: ExecutionMode.MaintainIssues,
            duplicateAction: DEFAULT_DUPLICATE_ACTION,
            issueLabels: [],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
            agent: "build",
            workspace: DEFAULT_WORKSPACE,
            cleanStart: false,
            cleanEnd: false,
            dryRun: false,
            verbose: false,
            json: false,
            quiet: false,
        });

        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.MaintainIssues,
                duplicateAction: DuplicateAction.Close,
                maxIssues: 2,
                issueLabels: ["duplicate"],
            }),
        ).toMatchObject({
            duplicateAction: DuplicateAction.Close,
            maxIssues: 2,
            issueLabels: ["duplicate"],
        });
    });

    test("rejects implementation and pipeline options in maintenance mode", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.MaintainIssues,
                workflow: WorkflowMode.Pr,
            }),
        ).toThrow(
            "Option --workflow is only available in issues mode and cannot be used with --mode maintain-issues.",
        );
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.MaintainIssues,
                verificationCommands: ["bun run check"],
            }),
        ).toThrow("Option --verify-command");
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.MaintainIssues,
                maxAttempts: 1,
            }),
        ).toThrow("Option --max-attempts");
    });

    test("resolves pipeline mode with its own defaults and options", () => {
        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.GetPipelinesGreen,
            }),
        ).toMatchObject({
            mode: ExecutionMode.GetPipelinesGreen,
            maxAttempts: 3,
        });

        expect(
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.GetPipelinesGreen,
                maxAttempts: 5,
                pipelineTimeout: parsePipelineTimeout("10m"),
            }),
        ).toEqual({
            repo: "owner/repo",
            mode: ExecutionMode.GetPipelinesGreen,
            maxAttempts: 5,
            pipelineTimeout: { value: 10, unit: "minutes" },
            agent: "build",
            workspace: DEFAULT_WORKSPACE,
            cleanStart: false,
            cleanEnd: false,
            dryRun: false,
            verbose: false,
            json: false,
            quiet: false,
        });
    });

    test("rejects options from the other execution mode", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.GetPipelinesGreen,
                maxIssues: 1,
            }),
        ).toThrow("--max-issues");
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                mode: ExecutionMode.Issues,
                maxAttempts: 1,
            }),
        ).toThrow("--max-attempts");
    });

    test("rejects incompatible output modes", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                json: true,
                quiet: true,
            }),
        ).toThrow("JSON and quiet output modes cannot be enabled together.");
    });

    test("parses only positive integer pipeline durations", () => {
        expect(parsePipelineTimeout("30s")).toEqual({
            value: 30,
            unit: "seconds",
        });
        expect(parsePipelineTimeout("2h")).toEqual({
            value: 2,
            unit: "hours",
        });
        for (const value of ["0s", "30", "1.5h", "2ms", " 30s", "30s "]) {
            expect(() => parsePipelineTimeout(value)).toThrow(
                "--pipeline-timeout",
            );
        }
    });
});