import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewEvidenceFiles } from "../app/review-evidence.ts";

const EVIDENCE_DIRECTORY = ".ralphie-review";

const isMissing = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";

/** Add the evidence directory to the checkout's local exclude list. */
const excludeEvidenceDirectory = async (
    repositoryPath: string,
): Promise<void> => {
    const infoDirectory = join(repositoryPath, ".git", "info");
    const file = join(infoDirectory, "exclude");
    const entry = `/${EVIDENCE_DIRECTORY}/`;
    let current = "";
    try {
        current = await readFile(file, "utf8");
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
    if (current.split("\n").includes(entry)) return;
    await mkdir(infoDirectory, { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(file, `${current}${separator}${entry}\n`, "utf8");
};

/** Writes review evidence under `.ralphie-review/`, excluded from git. */
export const nodeReviewEvidenceFiles: ReviewEvidenceFiles = {
    publish: async ({ repositoryPath, name, contents }) => {
        await excludeEvidenceDirectory(repositoryPath);
        const directory = join(repositoryPath, EVIDENCE_DIRECTORY);
        await mkdir(directory, { recursive: true });
        const path = join(directory, name);
        await writeFile(path, contents, "utf8");
        return {
            path,
            remove: async () => {
                await rm(directory, { recursive: true, force: true });
            },
        };
    },
};