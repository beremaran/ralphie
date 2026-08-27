import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../src/command.ts";
import { WorkflowMode } from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";

describe("native CLI parser", () => {
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
            workflow: WorkflowMode.Pr,
            issueLabels: ["bug", "ready"],
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