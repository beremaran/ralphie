import { describe, expect, test } from "bun:test";
import type { PiClient } from "../pi/client.ts";
import { Effect, Layer } from "effect";
import type { Octokit } from "octokit";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CommandRunnerLive } from "../process/command-runner.ts";
import { GitIssueCheckpointLive } from "../git/issue-checkpoint.ts";
import { GitIssueOperationsLive } from "../git/issue-operations.ts";
import { GitIssuePreparationLive } from "../git/issue-preparation.ts";
import {
  GitPushMode,
  GitRemoteSafety,
  type GitRemoteSafetyService,
} from "../git/remote-safety.ts";
import {
  GitRepositoryInvariant,
  GitRepositoryInvariantLive,
  type GitRepositoryInvariantService,
} from "../git/repository-invariant.ts";
import { IssueArtifactStoreLive } from "../issues/artifacts.ts";
import { ComplexityAssessmentLive } from "../issues/complexity.ts";
import { ComplexityLevel, ReviewVerdict } from "../issues/decisions.ts";
import {
  DecompositionExecutor,
  type DecompositionExecutorService,
} from "../issues/decomposition-executor.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "../issues/execution.ts";
import { IssueExecutor, IssueExecutorLive } from "../issues/executor.ts";
import { ImplementationExecutorLive } from "../issues/implementation-executor.ts";
import { IssueRecoveryLive } from "../issues/recovery.ts";
import { makePiSessionDiagnostics } from "../agent/task-session.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
} from "../progress/progress.ts";

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): string => {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
};

const git = (repositoryPath: string, args: ReadonlyArray<string>): string =>
  run("git", args, repositoryPath);

const makePi = (repositoryPath: string) => {
  let session = 0;
  let implementationWritten = false;
  const promptKinds: string[] = [];

  const client = {
    session: {
      create: async () => ({
        data: {
          id: `local-session-${++session}`,
        },
      }),
      prompt: async (parameters: { readonly format?: unknown }) => {
        const structured = parameters.format !== undefined;
        promptKinds.push(structured ? "structured" : "text");

        // The real agent is represented by the ordinary text response. Its
        // deterministic side effect gives the real Git services something to
        // stage, commit, and push while all Pi network calls stay local.
        if (!structured && !implementationWritten) {
          implementationWritten = true;
          await writeFile(
            join(repositoryPath, "implemented.txt"),
            "implemented\n",
          );
          return {
            data: {
              info: {},
              parts: [],
            },
          };
        }

        if (structured && promptKinds.length === 1) {
          return {
            data: {
              info: {
                structured: {
                  complexity: ComplexityLevel.Level2,
                  rationale: "A small isolated implementation change.",
                },
              },
              parts: [],
            },
          };
        }
        if (
          structured &&
          promptKinds.filter((kind) => kind === "structured").length === 2
        ) {
          return {
            data: {
              info: {
                structured: {
                  verdict: ReviewVerdict.Approved,
                  summary: "The implementation is correct.",
                  findings: [],
                },
              },
              parts: [],
            },
          };
        }
        return {
          data: {
            info: {
              structured: {
                subject: "implement local issue",
              },
            },
            parts: [],
          },
        };
      },
    },
  };

  return {
    client: client as unknown as PiClient,
    promptKinds,
  };
};

const makeContext = (
  repositoryPath: string,
  pi: PiClient,
  workspace: string,
  runId: string,
  repositoryInvariant: GitRepositoryInvariantService,
): IssueExecutionContext => ({
  issue: {
    number: 17,
    title: "Implement local change",
    url: "https://github.com/owner/repository/issues/17",
    body: "Create the implementation file.",
    labels: ["bug"],
  },
  repository: "owner/repository",
  repositoryPath,
  targetBranch: "main",
  workspace,
  runId,
  octokit: {} as Octokit,
  pi,
  piSelection: {
    agent: "build",
  },
  piDiagnostics: makePiSessionDiagnostics(() => "now"),
  repositoryInvariant,
});

describe("local implementation end-to-end", () => {
  test("implements, reviews, commits, pushes, and leaves a clean checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-local-e2e-"));
    const repositoryPath = join(root, "repository");
    const remotePath = join(root, "remote.git");
    const workspace = join(root, "workspace");
    const runId = "local-implementation-e2e";
    await mkdir(repositoryPath, {
      recursive: true,
    });

    try {
      run("git", ["init", "--bare", remotePath]);
      run("git", ["init", "-b", "main"], repositoryPath);
      git(repositoryPath, ["config", "user.name", "Ralphie Test"]);
      git(repositoryPath, ["config", "user.email", "ralphie@example.test"]);
      await writeFile(join(repositoryPath, "README.md"), "initial\n");
      git(repositoryPath, ["add", "--all"]);
      git(repositoryPath, ["commit", "-m", "initial commit"]);
      git(repositoryPath, ["remote", "add", "origin", remotePath]);
      git(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
      const initialSha = git(repositoryPath, ["rev-parse", "HEAD"]);

      const piSetup = makePi(repositoryPath);
      const progressEvents: ProgressUpdate[] = [];
      const safetyInputs: Array<{
        readonly intendedBaseSha: string;
        readonly expectedCommitSha?: string;
      }> = [];
      const safety: GitRemoteSafetyService = {
        verifyDirectPush: (input) =>
          Effect.sync(() => {
            safetyInputs.push({
              intendedBaseSha: input.intendedBaseSha,
              expectedCommitSha: input.expectedCommitSha,
            });
            return {
              repository: input.repository,
              branch: input.branch,
              origin: remotePath,
              commitsBehindBase: 0,
              commitsAheadBase: input.expectedCommitSha === undefined ? 0 : 1,
              pushMode: GitPushMode.NonForce,
            } as const;
          }),
      };
      let decompositionCalls = 0;
      const decomposition: DecompositionExecutorService = {
        execute: () => {
          decompositionCalls += 1;
          return Effect.die("decomposition must not run for complexity 2");
        },
      };

      const commandRunner = CommandRunnerLive;
      const artifactStore = IssueArtifactStoreLive;
      const checkpoint = GitIssueCheckpointLive.pipe(
        Layer.provide(commandRunner),
      );
      const preparation = GitIssuePreparationLive.pipe(
        Layer.provideMerge(Layer.merge(checkpoint, artifactStore)),
      );
      const operations = GitIssueOperationsLive.pipe(
        Layer.provide(commandRunner),
      );
      const invariant = GitRepositoryInvariantLive.pipe(
        Layer.provide(commandRunner),
      );
      const progress = makeProgressRecorderLayer(progressEvents);
      const recovery = IssueRecoveryLive.pipe(
        Layer.provideMerge(Layer.merge(checkpoint, progress)),
      );
      const implementation = ImplementationExecutorLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            preparation,
            operations,
            Layer.succeed(GitRemoteSafety, safety),
            recovery,
            progress,
          ),
        ),
      );
      const complexity = ComplexityAssessmentLive.pipe(Layer.provide(progress));
      const router = IssueExecutorLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            artifactStore,
            complexity,
            implementation,
            Layer.succeed(DecompositionExecutor, decomposition),
          ),
        ),
      );

      const outcome = await Effect.gen(function* () {
        const executor = yield* IssueExecutor;
        const repositoryInvariant = yield* GitRepositoryInvariant;
        return yield* executor.execute(
          makeContext(
            repositoryPath,
            piSetup.client,
            workspace,
            runId,
            repositoryInvariant,
          ),
        );
      }).pipe(
        Effect.provide(router),
        Effect.provide(invariant),
        Effect.runPromise,
      );

      const remoteSha = run("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      expect(outcome).toMatchObject({
        kind: IssueExecutionOutcomeKind.Completed,
        reviewCount: 1,
      });
      if (outcome.kind !== IssueExecutionOutcomeKind.Completed) {
        throw new Error(`Expected completed outcome, got ${outcome.kind}`);
      }
      if (outcome.completion !== IssueCompletionKind.PushedCommit) {
        throw new Error(
          `Expected pushed-commit completion, got ${outcome.completion}`,
        );
      }
      expect(outcome.commitSha).not.toBe(initialSha);
      expect(git(repositoryPath, ["rev-parse", "HEAD"])).toBe(
        outcome.commitSha,
      );
      expect(remoteSha).toBe(outcome.commitSha);
      expect(git(repositoryPath, ["log", "-1", "--format=%s"])).toBe(
        "implement local issue",
      );
      expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
      expect(
        await Bun.file(join(repositoryPath, "implemented.txt")).text(),
      ).toBe("implemented\n");
      expect(piSetup.promptKinds).toEqual([
        "structured",
        "text",
        "structured",
        "structured",
      ]);
      expect(safetyInputs).toHaveLength(2);
      expect(safetyInputs[0]).toEqual({
        intendedBaseSha: initialSha,
      });
      expect(safetyInputs[1]?.intendedBaseSha).toBe(initialSha);
      expect(safetyInputs[1]?.expectedCommitSha).toBe(outcome.commitSha);
      expect(decompositionCalls).toBe(0);
      expect(progressEvents.length).toBeGreaterThan(0);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });
});