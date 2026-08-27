import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../src/command.ts";
import { WorkflowMode } from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";

describe("native CLI parser", () => {
    test("parses positional repository, repeatable labels, flags, and values", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--workflow",
            "parallel-pr",
            "--issue-label",
            "bug",
            "--issue-label=ready",
            "--issue-concurrency",
            "2",
            "--max-issues",
            "3",
            "--dry-run",
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            workflow: WorkflowMode.ParallelPr,
            issueLabels: ["bug", "ready"],
            issueConcurrency: 2,
            maxIssues: 3,
            dryRun: true,
        });
    });

    test("rejects unknown and extra arguments", () => {
        expect(() => parseCliArgs(["owner/repository", "extra"])).toThrow(
            "Unexpected argument",
        );
        expect(() => parseCliArgs(["owner/repository", "--unknown"])).toThrow();
    });

    test("validates numeric and enum options before running the workflow", () => {
        expect(() =>
            parseCliArgs(["owner/repository", "--max-issues", "0"]),
        ).toThrow();
        expect(() =>
            parseCliArgs(["owner/repository", "--issue-sort", "invalid"]),
        ).toThrow();
        expect(() =>
            parseCliArgs(["owner/repository", "--issue-order", "asc"]),
        ).not.toThrow();
        expect(String(IssueSort.Created)).toBe("created");
        expect(String(IssueOrder.Ascending)).toBe("asc");
    });
});