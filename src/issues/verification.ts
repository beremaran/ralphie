import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunnerService } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

const OUTPUT_LIMIT = 8_000;

/**
 * Deadline for user-configured verification commands. These run the repository's
 * own gate (for example a full `bun run check`), so they are deliberately more
 * generous than the generic process timeout, but still bounded: a hung
 * verification command fails the run instead of stalling it forever.
 */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

const bounded = (value: string): string =>
    value.length <= OUTPUT_LIMIT
        ? value
        : `${value.slice(0, OUTPUT_LIMIT)}\n...[verification output truncated]...`;

export const verificationCommandResultSchema = z.object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
});

export const verificationEvidenceSchema = z.object({
    stagedTreeSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i),
    commands: z.array(verificationCommandResultSchema).min(1),
});

export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

/** A deterministic command rejected an otherwise intact staged tree. */
export class VerificationCommandError extends RalphieError {
    override readonly _tag = "VerificationCommandError" as const;
    readonly verification: VerificationEvidence;

    constructor(verification: VerificationEvidence) {
        const failed = verification.commands.findLast(
            ({ exitCode }) => exitCode !== 0,
        );
        super({
            message:
                failed === undefined
                    ? "Deterministic verification failed without a failing command."
                    : `Verification command failed (${failed.exitCode}): ${failed.command}\n${failed.stderr || failed.stdout}`,
        });
        this.name = "VerificationCommandError";
        this.verification = verification;
    }
}

export type IssueVerificationService = {
    readonly verify: (
        repositoryPath: string,
        commands: ReadonlyArray<string>,
    ) => Promise<VerificationEvidence>;
    readonly stagedTreeSha: (repositoryPath: string) => Promise<string>;
};

export const makeIssueVerificationService = (
    runner: CommandRunnerService,
): IssueVerificationService => {
    const resolveCommands = async (
        repositoryPath: string,
        commands: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<string>> => {
        if (commands.length > 0) return commands;
        try {
            const manifest = JSON.parse(
                await readFile(join(repositoryPath, "package.json"), "utf8"),
            ) as { readonly scripts?: { readonly check?: unknown } };
            if (typeof manifest.scripts?.check === "string") {
                return ["bun run check"];
            }
        } catch {
            // Fall through to the fail-closed error below.
        }
        throw new RalphieError({
            message:
                "No deterministic verification command is configured or discoverable. Supply --verify-command.",
        });
    };
    const stagedTreeSha = async (repositoryPath: string): Promise<string> => {
        const result = await runner.run("git", ["write-tree"], {
            cwd: repositoryPath,
        });
        if (
            result.exitCode !== 0 ||
            !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(result.stdout)
        ) {
            throw new RalphieError({
                message: `Failed to capture the staged tree before verification: ${result.stderr || result.stdout}`,
            });
        }
        return result.stdout;
    };

    return {
        stagedTreeSha,
        verify: async (repositoryPath, commands) => {
            const resolvedCommands = await resolveCommands(
                repositoryPath,
                commands,
            );
            const tree = await stagedTreeSha(repositoryPath);
            const results = [];
            for (const command of resolvedCommands) {
                const result = await runner.run("/bin/sh", ["-c", command], {
                    cwd: repositoryPath,
                    trimStdout: false,
                    timeoutMs: VERIFICATION_COMMAND_TIMEOUT_MS,
                });
                const evidence = {
                    command,
                    exitCode: result.exitCode,
                    stdout: bounded(result.stdout),
                    stderr: bounded(result.stderr),
                };
                results.push(evidence);
                if (result.exitCode !== 0) {
                    const after = await stagedTreeSha(repositoryPath);
                    if (after.toLowerCase() !== tree.toLowerCase()) {
                        throw new RalphieError({
                            message:
                                "Verification changed the staged tree; refusing to continue.",
                        });
                    }
                    throw new VerificationCommandError({
                        stagedTreeSha: tree,
                        commands: results,
                    });
                }
            }
            const after = await stagedTreeSha(repositoryPath);
            if (after.toLowerCase() !== tree.toLowerCase()) {
                throw new RalphieError({
                    message:
                        "Verification changed the staged tree; refusing to continue.",
                });
            }
            return { stagedTreeSha: tree, commands: results };
        },
    };
};