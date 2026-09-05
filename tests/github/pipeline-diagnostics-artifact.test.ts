import { describe, expect, test } from "bun:test";
import {
    mkdtemp,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    readdir,
    rename as fsRename,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { IssueArtifactScope } from "../../src/issues/artifacts.ts";
import type {
    CollectionResult,
    PipelineSnapshotRequest,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import type { PipelineDiagnosticsCollectionResult } from "../../src/github/pipeline-diagnostics-collector.ts";
import {
    MAX_EXCERPT_BYTES,
    MAX_STEPS_PER_JOB,
    type JobContext,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import type { JobLogExcerptsResult } from "../../src/github/pipeline-diagnostics-logs.ts";
import {
    pipelineDiagnosticsPath,
    makePipelineDiagnosticsStore,
    type PipelineDiagnosticsArtifactFileSystem,
} from "../../src/github/pipeline-diagnostics-artifact.ts";

const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: "a".repeat(40),
};

const jobValue = (jobId: number): JobContext =>
    ({
        provider: "github",
        commitSha: request.commitSha,
        runId: 100,
        runAttempt: 1,
        jobId,
        rawState: {
            status: "completed",
            conclusion: "future-conclusion",
        },
        unknownField: "\u001b[31mgithub_pat_preserved\u001b[0m",
    }) as JobContext;

const childCollection = (
    source: string,
    records: ReadonlyArray<unknown> = [],
): CollectionResult =>
    ({
        request,
        source,
        records,
        truncated: false,
        errors: [],
    }) as CollectionResult;

const collection = (
    jobs: ReadonlyArray<unknown> = [],
    logs?: JobLogExcerptsResult,
): PipelineDiagnosticsCollectionResult => {
    const jobCollection = childCollection("workflow-run", jobs);
    const checks = childCollection("check-run");
    return {
        request,
        source: "pipeline-diagnostics",
        disposition: "ok",
        truncated: false,
        records: jobs,
        errors: [],
        jobs: jobCollection,
        checks,
        ...(logs === undefined ? {} : { logs }),
    } as PipelineDiagnosticsCollectionResult;
};

const scopeFor = (workspace: string): IssueArtifactScope => ({
    workspace,
    runId: "artifact-run",
    repository: request.repository,
});

const realFileSystem: PipelineDiagnosticsArtifactFileSystem = {
    readFile: async (filePath) => await fsReadFile(filePath, "utf8"),
    mkdir: async (directory, options) => {
        await fsMkdir(directory, options);
    },
    writeFile: async (filePath, contents, options) => {
        await fsWriteFile(filePath, contents, options);
    },
    rename: async (temporaryPath, filePath) => {
        await fsRename(temporaryPath, filePath);
    },
    rm: async (filePath, options) => {
        await fsRm(filePath, options);
    },
};

const withWorkspace = async <Result>(
    run: (workspace: string) => Promise<Result>,
): Promise<Result> => {
    const workspace = await mkdtemp(
        join(tmpdir(), "ralphie-pipeline-artifact-"),
    );
    try {
        return await run(workspace);
    } finally {
        await fsRm(workspace, { recursive: true, force: true });
    }
};

describe("pipeline diagnostics artifact", () => {
    test("writes to the pipeline run path, preserves unknown values, and strips terminal controls", async () => {
        await withWorkspace(async (workspace) => {
            const logs: JobLogExcerptsResult = {
                request,
                source: "github.workflow-run.logs",
                records: [
                    {
                        jobId: 1,
                        runId: 100,
                        runAttempt: 1,
                        disposition: "ok",
                        excerpt: "log https://example.invalid\u001b[31mvalue",
                        fetchedBytes: 0,
                    },
                ],
                truncated: false,
                errors: [],
            };
            const store = makePipelineDiagnosticsStore(scopeFor(workspace));
            await store.write(
                collection(
                    [
                        {
                            kind: "job",
                            disposition: "ok",
                            value: jobValue(1),
                        },
                    ],
                    logs,
                ),
            );

            const path = pipelineDiagnosticsPath(scopeFor(workspace));
            expect(store.path).toBe(path);
            expect(path).toContain(join("artifact-run", "pipeline"));
            const text = await fsReadFile(path, "utf8");
            expect(text).not.toContain("\u001b");
            expect(text).toContain("github_pat_preserved");
            expect(text).toContain("future-conclusion");
            expect(text).toContain("log https://example.invalidvalue");
            expect(await readdir(dirname(path))).toEqual(["diagnostics.json"]);
            expect((await store.read()).version).toBe(1);
        });
    });

    test("reapplies job, step, and excerpt bounds with explicit truncation", async () => {
        const jobs: unknown[] = [];
        for (let job = 1; job <= 21; job += 1) {
            jobs.push({ kind: "job", disposition: "ok", value: jobValue(job) });
            for (let step = 1; step <= MAX_STEPS_PER_JOB + 1; step += 1) {
                jobs.push({
                    kind: "step",
                    disposition: "ok",
                    value: {
                        provider: "github",
                        commitSha: request.commitSha,
                        runId: 100,
                        runAttempt: 1,
                        jobId: job,
                        number: step,
                        name: `step-${step}`,
                    },
                });
            }
        }
        const logs: JobLogExcerptsResult = {
            request,
            source: "github.workflow-run.logs",
            records: [
                {
                    jobId: 1,
                    runId: 100,
                    runAttempt: 1,
                    disposition: "ok",
                    excerpt: "x".repeat(MAX_EXCERPT_BYTES + 100),
                    fetchedBytes: MAX_EXCERPT_BYTES + 100,
                },
            ],
            truncated: false,
            errors: [],
        };
        const normalized = await (async () => {
            const workspace = await mkdtemp(
                join(tmpdir(), "ralphie-pipeline-bounds-"),
            );
            try {
                const local = makePipelineDiagnosticsStore(scopeFor(workspace));
                await local.write(collection(jobs, logs));
                return await local.read();
            } finally {
                await fsRm(workspace, { recursive: true, force: true });
            }
        })();
        const jobRecords = normalized.jobs.records as ReadonlyArray<{
            readonly kind: string;
        }>;
        expect(jobRecords.filter(({ kind }) => kind === "job")).toHaveLength(
            20,
        );
        expect(
            jobRecords.filter(({ kind }) => kind === "step").length,
        ).toBeLessThanOrEqual(20 * MAX_STEPS_PER_JOB);
        expect(normalized.truncated).toBe(true);
        expect(normalized.logs.records[0]?.excerpt.length).toBe(
            MAX_EXCERPT_BYTES,
        );
        expect(normalized.logs.errors.length).toBeGreaterThan(0);
    });

    test("removes a failed temporary write and leaves no partial artifact", async () => {
        await withWorkspace(async (workspace) => {
            const failingFileSystem: PipelineDiagnosticsArtifactFileSystem = {
                ...realFileSystem,
                writeFile: async () => {
                    throw new Error("disk full");
                },
            };
            const store = makePipelineDiagnosticsStore(scopeFor(workspace), {
                fileSystem: failingFileSystem,
            });
            await expect(store.write(collection())).rejects.toThrow(
                "Failed to persist pipeline diagnostics",
            );
            await expect(
                fsReadFile(
                    pipelineDiagnosticsPath(scopeFor(workspace)),
                    "utf8",
                ),
            ).rejects.toThrow();
            expect(await readdir(dirname(store.path))).toEqual([]);
        });
    });

    test("refuses an unsupported artifact version", async () => {
        await withWorkspace(async (workspace) => {
            const store = makePipelineDiagnosticsStore(scopeFor(workspace));
            await fsMkdir(dirname(store.path), { recursive: true });
            await fsWriteFile(
                store.path,
                JSON.stringify({ version: 99 }),
                "utf8",
            );

            await expect(store.read()).rejects.toThrow(
                "unsupported version 99",
            );
        });
    });
});