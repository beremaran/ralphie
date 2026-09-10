import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    DEFAULT_WORKSPACE,
    DEFAULT_NEEDS_ATTENTION_POLICY,
    DEFAULT_ISSUE_FAILURE_POLICY,
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    NeedsAttentionPolicy,
    resolveRalphieConfig,
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
            onNeedsAttention: DEFAULT_NEEDS_ATTENTION_POLICY,
            onIssueFailure: DEFAULT_ISSUE_FAILURE_POLICY,
            maxDecompositionDepth: DEFAULT_MAX_DECOMPOSITION_DEPTH,
            implementationAttempts: DEFAULT_IMPLEMENTATION_ATTEMPTS,
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
                branch: "develop",
                maxIssues: 3,
                maxDecompositionDepth: 6,
                issueLabels: ["bug", "ready"],
                issueSort: IssueSort.Updated,
                issueOrder: IssueOrder.Descending,
                model: {
                    providerID: "openai",
                    modelID: "gpt-5",
                },
                thinking: "high",
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
            branch: "develop",
            maxIssues: 3,
            maxDecompositionDepth: 6,
            issueLabels: ["bug", "ready"],
            issueSort: IssueSort.Updated,
            issueOrder: IssueOrder.Descending,
            model: {
                providerID: "openai",
                modelID: "gpt-5",
            },
            thinking: "high",
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

    test("rejects non-positive integer options", () => {
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                implementationAttempts: 0,
            }),
        ).toThrow(
            "Option --implementation-attempts requires a positive integer.",
        );
        expect(() =>
            resolveRalphieConfig({
                repo: "owner/repo",
                maxDecompositionDepth: -1,
            }),
        ).toThrow(
            "Option --max-decomposition-depth requires a positive integer.",
        );
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