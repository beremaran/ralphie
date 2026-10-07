#!/usr/bin/env bun

/**
 * Opt-in live smoke run. Never part of `bun run test`, `bun run check` or CI.
 * Runs the real CLI against a scratch GitHub repository with each installed
 * harness. See docs/development.md "Live smoke script".
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const HARNESSES = ["claude", "codex", "pi", "opencode"] as const;
export type SmokeHarness = (typeof HARNESSES)[number];

/**
 * Ralphie's exit code when a limit, outage or expired login halted the run
 * (RalphieExitCode.Halted). The run proved nothing, so it is inconclusive.
 */
export const HALTED_EXIT_CODE = 75;
export const HAND_OFF_MARKER = "ralphie:hand-off";
const HUMAN_LABELS = ["ready-for-human", "needs-info"];
/** Wording of a hand-off that blames the harness instead of the issue. */
const HARNESS_FAILURE_COMMENT =
    /agent session failed|session limit|usage limit|rate[ _-]?limit|overloaded|quota/i;

export const SCRATCH_ENV = "RALPHIE_SMOKE_SCRATCH_REPO";
export const READY_LABEL = "ready-for-agent";
const PROTECTED_REPOSITORIES = ["beremaran/ralphie"];
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const usage = `Usage:
  ${SCRATCH_ENV}=owner/repo bun run smoke:live -- --scratch-repo owner/repo [--harness claude,codex] [--keep-issues]

Creates issues in the scratch repository and lets Ralphie work them with each
selected installed harness. The repository must be named twice (flag and
environment variable, identically) so it cannot be targeted by accident.`;

export type SmokeOptions = {
    readonly repository: string;
    readonly harnesses: readonly SmokeHarness[];
    readonly keepIssues: boolean;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** Throws unless the operator explicitly named the same scratch repository twice. */
export const requireScratchRepository = (
    flag: string | undefined,
    environment: Environment,
): string => {
    if (flag === undefined || !SLUG.test(flag)) {
        throw new Error(`--scratch-repo owner/repo is required.\n${usage}`);
    }
    if (environment[SCRATCH_ENV]?.toLowerCase() !== flag.toLowerCase()) {
        throw new Error(
            `Refusing to run: ${SCRATCH_ENV} must equal --scratch-repo (${flag}).`,
        );
    }
    if (PROTECTED_REPOSITORIES.includes(flag.toLowerCase())) {
        throw new Error(
            `Refusing to run against ${flag}: not a scratch repository.`,
        );
    }
    return flag;
};

export const parseSmokeOptions = (
    argv: readonly string[],
    environment: Environment,
): SmokeOptions => {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            "scratch-repo": { type: "string" },
            harness: { type: "string" },
            "keep-issues": { type: "boolean", default: false },
        },
        strict: true,
    });
    const repository = requireScratchRepository(
        values["scratch-repo"],
        environment,
    );
    const requested = (values.harness ?? HARNESSES.join(","))
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
    const unknown = requested.filter(
        (name) => !(HARNESSES as readonly string[]).includes(name),
    );
    if (unknown.length > 0) {
        throw new Error(`Unknown harness: ${unknown.join(", ")}.`);
    }
    return {
        repository,
        harnesses: requested as SmokeHarness[],
        keepIssues: values["keep-issues"] ?? false,
    };
};

export const smokeConfig = (harness: SmokeHarness, workspace: string): string =>
    [
        `workspace: ${JSON.stringify(workspace)}`,
        "approval: yolo",
        // The smoke run is how an unverified harness gets verified.
        ...(harness === "opencode"
            ? ["harnesses:", "  opencode:", "    experimental: true"]
            : []),
        "roles:",
        `  default: ${harness}`,
        "limits:",
        "  implementationAttempts: 1",
        "  reviewRounds: 1",
        "  sessionTimeoutMinutes:",
        "    edit: 10",
        "    readOnly: 5",
        "intake:",
        `  requireLabels: [smoke-${harness}]`,
        "",
    ].join("\n");

export type SmokeScenario = {
    readonly name: "implementation" | "hand-off" | "decomposition";
    readonly title: string;
    readonly body: string;
};

/** The scratch repository is reused, so every run asks for its own file. */
export const greetingFile = (runId: string): string => `greeting-${runId}.txt`;
export const greetingText = (runId: string): string => `hello ${runId}`;

export const smokeScenarios = (
    harness: SmokeHarness,
    runId: string,
): SmokeScenario[] => [
    {
        name: "implementation",
        title: `Smoke ${harness} ${runId}: add greeting file`,
        body: `Create a file \`${greetingFile(runId)}\` at the repository root containing exactly \`${greetingText(runId)}\`.`,
    },
    {
        name: "hand-off",
        title: `Smoke ${harness} ${runId}: ambiguous requirement`,
        body: "Make the output format match the agreed format. There is no agreed format written anywhere; a human must decide it.",
    },
    {
        name: "decomposition",
        title: `Smoke ${harness} ${runId}: large feature`,
        body: "Build a complete command-line todo application with persistence, tagging, search, import and export, a plugin system, and a full test suite. This is far too large for one session and should be split into smaller issues.",
    },
];

/** A child issue as `gh issue list --json` reports it, flattened. */
export type SmokeChild = {
    readonly number: number;
    readonly state: string;
    readonly stateReason?: string | null;
    readonly labels: readonly string[];
    readonly comments: readonly string[];
};

const worked = (child: SmokeChild): boolean => {
    if (child.state === "CLOSED") return child.stateReason === "COMPLETED";
    const handedOff = child.comments.some((body) =>
        body.includes(HAND_OFF_MARKER),
    );
    return (
        handedOff &&
        child.labels.some((label) => HUMAN_LABELS.includes(label)) &&
        !child.comments.some((body) => HARNESS_FAILURE_COMMENT.test(body))
    );
};

/**
 * A decomposition only counts when Ralphie then worked a child to a genuine
 * terminal outcome: closed as completed (the script's own cleanup closes as
 * not planned), or handed off for a real reason. Children that exist but
 * were never worked, or that were handed off because the harness failed, do
 * not prove the run.
 */
export const judgeDecomposition = (
    children: readonly SmokeChild[],
): string | undefined => {
    if (children.length === 0) return "decomposition created no child issues";
    return children.some(worked)
        ? undefined
        : "no child issue was worked to a genuine outcome (completed, or handed off for a real reason)";
};

/**
 * The hand-off scenario passes only when Ralphie handed the issue to a human:
 * still open, a human-attention label, and Ralphie's hand-off comment. An
 * issue Ralphie never touched, or one a failed session left alone, fails.
 */
export const judgeHandOff = (
    issue: Pick<SmokeChild, "state" | "labels" | "comments"> | undefined,
): string[] => {
    if (issue === undefined) return ["hand-off issue was not found"];
    const problems: string[] = [];
    if (issue.state !== "OPEN") {
        problems.push("hand-off issue should stay open for a human");
    }
    if (!issue.labels.some((label) => HUMAN_LABELS.includes(label))) {
        problems.push(
            `hand-off issue has none of the labels ${HUMAN_LABELS.join(", ")}`,
        );
    }
    if (!issue.comments.some((body) => body.includes(HAND_OFF_MARKER))) {
        problems.push("hand-off issue has no Ralphie hand-off comment");
    } else if (
        issue.comments.some((body) => HARNESS_FAILURE_COMMENT.test(body))
    ) {
        problems.push(
            "hand-off blames a failed harness session, not the issue",
        );
    }
    return problems;
};

/** SKIPped harnesses prove nothing: a run where none ran must fail. */
export const smokeExitCode = (failed: number, ran: number): number =>
    failed === 0 && ran > 0 ? 0 : 1;

export type SmokeVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** A transient halt proves nothing either way; any other problem fails. */
export const smokeVerdict = (
    exitCode: number,
    problems: readonly string[],
): SmokeVerdict => {
    if (exitCode === HALTED_EXIT_CODE) return "INCONCLUSIVE";
    return exitCode === 0 && problems.length === 0 ? "PASS" : "FAIL";
};

/** True once every created issue shows up in a label-filtered listing. */
export const allIssuesListed = (
    expected: readonly number[],
    listed: readonly number[],
): boolean => expected.every((number) => listed.includes(number));

/** What Ralphie's `--output json` run log says happened. */
export type RunLog = {
    /** Issues Ralphie itself reported closing as completed. */
    readonly closedAsCompleted: ReadonlySet<number>;
    /** Issues for which Ralphie reported a review stage event. */
    readonly reviewed: ReadonlySet<number>;
    /** The final `Run completed...` (or `Run stopped...`) message, if any. */
    readonly summary?: string;
};

type LogEvent = {
    readonly stage?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly issue?: { readonly number?: unknown };
};

const parseLogLine = (line: string): LogEvent | undefined => {
    try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null
            ? (value as LogEvent)
            : undefined;
    } catch {
        return undefined;
    }
};

const recordIssueStage = (
    event: LogEvent,
    closed: Set<number>,
    reviewed: Set<number>,
): void => {
    const number = event.issue?.number;
    if (typeof number !== "number") return;
    if (event.stage === "review") reviewed.add(number);
    if (event.stage === "issue-closure" && event.status === "succeeded") {
        closed.add(number);
    }
};

/** Reads JSON Lines from `ralphie --output json`, ignoring non-JSON lines. */
export const parseRunLog = (text: string): RunLog => {
    const closed = new Set<number>();
    const reviewed = new Set<number>();
    let summary: string | undefined;
    for (const line of text.split("\n")) {
        const event = parseLogLine(line.trim());
        if (event === undefined || typeof event.message !== "string") continue;
        recordIssueStage(event, closed, reviewed);
        if (/^Run (completed|stopped)/.test(event.message)) {
            summary = event.message;
        }
    }
    return summary === undefined
        ? { closedAsCompleted: closed, reviewed }
        : { closedAsCompleted: closed, reviewed, summary };
};

/** What the scratch repository shows about the implementation scenario. */
export type ImplementationEvidence = {
    readonly state: string | undefined;
    readonly stateReason?: string | null;
    /** Ralphie's run log reports closing this issue as completed. */
    readonly closedByRalphie: boolean;
    /** Commits that landed on the default branch during the run. */
    readonly newCommits: number;
    /** Files those commits touched. */
    readonly changedFiles: readonly string[];
    /** The per-run file the issue asked for. */
    readonly file: string;
    /** The exact content the issue asked for. */
    readonly expected: string;
    /** Content of that file on the default branch, if present. */
    readonly greeting: string | undefined;
    /** Ralphie's run log shows a review stage for this issue. */
    readonly reviewed: boolean;
};

/**
 * The implementation scenario passes only on evidence Ralphie did the work: a
 * new commit during the run that adds greeting.txt containing `hello`, and a
 * closure Ralphie itself reported. A closed issue alone proves nothing.
 */
export const judgeImplementation = (
    evidence: ImplementationEvidence,
): string[] => {
    if (evidence.state !== "CLOSED") {
        return ["implementation issue was not closed"];
    }
    const problems: string[] = [];
    if (evidence.stateReason !== "COMPLETED") {
        problems.push("implementation issue was not closed as completed");
    }
    if (!evidence.closedByRalphie) {
        problems.push(
            "implementation issue was closed, but the run log shows no closure by Ralphie",
        );
    }
    if (!evidence.reviewed) {
        problems.push("the run log shows no review stage for the issue");
    }
    if (evidence.newCommits === 0) {
        problems.push(
            "no commit landed on the default branch during the run, so nothing was implemented",
        );
    } else if (!evidence.changedFiles.includes(evidence.file)) {
        problems.push(`no new commit touched ${evidence.file}`);
    }
    if (evidence.greeting?.trim() !== evidence.expected) {
        problems.push(
            `${evidence.file} on the default branch is not \`${evidence.expected}\``,
        );
    }
    return problems;
};

type Run = {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
};

const run = async (
    command: readonly string[],
    environment: Record<string, string | undefined>,
): Promise<Run> => {
    const child = Bun.spawn([...command], {
        env: environment as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { code, stdout, stderr };
};

const gh = async (...args: string[]): Promise<string> => {
    const result = await run(["gh", ...args], process.env);
    if (result.code !== 0) {
        throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
};

type IssueView = {
    number: number;
    state: string;
    stateReason?: string | null;
    labels?: { name: string }[];
    comments?: { body: string }[];
};

const listIssues = async (
    repository: string,
    label?: string,
): Promise<IssueView[]> =>
    JSON.parse(
        await gh(
            "issue",
            "list",
            "--repo",
            repository,
            "--state",
            "all",
            "--limit",
            "100",
            ...(label === undefined ? [] : ["--label", label]),
            "--json",
            "number,state,stateReason,labels,comments",
        ),
    ) as IssueView[];

/** The default branch head, or undefined for an empty repository. */
const headSha = async (repository: string): Promise<string | undefined> => {
    const result = await run(
        ["gh", "api", `repos/${repository}/commits/HEAD`, "--jq", ".sha"],
        process.env,
    );
    return result.code === 0 ? result.stdout.trim() : undefined;
};

const decodeBase64 = (content: string): string =>
    Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");

type Landed = { readonly newCommits: number; readonly changedFiles: string[] };

/** Commits on the default branch since `baseline`, with the files they touched. */
const commitsSince = async (
    repository: string,
    baseline: string | undefined,
): Promise<Landed> => {
    const head = await headSha(repository);
    if (head === undefined || head === baseline) {
        return { newCommits: 0, changedFiles: [] };
    }
    if (baseline === undefined) return { newCommits: 1, changedFiles: [] };
    const compare = JSON.parse(
        await gh("api", `repos/${repository}/compare/${baseline}...${head}`),
    ) as { ahead_by: number; files?: { filename: string }[] };
    return {
        newCommits: compare.ahead_by,
        changedFiles: (compare.files ?? []).map((file) => file.filename),
    };
};

const greetingOnDefaultBranch = async (
    repository: string,
    file: string,
): Promise<string | undefined> => {
    const content = await run(
        [
            "gh",
            "api",
            `repos/${repository}/contents/${file}`,
            "--jq",
            ".content",
        ],
        process.env,
    );
    return content.code === 0 ? decodeBase64(content.stdout) : undefined;
};

const verify = async (
    repository: string,
    label: string,
    created: ReadonlyMap<string, number>,
    baseline: string | undefined,
    log: RunLog,
    runId: string,
): Promise<string[]> => {
    const labelled = await listIssues(repository, label);
    const find = (name: string): IssueView | undefined =>
        labelled.find((issue) => issue.number === created.get(name));
    const implementation = find("implementation");
    const problems = judgeImplementation({
        state: implementation?.state,
        stateReason: implementation?.stateReason ?? null,
        closedByRalphie:
            implementation !== undefined &&
            log.closedAsCompleted.has(implementation.number),
        reviewed:
            implementation !== undefined &&
            log.reviewed.has(implementation.number),
        file: greetingFile(runId),
        expected: greetingText(runId),
        ...(await commitsSince(repository, baseline)),
        greeting: await greetingOnDefaultBranch(
            repository,
            greetingFile(runId),
        ),
    });
    const handOff = find("hand-off");
    problems.push(
        ...judgeHandOff(
            handOff === undefined
                ? undefined
                : {
                      state: handOff.state,
                      labels: (handOff.labels ?? []).map(({ name }) => name),
                      comments: (handOff.comments ?? []).map(
                          ({ body }) => body,
                      ),
                  },
        ),
    );
    const newest = Math.max(...created.values());
    const children = (await listIssues(repository))
        .filter((issue) => issue.number > newest)
        .map(
            (issue): SmokeChild => ({
                number: issue.number,
                state: issue.state,
                stateReason: issue.stateReason ?? null,
                labels: (issue.labels ?? []).map(({ name }) => name),
                comments: (issue.comments ?? []).map(({ body }) => body),
            }),
        );
    const decomposition = judgeDecomposition(children);
    if (decomposition !== undefined) problems.push(decomposition);
    return problems;
};

const fileScenarios = async (
    options: SmokeOptions,
    harness: SmokeHarness,
    label: string,
    runId: string,
): Promise<Map<string, number>> => {
    await gh("label", "create", label, "--repo", options.repository, "--force");
    await gh(
        "label",
        "create",
        READY_LABEL,
        "--repo",
        options.repository,
        "--force",
    );
    const created = new Map<string, number>();
    for (const scenario of smokeScenarios(harness, runId)) {
        const url = await gh(
            "issue",
            "create",
            "--repo",
            options.repository,
            "--title",
            scenario.title,
            "--body",
            scenario.body,
            "--label",
            `${READY_LABEL},${label}`,
        );
        created.set(scenario.name, Number(url.trim().split("/").pop()));
    }
    return created;
};

const LISTING_TIMEOUT_MS = 90_000;
const LISTING_POLL_MS = 3_000;

/**
 * GitHub's issue listing lags creation by seconds; Ralphie's intake would see
 * no open issues. Poll until every created issue appears under both labels.
 */
const waitForListing = async (
    repository: string,
    label: string,
    created: ReadonlyMap<string, number>,
): Promise<void> => {
    const expected = [...created.values()];
    const deadline = Date.now() + LISTING_TIMEOUT_MS;
    for (;;) {
        const listed = JSON.parse(
            await gh(
                "issue",
                "list",
                "--repo",
                repository,
                "--state",
                "open",
                "--limit",
                "100",
                "--label",
                `${READY_LABEL},${label}`,
                "--json",
                "number",
            ),
        ) as { number: number }[];
        if (
            allIssuesListed(
                expected,
                listed.map((issue) => issue.number),
            )
        ) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `created issues were not listed under ${READY_LABEL},${label} within ${LISTING_TIMEOUT_MS / 1000}s`,
            );
        }
        await Bun.sleep(LISTING_POLL_MS);
    }
};

type RalphieRun = {
    readonly code: number;
    readonly failure?: string;
    readonly log: RunLog;
};

const runRalphie = async (
    options: SmokeOptions,
    harness: SmokeHarness,
    directory: string,
): Promise<RalphieRun> => {
    const config = join(directory, "config.yaml");
    await writeFile(config, smokeConfig(harness, join(directory, "workspace")));
    const entry = join(resolve(import.meta.dir, ".."), "index.ts");
    const result = await run(
        [
            "bun",
            "run",
            entry,
            options.repository,
            "--config",
            config,
            "--output",
            "json",
        ],
        process.env,
    );
    // Kept outside `directory`, which is deleted, so the run can be inspected.
    const logDirectory = await mkdtemp(
        join(tmpdir(), `ralphie-smoke-log-${harness}-`),
    );
    const logPath = join(logDirectory, "run.jsonl");
    await writeFile(logPath, result.stdout);
    const log = parseRunLog(result.stdout);
    console.log(`${harness} run log: ${logPath}`);
    console.log(log.summary ?? "(no `Run completed:` summary line in the log)");
    return result.code === 0
        ? { code: 0, log }
        : {
              code: result.code,
              failure: `ralphie exited ${result.code}: ${result.stderr.trim().slice(-500)}`,
              log,
          };
};

const smokeHarness = async (
    options: SmokeOptions,
    harness: SmokeHarness,
): Promise<{ readonly exitCode: number; readonly problems: string[] }> => {
    const label = `smoke-${harness}`;
    const runId = crypto.randomUUID().slice(0, 8);
    const created = await fileScenarios(options, harness, label, runId);
    const directory = await mkdtemp(
        join(tmpdir(), `ralphie-smoke-${harness}-`),
    );
    try {
        await waitForListing(options.repository, label, created);
        const baseline = await headSha(options.repository);
        const { code, failure, log } = await runRalphie(
            options,
            harness,
            directory,
        );
        return {
            exitCode: code,
            problems:
                failure === undefined
                    ? await verify(
                          options.repository,
                          label,
                          created,
                          baseline,
                          log,
                          runId,
                      )
                    : [failure],
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
        if (!options.keepIssues) {
            for (const issue of await listIssues(options.repository, label)) {
                await gh(
                    "issue",
                    "close",
                    String(issue.number),
                    "--repo",
                    options.repository,
                    "--reason",
                    "not planned",
                );
            }
        }
    }
};

const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const smokeOne = async (
    options: SmokeOptions,
    harness: SmokeHarness,
): Promise<"ok" | "failed" | "skipped"> => {
    if (Bun.which(harness) === null) {
        console.log(`SKIP ${harness}: executable not installed`);
        return "skipped";
    }
    try {
        const { exitCode, problems } = await smokeHarness(options, harness);
        const verdict = smokeVerdict(exitCode, problems);
        console.log(
            verdict === "INCONCLUSIVE"
                ? `INCONCLUSIVE ${harness}: ralphie halted on a limit, outage or expired login; rerun when it clears (${problems.join("; ")})`
                : verdict === "PASS"
                  ? `PASS ${harness}`
                  : `FAIL ${harness}: ${problems.join("; ")}`,
        );
        return verdict === "FAIL" ? "failed" : "ok";
    } catch (error) {
        console.log(`FAIL ${harness}: ${describeError(error)}`);
        return "failed";
    }
};

const main = async (): Promise<number> => {
    let options: SmokeOptions;
    try {
        options = parseSmokeOptions(process.argv.slice(2), process.env);
    } catch (error) {
        console.error(describeError(error));
        return 2;
    }
    let failed = 0;
    let ran = 0;
    for (const harness of options.harnesses) {
        const outcome = await smokeOne(options, harness);
        failed += outcome === "failed" ? 1 : 0;
        ran += outcome === "skipped" ? 0 : 1;
    }
    if (ran === 0) console.error("No harness was run: none is installed.");
    return smokeExitCode(failed, ran);
};

if (import.meta.main) {
    process.exit(await main());
}