import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HELP_TEXT, parseCliArgs, runCommand } from "../src/command.ts";
import {
    DuplicateAction,
    ExecutionMode,
    NeedsAttentionPolicy,
    WorkflowMode,
} from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import { RUN_STATE_VERSION, RunStateStatus } from "../src/run/state.ts";

describe("native CLI parser", () => {
    test("documents maintenance mode and duplicate policy in help", () => {
        expect(HELP_TEXT).toContain("maintain-issues");
        expect(HELP_TEXT).toContain("--duplicate-action");
        expect(HELP_TEXT).toContain("--on-needs-attention <halt|continue>");
        expect(HELP_TEXT).toContain("default halt");
        expect(HELP_TEXT).toContain("default link");
    });

    test("parses positional repository, repeatable labels, flags, and values", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--workflow",
            "pr",
            "--issue-label",
            "bug",
            "--issue-label=ready",
            "--max-issues",
            "3",
            "--dry-run",
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            mode: ExecutionMode.Issues,
            workflow: WorkflowMode.Pr,
            issueLabels: ["bug", "ready"],
            maxIssues: 3,
            dryRun: true,
        });
    });

    test("parses and validates the needs-attention policy", () => {
        expect(
            parseCliArgs(["owner/repository"]).options.onNeedsAttention,
        ).toBeUndefined();
        expect(
            parseCliArgs([
                "owner/repository",
                "--on-needs-attention",
                "continue",
            ]).options.onNeedsAttention,
        ).toBe(NeedsAttentionPolicy.Continue);
        expect(() =>
            parseCliArgs(["owner/repository", "--on-needs-attention", "retry"]),
        ).toThrow();
    });

    test("rejects a conflicting resume policy before creating runtime resources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-command-"));
        const path = join(directory, "state.json");
        const sideEffects: string[] = [];
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: RUN_STATE_VERSION,
                    status: RunStateStatus.Active,
                    runId: "run-1",
                    repository: "owner/repository",
                    branch: "main",
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    selection: { agent: "build" },
                    queue: {
                        pending: [],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    updatedAt: "2026-08-24T00:00:00.000Z",
                }),
            );
            await expect(
                runCommand(
                    [
                        "owner/repository",
                        "--resume",
                        path,
                        "--on-needs-attention",
                        "halt",
                    ],
                    {
                        factories: {
                            makeCoordinator: () => {
                                sideEffects.push("coordinator");
                                throw new Error("unexpected side effect");
                            },
                        },
                    },
                ),
            ).rejects.toThrow("saved on-needs-attention policy is continue");
            expect(sideEffects).toEqual([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("parses maintenance mode and duplicate policy", () => {
        expect(
            parseCliArgs(["owner/repository", "--mode", "maintain-issues"])
                .options,
        ).toMatchObject({
            mode: ExecutionMode.MaintainIssues,
            duplicateAction: DuplicateAction.Link,
        });
        expect(
            parseCliArgs([
                "owner/repository",
                "--mode",
                "maintain-issues",
                "--duplicate-action",
                "close",
            ]).options,
        ).toMatchObject({
            mode: ExecutionMode.MaintainIssues,
            duplicateAction: DuplicateAction.Close,
        });
    });

    test("rejects duplicate policy in issue mode and workflow in maintenance mode", () => {
        expect(() =>
            parseCliArgs(["owner/repository", "--duplicate-action", "close"]),
        ).toThrow(
            "Option --duplicate-action is only available in maintain-issues mode and cannot be used with --mode issues.",
        );
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--mode",
                "maintain-issues",
                "--workflow",
                "pr",
            ]),
        ).toThrow(
            "Option --workflow is only available in issues mode and cannot be used with --mode maintain-issues.",
        );
    });

    test("parses pipeline mode and its options", () => {
        expect(
            parseCliArgs([
                "owner/repository",
                "--mode",
                "get-pipelines-green",
                "--max-attempts",
                "5",
                "--pipeline-timeout",
                "10m",
            ]).options,
        ).toMatchObject({
            mode: ExecutionMode.GetPipelinesGreen,
            maxAttempts: 5,
            pipelineTimeout: { value: 10, unit: "minutes" },
        });
    });

    test("rejects unknown and extra arguments", () => {
        expect(() => parseCliArgs(["owner/repository", "extra"])).toThrow(
            "Unexpected argument",
        );
        expect(() => parseCliArgs(["owner/repository", "--unknown"])).toThrow();
    });

    test("rejects non-positive pipeline attempt counts", () => {
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--mode",
                "get-pipelines-green",
                "--max-attempts",
                "0",
            ]),
        ).toThrow();
    });

    test("rejects issue flags in pipeline mode and pipeline flags in issue mode", () => {
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--mode",
                "get-pipelines-green",
                "--issue-sort",
                "invalid",
            ]),
        ).toThrow(
            "Option --issue-sort is only available in issues mode and cannot be used with --mode get-pipelines-green.",
        );
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--mode",
                "get-pipelines-green",
                "--issue-label",
                "",
            ]),
        ).toThrow(
            "Option --issue-label is only available in issues mode and cannot be used with --mode get-pipelines-green.",
        );
        expect(() =>
            parseCliArgs(["owner/repository", "--max-attempts", "2"]),
        ).toThrow("--max-attempts");
    });

    test("parses compound issue sort and validates enums", () => {
        expect(
            parseCliArgs(["owner/repository", "--issue-sort", "updated:desc"])
                .options,
        ).toMatchObject({
            issueSort: IssueSort.Updated,
            issueOrder: IssueOrder.Descending,
        });
        expect(
            parseCliArgs(["owner/repository", "--issue-sort", "created"])
                .options,
        ).toMatchObject({
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
        });
        expect(() =>
            parseCliArgs(["owner/repository", "--issue-sort", "invalid"]),
        ).toThrow();
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--issue-sort",
                "created:sideways",
            ]),
        ).toThrow();
        expect(String(IssueSort.Created)).toBe("created");
        expect(String(IssueOrder.Ascending)).toBe("asc");
    });

    test("parses clean and output modes", () => {
        expect(
            parseCliArgs(["owner/repository", "--clean", "both"]).options,
        ).toMatchObject({
            clean: "both",
            verbose: false,
            json: false,
            quiet: false,
        });
        expect(
            parseCliArgs(["owner/repository", "--output", "json"]).options,
        ).toMatchObject({
            json: true,
            quiet: false,
        });
        expect(
            parseCliArgs(["owner/repository", "--output", "quiet"]).options,
        ).toMatchObject({
            json: false,
            quiet: true,
        });
        expect(() =>
            parseCliArgs(["owner/repository", "--clean", "sometimes"]),
        ).toThrow();
        expect(() =>
            parseCliArgs(["owner/repository", "--output", "trace"]),
        ).toThrow();
    });
});