import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeGitIssueOperationsService } from "../../src/git/adapters/issue-operations.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";
import { makeGitFixture, type GitFixture } from "../shared/git-fixture.ts";

let fixture: GitFixture | undefined;
afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
});

const git = async (path: string, ...args: string[]): Promise<string> =>
    (await CommandRunnerLive.run("git", ["-C", path, ...args])).stdout.trim();

const commitFile = async (
    path: string,
    name: string,
    content: string,
    message: string,
): Promise<void> => {
    await writeFile(join(path, name), content);
    await git(path, "add", name);
    await git(path, "commit", "-q", "-m", message);
};

describe("candidate commits against a real repository", () => {
    test("readRangeDiff covers only the committed range", async () => {
        fixture = await makeGitFixture();
        const service = makeGitIssueOperationsService(CommandRunnerLive);
        const diff = await service.readRangeDiff(
            fixture.repositoryPath,
            fixture.baseSha,
            fixture.headSha,
        );
        expect(diff).toContain("+changed");
        expect(diff).not.toContain("uncommitted.txt");
    });

    test("squashCandidates folds candidates into one staged change", async () => {
        fixture = await makeGitFixture();
        const path = fixture.repositoryPath;
        await git(path, "reset", "-q", "uncommitted.txt");
        await commitFile(path, "a.txt", "a\n", "candidate 1");
        await commitFile(path, "b.txt", "b\n", "candidate 2");
        const tree = await git(path, "rev-parse", "HEAD^{tree}");
        const service = makeGitIssueOperationsService(CommandRunnerLive);

        await service.squashCandidates(path, fixture.baseSha);

        expect(await git(path, "rev-parse", "HEAD")).toBe(fixture.baseSha);
        expect(await git(path, "write-tree")).toBe(tree);
        expect(await git(path, "diff", "--cached", "--name-only")).toBe(
            "a.txt\nb.txt\nbase.txt",
        );
    });
});