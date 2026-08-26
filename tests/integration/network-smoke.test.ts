import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";

import { CommandRunnerLive } from "../../src/process/command-runner.ts";
import { GitHubClient, GitHubClientLive } from "../../src/github/client.ts";
import {
  GitHubIssues,
  GitHubIssuesLive,
  IssueOrder,
  IssueSort,
} from "../../src/github/issues.ts";
import { Pi, PiLive, type PiRuntime } from "../../src/agent/server.ts";
import { piModelSchema, piModelVariantSchema } from "../../src/agent/model.ts";
import {
  buildComplexityPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
} from "../../src/agent/prompts.ts";
import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import { runPiTask } from "../../src/agent/task-session.ts";
import {
  complexityDecisionSchema,
  reviewDecisionSchema,
  ComplexityLevel,
} from "../../src/issues/decisions.ts";

const envFlag = (name: string): boolean => process.env[name] === "1";

const defineOptInTest = (
  enabled: boolean,
  name: string,
  testBody: () => Promise<void>,
): void => {
  if (enabled) {
    test(name, testBody, 120_000);
  } else {
    test.skip(name, testBody);
  }
};

const modelSelection = () => {
  const rawModel = process.env.RALPHIE_PI_SMOKE_MODEL;
  const parsedModel =
    rawModel === undefined ? undefined : piModelSchema.parse(rawModel);
  return {
    agent: process.env.RALPHIE_PI_SMOKE_AGENT?.trim() || "build",
    ...(parsedModel === undefined
      ? {}
      : {
          model: parsedModel,
        }),
    ...(process.env.RALPHIE_PI_SMOKE_VARIANT === undefined
      ? {}
      : {
          variant: piModelVariantSchema.parse(
            process.env.RALPHIE_PI_SMOKE_VARIANT,
          ),
        }),
  };
};

const startPi = async (): Promise<PiRuntime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Pi;
      return yield* service.start;
    }).pipe(
      Effect.provide(
        // Default agent directory: smoke tests rely on the operator's real Pi
        // configuration (env-provided keys), not a generated one.
        PiLive({
          workspace: tmpdir(),
        }),
      ),
    ),
  );

const createDisposableRepository = async (): Promise<string> => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-pi-smoke-"));
  const git = simpleGit(repositoryPath);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "ralphie-smoke@example.test");
  await git.addConfig("user.name", "Ralphie Smoke Test");
  await writeFile(
    join(repositoryPath, "README.md"),
    "Disposable smoke-test repository.\n",
  );
  await git.add("README.md");
  await git.commit("initialize disposable smoke repository");
  return repositoryPath;
};

const smokeIssue = {
  number: 1,
  title: "Add a greeting file",
  url: "https://example.test/issues/1",
  body: "Add greeting.txt containing exactly `Hello from Ralphie!`.",
  labels: ["smoke-test"],
} as const;

const piComplexityEnabled = envFlag("RALPHIE_RUN_PI_COMPLEXITY_SMOKE");
const piImplementationEnabled = envFlag("RALPHIE_RUN_PI_IMPLEMENTATION_SMOKE");

const githubRepository = process.env.RALPHIE_GITHUB_TEST_REPOSITORY?.trim();
const safeGithubRepository =
  githubRepository !== undefined &&
  /(?:test|sandbox|fixture|integration|smoke)/i.test(githubRepository);
const githubEnabled =
  envFlag("RALPHIE_RUN_GITHUB_INTEGRATION") && safeGithubRepository;

describe("opt-in network smoke tests", () => {
  defineOptInTest(
    piComplexityEnabled,
    "gets a real structured complexity assessment from Pi",
    async () => {
      const repositoryPath = await createDisposableRepository();
      let server: PiRuntime | undefined;
      try {
        server = await startPi();
        const result = await requestStructuredOutput(server.client, {
          directory: repositoryPath,
          title: "Smoke-test issue complexity assessment",
          prompt: buildComplexityPrompt({
            issue: smokeIssue,
            repositoryPath,
            targetBranch: "main",
          }),
          schema: complexityDecisionSchema,
          ...modelSelection(),
        }).pipe(Effect.runPromise);

        expect(result.output.complexity).toBeGreaterThanOrEqual(
          ComplexityLevel.Level0,
        );
        expect(result.output.complexity).toBeLessThanOrEqual(
          ComplexityLevel.Level5,
        );
        expect(result.sessionID).toBeString();
      } finally {
        server?.close();
        await rm(repositoryPath, {
          recursive: true,
          force: true,
        });
      }
    },
  );

  defineOptInTest(
    piImplementationEnabled,
    "runs real Pi implementation and structured review in a disposable repository",
    async () => {
      const repositoryPath = await createDisposableRepository();
      let server: PiRuntime | undefined;
      try {
        server = await startPi();
        const selection = modelSelection();
        const implementation = await runPiTask(server.client, {
          directory: repositoryPath,
          title: "Smoke-test implementation",
          selection,
          prompt: buildImplementationPrompt({
            issue: smokeIssue,
            repositoryPath,
            targetBranch: "main",
          }),
        }).pipe(Effect.runPromise);
        expect(implementation.session.sessionID).toBeString();

        const git = simpleGit(repositoryPath);
        await git.add(["--all"]);
        const stagedDiff = await git.diff(["--cached", "--binary"]);
        const review = await requestStructuredOutput(server.client, {
          directory: repositoryPath,
          title: "Smoke-test implementation review",
          prompt: buildReviewPrompt({
            issue: smokeIssue,
            repositoryPath,
            targetBranch: "main",
            stagedDiff,
          }),
          schema: reviewDecisionSchema,
          ...selection,
        }).pipe(Effect.runPromise);

        expect(review.sessionID).toBeString();
        expect(review.output.summary.length).toBeGreaterThan(0);
      } finally {
        server?.close();
        await rm(repositoryPath, {
          recursive: true,
          force: true,
        });
      }
    },
  );

  defineOptInTest(
    githubEnabled,
    "reads open issues from the explicitly configured GitHub integration repository",
    async () => {
      const repository = githubRepository!;
      const octokit = await Effect.gen(function* () {
        const github = yield* GitHubClient;
        return yield* github.initialize;
      }).pipe(
        Effect.provide(GitHubClientLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      const issues = await Effect.gen(function* () {
        const service = yield* GitHubIssues;
        return yield* service.listOpen(octokit, repository, {
          labels: [],
          sort: IssueSort.Created,
          order: IssueOrder.Ascending,
        });
      }).pipe(Effect.provide(GitHubIssuesLive), Effect.runPromise);

      expect(Array.isArray(issues)).toBeTrue();
    },
  );
});