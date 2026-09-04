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

import {
    IssueArtifactKind,
    IssueArtifactWriteAbortedError,
    issueArtifactPath,
    makeDurableIssueArtifactStore,
    type IssueArtifactFileSystem,
    type IssueArtifactScope,
} from "../../src/issues/artifacts.ts";
import { ReviewVerdict } from "../../src/issues/decisions.ts";
import type { ReviewAttempt } from "../../src/issues/recovery.ts";

const issueNumber = 42;
const scopeFor = (workspace: string): IssueArtifactScope => ({
    workspace,
    runId: "cancellation-boundary",
    repository: "owner/repo",
});

const realFileSystem: IssueArtifactFileSystem = {
    readFile: async (filePath, encoding) =>
        await fsReadFile(filePath, { encoding }),
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

const reviewFor = (attempt: number): ReviewAttempt => ({
    attempt,
    sessionID: `review-session-${attempt}`,
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: `Review ${attempt} is approved.`,
        findings: [],
    },
});

const withWorkspace = async <Result>(
    run: (workspace: string) => Promise<Result>,
): Promise<Result> => {
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifact-"));
    try {
        return await run(workspace);
    } finally {
        await fsRm(workspace, { recursive: true, force: true });
    }
};

const artifactFiles = async (
    filePath: string,
): Promise<ReadonlyArray<string>> => await readdir(dirname(filePath));

describe("durable issue artifact cancellation", () => {
    test("cancelling during temporary writing leaves no attempt or temporary file", async () => {
        await withWorkspace(async (workspace) => {
            let writeStarted!: () => void;
            const writeStartedPromise = new Promise<void>(
                (resolve) => (writeStarted = resolve),
            );
            let releaseWrite!: () => void;
            const releaseWritePromise = new Promise<void>(
                (resolve) => (releaseWrite = resolve),
            );
            const fileSystem: IssueArtifactFileSystem = {
                ...realFileSystem,
                writeFile: async (filePath, contents, options) => {
                    writeStarted();
                    await releaseWritePromise;
                    if (options.signal?.aborted === true) {
                        throw options.signal.reason ?? new Error("cancelled");
                    }
                    await realFileSystem.writeFile(filePath, contents, options);
                },
            };
            const store = await makeDurableIssueArtifactStore(
                issueNumber,
                scopeFor(workspace),
                { fileSystem },
            );
            const filePath = issueArtifactPath(
                scopeFor(workspace),
                issueNumber,
            );
            const controller = new AbortController();
            const pending = store.appendReview(reviewFor(1), controller.signal);

            await writeStartedPromise;
            const reason = new Error("cancel during temporary write");
            controller.abort(reason);
            releaseWrite();

            let failure: unknown;
            try {
                await pending;
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(IssueArtifactWriteAbortedError);
            expect(failure).toMatchObject({
                committed: false,
                phase: "write",
                issueNumber,
            });
            expect(store.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
            await expect(fsReadFile(filePath, "utf8")).rejects.toThrow();
            expect(await artifactFiles(filePath)).toEqual([]);
        });
    });

    test("cancelling after a real rename reports the commit and retry preserves order", async () => {
        await withWorkspace(async (workspace) => {
            const controller = new AbortController();
            const reason = new Error("cancel after rename");
            let renameCount = 0;
            const fileSystem: IssueArtifactFileSystem = {
                ...realFileSystem,
                rename: async (temporaryPath, filePath) => {
                    renameCount += 1;
                    await fsRename(temporaryPath, filePath);
                    if (renameCount === 1) {
                        controller.abort(reason);
                        throw new Error("rename acknowledgement was cancelled");
                    }
                },
            };
            const scope = scopeFor(workspace);
            const store = await makeDurableIssueArtifactStore(
                issueNumber,
                scope,
                { fileSystem },
            );
            const filePath = issueArtifactPath(scope, issueNumber);

            let failure: unknown;
            try {
                await store.appendReview(reviewFor(1), controller.signal);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(IssueArtifactWriteAbortedError);
            expect(failure).toMatchObject({
                committed: true,
                phase: "rename",
                issueNumber,
            });
            expect(store.has(IssueArtifactKind.ReviewAttempts)).toBe(true);
            expect(
                (await store.read(IssueArtifactKind.ReviewAttempts)).map(
                    ({ attempt }) => attempt,
                ),
            ).toEqual([1]);

            await store.appendReview(reviewFor(2));

            const persisted = JSON.parse(
                await fsReadFile(filePath, "utf8"),
            ) as {
                readonly artifacts: {
                    readonly [IssueArtifactKind.ReviewAttempts]: ReadonlyArray<ReviewAttempt>;
                };
            };
            expect(
                persisted.artifacts[IssueArtifactKind.ReviewAttempts].map(
                    ({ attempt }) => attempt,
                ),
            ).toEqual([1, 2]);
            expect(await artifactFiles(filePath)).toEqual(["artifacts.json"]);
        });
    });

    test("a pre-aborted append fails before opening the durable boundary", async () => {
        await withWorkspace(async (workspace) => {
            let writes = 0;
            const fileSystem: IssueArtifactFileSystem = {
                ...realFileSystem,
                writeFile: async (...args) => {
                    writes += 1;
                    await realFileSystem.writeFile(...args);
                },
            };
            const store = await makeDurableIssueArtifactStore(
                issueNumber,
                scopeFor(workspace),
                { fileSystem },
            );
            const controller = new AbortController();
            controller.abort(new Error("already cancelled"));

            await expect(
                store.appendReview(reviewFor(1), controller.signal),
            ).rejects.toMatchObject({
                _tag: "IssueArtifactWriteAbortedError",
                committed: false,
                phase: "before-write",
                issueNumber,
            });
            expect(writes).toBe(0);
            expect(store.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
        });
    });
});