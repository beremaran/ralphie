import { describe, expect, test } from "bun:test";

import {
    workflowErrorFor,
    workflowOptionsFor,
    writeTemporaryFile,
} from "./shared/config-fixture.ts";

describe("command startup checks", () => {
    test("stops before the runtime is made when a check fails", async () => {
        const config = await writeTemporaryFile("{}");
        let runtimeMade = false;

        const error = await workflowErrorFor(
            ["owner/repository", "--config", config],
            {
                factories: {
                    checkHarnesses: async () => ({
                        errors: ["Harness claude is not usable (missing)."],
                        warnings: [],
                    }),
                    makeRuntime: () => {
                        runtimeMade = true;
                        return {} as never;
                    },
                },
            },
        );

        expect(error.message).toContain("Harness startup checks failed");
        expect(error.message).toContain("Harness claude is not usable");
        expect(runtimeMade).toBe(false);
    });

    test("checks the resolved roles, the budget cap and the opt-ins", async () => {
        const config = await writeTemporaryFile(`
approval: yolo
limits:
  maxBudgetUsd: 3
harnesses:
  opencode:
    experimental: true
roles:
  reviewer: codex
`);
        const seen: unknown[] = [];

        await workflowOptionsFor(["owner/repository", "--config", config], {
            factories: {
                checkHarnesses: async (input) => {
                    seen.push(input);
                    return { errors: [], warnings: [] };
                },
            },
        });

        expect(seen).toHaveLength(1);
        const input = seen[0] as {
            roles: Record<string, { harness: string; approval: string }>;
            maxBudgetUsd: number;
            experimentalHarnesses: string[];
        };
        expect(input.maxBudgetUsd).toBe(3);
        expect(input.experimentalHarnesses).toEqual(["opencode"]);
        expect(input.roles["standards-reviewer"]).toMatchObject({
            harness: "codex",
            approval: "yolo",
        });
    });

    test("hands skills.dir to the runtime as the skills directory", async () => {
        const config = await writeTemporaryFile(`
skills:
  dir: /opt/custom-skills
`);
        let directory: string | undefined;

        await workflowOptionsFor(["owner/repository", "--config", config], {
            factories: {
                makeRuntime: (input) => {
                    directory = input.skills.directory;
                    return {} as never;
                },
            },
        });

        expect(directory).toBe("/opt/custom-skills");
    });

    test("falls back to the bundled skills without skills.dir", async () => {
        const config = await writeTemporaryFile("{}");
        let directory: string | undefined;

        await workflowOptionsFor(["owner/repository", "--config", config], {
            factories: {
                makeRuntime: (input) => {
                    directory = input.skills.directory;
                    return {} as never;
                },
            },
        });

        expect(directory).toEndWith("vendor/mattpocock-skills");
    });

    test("passes session timeouts and the budget cap to the workflow", async () => {
        const config = await writeTemporaryFile(`
limits:
  maxBudgetUsd: 1.5
  sessionTimeoutMinutes:
    edit: 30
    readOnly: 5
`);

        const options = await workflowOptionsFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(options.sessionLimits).toEqual({
            editTimeoutMs: 30 * 60_000,
            readOnlyTimeoutMs: 5 * 60_000,
            maxBudgetUsd: 1.5,
        });
    });

    test("defaults to 60 and 15 minutes with no budget cap", async () => {
        const config = await writeTemporaryFile("{}");

        const options = await workflowOptionsFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(options.sessionLimits).toEqual({
            editTimeoutMs: 60 * 60_000,
            readOnlyTimeoutMs: 15 * 60_000,
        });
        expect(options.roles.implementer.approval).toBe("safe");
    });

    test("layers approval per repository and harness", async () => {
        const config = await writeTemporaryFile(`
harnesses:
  pi:
    approval: yolo
repos:
  owner/repository:
    approval: yolo
    roles:
      implementer: pi
`);

        const options = await workflowOptionsFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(options.roles.implementer).toEqual({
            harness: "pi",
            approval: "yolo",
        });
        expect(options.roles.triager.approval).toBe("yolo");
    });

    test("rejects an unknown approval mode and non-positive limits", async () => {
        const config = await writeTemporaryFile(`
approval: reckless
limits:
  maxBudgetUsd: 0
  sessionTimeoutMinutes:
    edit: 0
`);

        const error = await workflowErrorFor([
            "owner/repository",
            "--config",
            config,
        ]);

        for (const key of [
            "approval",
            "limits.maxBudgetUsd",
            "limits.sessionTimeoutMinutes.edit",
        ]) {
            expect(error.message).toContain(key);
        }
    });
});