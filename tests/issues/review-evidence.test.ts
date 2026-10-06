import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeReviewEvidenceFiles } from "../../src/issues/adapters/review-evidence-file-system.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";

test("evidence files are readable, never show up in git status, and are removed", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ralphie-evidence-"));
    try {
        await CommandRunnerLive.run("git", ["-C", repository, "init", "-q"]);
        const file = await nodeReviewEvidenceFiles.publish({
            repositoryPath: repository,
            name: "candidate-diff.txt",
            contents: "the whole diff",
        });
        expect(file.path).toBe(
            join(repository, ".ralphie-review", "candidate-diff.txt"),
        );
        expect(await readFile(file.path, "utf8")).toBe("the whole diff");
        const status = await CommandRunnerLive.run("git", [
            "-C",
            repository,
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]);
        expect(status.stdout).toBe("");
        // A second publish does not duplicate the exclude entry.
        await nodeReviewEvidenceFiles.publish({
            repositoryPath: repository,
            name: "candidate-diff.txt",
            contents: "again",
        });
        const exclude = await readFile(
            join(repository, ".git", "info", "exclude"),
            "utf8",
        );
        expect(exclude.split("/.ralphie-review/").length).toBe(2);
        await file.remove();
        await file.remove();
        expect(
            await access(file.path).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    } finally {
        await rm(repository, { recursive: true, force: true });
    }
});
