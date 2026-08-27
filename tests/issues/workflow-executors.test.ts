import { describe, expect, test } from "bun:test";

import { makeIssueArtifactStore } from "../../src/issues/artifacts.ts";
import {
    IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";

const context = { issue: { number: 42 } } as IssueExecutionContext;

describe("concrete issue workflow executors", () => {
    test("passes implementation execution its per-issue artifacts", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        const executor = {
            execute: async (input: {
                context: IssueExecutionContext;
                artifacts: typeof artifacts;
            }) => ({
                kind: IssueExecutionOutcomeKind.Completed,
                completion: IssueCompletionKind.PushedCommit,
                commitSha: `issue-${input.artifacts.issueNumber}`,
            }),
        };
        const outcome = await executor.execute({ context, artifacts });
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: IssueCompletionKind.PushedCommit,
            commitSha: "issue-42",
        });
    });

    test("passes decomposition execution its per-issue artifacts", async () => {
        const artifacts = await makeIssueArtifactStore(99);
        const executor = {
            execute: async (input: {
                context: IssueExecutionContext;
                artifacts: typeof artifacts;
            }) => ({
                kind: IssueExecutionOutcomeKind.Decomposed,
                childIssueNumbers: [input.artifacts.issueNumber + 1],
            }),
        };
        const outcome = await executor.execute({ context, artifacts });
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [100],
        });
    });
});