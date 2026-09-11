import { describe, expect, test } from "bun:test";

import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    DEFAULT_WORKSPACE,
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
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
            maxDecompositionDepth: DEFAULT_MAX_DECOMPOSITION_DEPTH,
            implementationAttempts: DEFAULT_IMPLEMENTATION_ATTEMPTS,
            notificationsEnabled: false,
            issueLabels: [],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
            verificationCommands: [],
            agent: "build",
            workspace: DEFAULT_WORKSPACE,
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
                verbose: true,
                json: true,
                notifyNeedsAttention: true,
                needsAttentionLabel: "  needs-attention  ",
            }),
        ).toMatchObject({
            repo: "Owner/Repo",
            branch: "develop",
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
            verbose: true,
            json: true,
            quiet: false,
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