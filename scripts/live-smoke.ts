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

export const smokeScenarios = (harness: SmokeHarness): SmokeScenario[] => [
    {
        name: "implementation",
        title: `Smoke ${harness}: add greeting file`,
        body: "Create a file `greeting.txt` at the repository root containing exactly `hello`.",
    },
    {
        name: "hand-off",
        title: `Smoke ${harness}: ambiguous requirement`,
        body: "Make the output format match the agreed format. There is no agreed format written anywhere; a human must decide it.",
    },
    {
        name: "decomposition",
        title: `Smoke ${harness}: large feature`,
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

export type SmokeVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** A transient halt proves nothing either way; any other problem fails. */
export const smokeVerdict = (
    exitCode: number,
    problems: readonly string[],
): SmokeVerdict => {
    if (exitCode === HALTED_EXIT_CODE) return "INCONCLUSIVE";
    return exitCode === 0 && problems.length === 0 ? "PASS" : "FAIL";
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

const verify = async (
    repository: string,
    label: string,
    created: ReadonlyMap<string, number>,
): Promise<string[]> => {
    const problems: string[] = [];
    const labelled = await listIssues(repository, label);
    const state = (name: string): string | undefined =>
        labelled.find((issue) => issue.number === created.get(name))?.state;
    if (state("implementation") !== "CLOSED") {
        problems.push("implementation issue was not closed");
    }
    if (state("hand-off") !== "OPEN") {
        problems.push("hand-off issue should stay open for a human");
    }
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
    for (const scenario of smokeScenarios(harness)) {
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

const runRalphie = async (
    options: SmokeOptions,
    harness: SmokeHarness,
    directory: string,
): Promise<{ readonly code: number; readonly failure?: string }> => {
    const config = join(directory, "config.yaml");
    await writeFile(config, smokeConfig(harness, join(directory, "workspace")));
    const entry = join(resolve(import.meta.dir, ".."), "index.ts");
    const result = await run(
        ["bun", "run", entry, options.repository, "--config", config],
        process.env,
    );
    console.log(result.stdout.slice(-2000));
    return result.code === 0
        ? { code: 0 }
        : {
              code: result.code,
              failure: `ralphie exited ${result.code}: ${result.stderr.trim().slice(-500)}`,
          };
};

const smokeHarness = async (
    options: SmokeOptions,
    harness: SmokeHarness,
): Promise<{ readonly exitCode: number; readonly problems: string[] }> => {
    const label = `smoke-${harness}`;
    const created = await fileScenarios(options, harness, label);
    const directory = await mkdtemp(
        join(tmpdir(), `ralphie-smoke-${harness}-`),
    );
    try {
        const { code, failure } = await runRalphie(options, harness, directory);
        return {
            exitCode: code,
            problems:
                failure === undefined
                    ? await verify(options.repository, label, created)
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
): Promise<boolean> => {
    if (Bun.which(harness) === null) {
        console.log(`SKIP ${harness}: executable not installed`);
        return true;
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
        return verdict !== "FAIL";
    } catch (error) {
        console.log(`FAIL ${harness}: ${describeError(error)}`);
        return false;
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
    for (const harness of options.harnesses) {
        failed += (await smokeOne(options, harness)) ? 0 : 1;
    }
    return failed === 0 ? 0 : 1;
};

if (import.meta.main) {
    process.exit(await main());
}