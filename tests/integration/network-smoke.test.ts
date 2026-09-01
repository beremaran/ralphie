import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";

import { makeGitHubClientService } from "../../src/github/client.ts";
import {
    makeGitHubIssuesService,
    IssueOrder,
    IssueSort,
} from "../../src/github/issues.ts";
import { makeGitHubIssueMutationsService } from "../../src/github/issue-mutations.ts";
import { makeGitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import { makeParentCompletionService } from "../../src/github/parent-completion.ts";
import { makePiService, type PiRuntime } from "../../src/pi/server.ts";
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
    if (enabled) test(name, testBody, 120_000);
    else test.skip(name, testBody);
};

const modelSelection = () => {
    const rawModel = process.env.RALPHIE_PI_SMOKE_MODEL;
    const parsedModel =
        rawModel === undefined ? undefined : piModelSchema.parse(rawModel);
    return {
        agent: process.env.RALPHIE_PI_SMOKE_AGENT?.trim() || "build",
        ...(parsedModel === undefined ? {} : { model: parsedModel }),
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
    makePiService({ workspace: tmpdir() }).start();

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
const subIssuesEnabled =
    envFlag("RALPHIE_RUN_GITHUB_SUB_ISSUES_SMOKE") && safeGithubRepository;

const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

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
                });
                expect(result.output.complexity).toBeGreaterThanOrEqual(
                    ComplexityLevel.Level0,
                );
                expect(result.output.complexity).toBeLessThanOrEqual(
                    ComplexityLevel.Level5,
                );
                expect(result.sessionID).toBeString();
            } finally {
                await server?.close();
                await rm(repositoryPath, { recursive: true, force: true });
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
                });
                expect(implementation.session.sessionID).toBeString();
                const git = simpleGit(repositoryPath);
                await git.add(["--all"]);
                const review = await requestStructuredOutput(server.client, {
                    directory: repositoryPath,
                    title: "Smoke-test implementation review",
                    prompt: buildReviewPrompt({
                        issue: smokeIssue,
                        repositoryPath,
                        targetBranch: "main",
                        stagedDiff: await git.diff(["--cached", "--binary"]),
                    }),
                    schema: reviewDecisionSchema,
                    ...selection,
                });
                expect(review.sessionID).toBeString();
                expect(review.output.summary.length).toBeGreaterThan(0);
            } finally {
                await server?.close();
                await rm(repositoryPath, { recursive: true, force: true });
            }
        },
    );

    defineOptInTest(
        githubEnabled,
        "reads open issues from the explicitly configured GitHub integration repository",
        async () => {
            const octokit = await makeGitHubClientService().initialize();
            const issues = await makeGitHubIssuesService().listOpen(
                octokit,
                githubRepository!,
                {
                    labels: [],
                    sort: IssueSort.Created,
                    order: IssueOrder.Ascending,
                },
            );
            expect(Array.isArray(issues)).toBeTrue();
        },
    );

    defineOptInTest(
        subIssuesEnabled,
        "exercises the real native sub-issue and dependency API end to end",
        async () => {
            const octokit = await makeGitHubClientService().initialize();
            const repository = githubRepository!;
            const [owner, repo] = repository.split("/") as [string, string];
            const mutations = makeGitHubIssueMutationsService();
            const relationships = makeGitHubIssueRelationshipService();
            const suffix = Date.now();
            const create = async (title: string, body: string) => {
                const issue = await mutations.create(octokit, repository, {
                    title: `${title} (${suffix})`,
                    body,
                });
                await pause(1_000);
                return issue;
            };

            const parent = await create(
                "Ralphie sub-issue smoke parent",
                "Scratch tracking issue for the native relationship smoke test.",
            );
            const storage = await create(
                "Ralphie sub-issue smoke child A",
                "Scratch child used as a native sub-issue and dependency blocker.",
            );
            const api = await create(
                "Ralphie sub-issue smoke child B",
                "Scratch child used as a native sub-issue that depends on child A.",
            );

            try {
                await relationships.attachSubIssue(
                    octokit,
                    repository,
                    parent.number,
                    storage.number,
                );
                await relationships.attachSubIssue(
                    octokit,
                    repository,
                    parent.number,
                    api.number,
                );
                // Idempotent repeat must not duplicate the relationship.
                await relationships.attachSubIssue(
                    octokit,
                    repository,
                    parent.number,
                    api.number,
                );
                const subIssues = await relationships.listSubIssues(
                    octokit,
                    repository,
                    parent.number,
                );
                expect(subIssues.map(({ number }) => number).sort()).toEqual(
                    [storage.number, api.number].sort(),
                );
                expect(
                    (
                        await relationships.parentOf(
                            octokit,
                            repository,
                            api.number,
                        )
                    )?.number,
                ).toBe(parent.number);

                await relationships.addBlockedBy(
                    octokit,
                    repository,
                    api.number,
                    storage.number,
                );
                await relationships.addBlockedBy(
                    octokit,
                    repository,
                    api.number,
                    storage.number,
                );
                expect(
                    (
                        await relationships.listBlockedBy(
                            octokit,
                            repository,
                            api.number,
                        )
                    ).map(({ number }) => number),
                ).toEqual([storage.number]);

                // Real parent-completion reconciliation: close both children,
                // then the tracking parent completes only afterwards.
                await mutations.close(
                    octokit,
                    repository,
                    storage.number,
                    "completed",
                );
                await mutations.close(
                    octokit,
                    repository,
                    api.number,
                    "completed",
                );
                const completed = await makeParentCompletionService({
                    issues: makeGitHubIssuesService(),
                    relationships,
                    mutations,
                }).reconcileParent(octokit, repository, parent.number);
                expect(completed).toBeTrue();
                const closedParent = await octokit.rest.issues.get({
                    owner,
                    repo,
                    issue_number: parent.number,
                });
                expect(closedParent.data.state).toBe("closed");
                expect(closedParent.data.state_reason).toBe("completed");
            } finally {
                // Remove the dependency edge directly; sub-issue links and
                // scratch issues are closed above or cleaned up best-effort.
                const storageId = (
                    await octokit.rest.issues.get({
                        owner,
                        repo,
                        issue_number: storage.number,
                    })
                ).data.id;
                await octokit
                    .request(
                        "DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}",
                        {
                            owner,
                            repo,
                            issue_number: api.number,
                            issue_id: storageId,
                        },
                    )
                    .catch(() => undefined);
                for (const issue of [parent, storage, api]) {
                    await octokit.rest.issues
                        .update({
                            owner,
                            repo,
                            issue_number: issue.number,
                            state: "closed",
                            state_reason: "not_planned",
                        })
                        .catch(() => undefined);
                }
            }
        },
    );
});