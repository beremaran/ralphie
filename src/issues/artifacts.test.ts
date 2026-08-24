import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  IssueArtifactKind,
  IssueArtifactStore,
  IssueArtifactStoreLive,
  makeIssueArtifactStore,
} from "./artifacts.ts";
import {
  ComplexityLevel,
  ImplementationComplexityLevel,
  ReviewFindingSeverity,
  ReviewVerdict,
} from "./decisions.ts";

const checkpoint = {
  branch: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
} as const;

const review = (attempt: number) => ({
  attempt,
  sessionID: `session-${attempt}`,
  decision: {
    verdict: ReviewVerdict.ChangesRequested,
    summary: "A blocker remains.",
    findings: [
      {
        severity: ReviewFindingSeverity.Blocking,
        description: "The edge case is not handled.",
      },
    ],
  },
});

describe("per-issue artifact store", () => {
  test("stores and retrieves each typed artifact", async () => {
    const store = await Effect.runPromise(makeIssueArtifactStore(42));
    const complexity = {
      complexity: ComplexityLevel.Level2,
      rationale: "The change is localized.",
    };
    const commitMessage = {
      subject: "Fix localized issue",
      body: "Cover the edge case.",
    };
    const breakdown = {
      rationale: "Split independent work.",
      issues: [
        {
          key: "first",
          title: "First task",
          body: "Implement the first task.",
          estimatedComplexity: ImplementationComplexityLevel.Level2,
          dependsOn: [],
        },
        {
          key: "second",
          title: "Second task",
          body: "Implement the second task.",
          estimatedComplexity: ImplementationComplexityLevel.Level3,
          dependsOn: ["first"],
        },
      ],
    };

    await Effect.runPromise(
      store.write(IssueArtifactKind.ComplexityDecision, complexity),
    );
    await Effect.runPromise(
      store.write(IssueArtifactKind.IssueCheckpoint, checkpoint),
    );
    await Effect.runPromise(store.appendReview(review(1)));
    await Effect.runPromise(
      store.write(IssueArtifactKind.CommitMessageDecision, commitMessage),
    );
    await Effect.runPromise(
      store.write(IssueArtifactKind.IssueBreakdownDecision, breakdown),
    );
    await Effect.runPromise(store.recordCreatedIssue("first", 101));
    await Effect.runPromise(store.recordCreatedIssue("second", 102));

    expect(
      await Effect.runPromise(
        store.read(IssueArtifactKind.ComplexityDecision),
      ),
    ).toEqual(complexity);
    expect(
      await Effect.runPromise(store.read(IssueArtifactKind.IssueCheckpoint)),
    ).toEqual(checkpoint);
    expect(
      await Effect.runPromise(store.read(IssueArtifactKind.ReviewAttempts)),
    ).toEqual([review(1)]);
    expect(
      await Effect.runPromise(
        store.read(IssueArtifactKind.CommitMessageDecision),
      ),
    ).toEqual(commitMessage);
    expect(
      await Effect.runPromise(
        store.read(IssueArtifactKind.IssueBreakdownDecision),
      ),
    ).toEqual(breakdown);
    expect(
      await Effect.runPromise(
        store.read(IssueArtifactKind.CreatedIssueNumbers),
      ),
    ).toEqual({ first: 101, second: 102 });
  });

  test("rejects reads before the artifact has been produced", async () => {
    const store = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(
      store.read(IssueArtifactKind.IssueCheckpoint),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(
        "Artifact issue-checkpoint has not been produced for issue 42.",
      );
    }
  });

  test("preserves review order and rejects gaps or writes past the budget", async () => {
    const store = await Effect.runPromise(makeIssueArtifactStore(42));

    expect(
      await Effect.runPromiseExit(store.appendReview(review(2))),
    ).toSatisfy((exit) => Exit.isFailure(exit));
    await Effect.runPromise(store.appendReview(review(1)));
    expect(
      await Effect.runPromiseExit(
        store.write(IssueArtifactKind.ReviewAttempts, [review(2)]),
      ),
    ).toSatisfy((exit) => Exit.isFailure(exit));
  });

  test("does not overwrite an artifact after production", async () => {
    const store = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      store.write(IssueArtifactKind.ComplexityDecision, {
        complexity: ComplexityLevel.Level1,
        rationale: "First decision.",
      }),
    );

    const exit = await Effect.runPromiseExit(
      store.write(IssueArtifactKind.ComplexityDecision, {
        complexity: ComplexityLevel.Level2,
        rationale: "Replacement decision.",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("keeps stores isolated by issue while reusing a store for that issue", async () => {
    const [first, second, other] = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* IssueArtifactStore;
        const first = yield* artifacts.forIssue(1);
        yield* first.write(IssueArtifactKind.CreatedIssueNumbers, { child: 2 });
        const second = yield* artifacts.forIssue(1);
        const other = yield* artifacts.forIssue(2);
        return [first, second, other] as const;
      }).pipe(Effect.provide(IssueArtifactStoreLive)),
    );
    expect(second).toBe(first);
    expect(first.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(true);
    expect(other).not.toBe(first);
    expect(other.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(false);
  });

  test("rejects invalid issue and child identifiers", async () => {
    expect(
      await Effect.runPromiseExit(makeIssueArtifactStore(0)),
    ).toSatisfy((exit) => Exit.isFailure(exit));

    const store = await Effect.runPromise(makeIssueArtifactStore(42));
    expect(
      await Effect.runPromiseExit(store.recordCreatedIssue("", 100)),
    ).toSatisfy((exit) => Exit.isFailure(exit));
    expect(
      await Effect.runPromiseExit(store.recordCreatedIssue("child", 0)),
    ).toSatisfy((exit) => Exit.isFailure(exit));
  });
});
