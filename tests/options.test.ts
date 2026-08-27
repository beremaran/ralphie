import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    DEFAULT_WORKSPACE,
    DEFAULT_WORKFLOW_MODE,
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
            workflow: DEFAULT_WORKFLOW_MODE,
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
        });
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

    test("rejects incompatible output modes", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                json: true,
                quiet: true,
            }),
        ).toThrow("JSON and quiet output modes cannot be enabled together.");
    });
});