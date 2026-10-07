import { describe, expect, test } from "bun:test";

import {
    resolveRoleAssignments,
    type RoleConfiguration,
} from "../../src/harness/app/roles.ts";

const resolve = (configuration: Partial<RoleConfiguration>) =>
    resolveRoleAssignments({ harnesses: {}, roles: {}, ...configuration });

describe("role assignments", () => {
    test("run every role on Claude Code when nothing is configured", () => {
        const roles = resolve({});

        for (const assignment of Object.values(roles)) {
            expect(assignment).toEqual({ harness: "claude", approval: "safe" });
        }
        expect(Object.keys(roles).sort()).toEqual([
            "decomposer",
            "fixer",
            "implementer",
            "preflight",
            "resolution-verifier",
            "spec-reviewer",
            "standards-reviewer",
            "triager",
        ]);
    });

    test("fall back to the default role", () => {
        const roles = resolve({ roles: { default: "codex" } });

        expect(roles.triager.harness).toBe("codex");
        expect(roles.implementer.harness).toBe("codex");
        expect(roles["spec-reviewer"].harness).toBe("codex");
    });

    test("give both reviewers the reviewer assignment when it is set", () => {
        const roles = resolve({
            roles: { default: "claude", reviewer: "codex" },
        });

        expect(roles["standards-reviewer"].harness).toBe("codex");
        expect(roles["spec-reviewer"].harness).toBe("codex");
        expect(roles.implementer.harness).toBe("claude");
    });

    test("let a specific reviewer role override the reviewer assignment", () => {
        const roles = resolve({
            roles: { reviewer: "codex", "spec-reviewer": "pi" },
        });

        expect(roles["standards-reviewer"].harness).toBe("codex");
        expect(roles["spec-reviewer"].harness).toBe("pi");
    });

    test("make the fixer follow the implementer, including its model", () => {
        const roles = resolve({
            harnesses: { codex: { model: "gpt-5", effort: "high" } },
            roles: { default: "claude", implementer: "codex" },
        });

        expect(roles.implementer).toEqual({
            harness: "codex",
            approval: "safe",
            model: "gpt-5",
            effort: "high",
        });
        expect(roles.fixer).toEqual(roles.implementer);
    });

    test("make the fixer follow the default when the implementer is unset", () => {
        const roles = resolve({ roles: { default: "pi" } });

        expect(roles.fixer).toEqual({ harness: "pi", approval: "safe" });
    });

    test("let an explicit fixer assignment win over the implementer", () => {
        const roles = resolve({
            roles: { implementer: "codex", fixer: "claude" },
        });

        expect(roles.implementer.harness).toBe("codex");
        expect(roles.fixer.harness).toBe("claude");
    });

    test("apply harness model and effort, overridden per role", () => {
        const roles = resolve({
            harnesses: { claude: { model: "opus", effort: "high" } },
            roles: {
                triager: { harness: "claude", model: "haiku" },
                decomposer: { harness: "claude", effort: "low" },
            },
        });

        expect(roles.implementer).toEqual({
            harness: "claude",
            approval: "safe",
            model: "opus",
            effort: "high",
        });
        expect(roles.triager).toEqual({
            harness: "claude",
            approval: "safe",
            model: "haiku",
            effort: "high",
        });
        expect(roles.decomposer).toEqual({
            harness: "claude",
            approval: "safe",
            model: "opus",
            effort: "low",
        });
    });
});
describe("approval", () => {
    test("applies the global approval to every role", () => {
        const roles = resolve({ approval: "yolo" });

        for (const assignment of Object.values(roles)) {
            expect(assignment.approval).toBe("yolo");
        }
    });

    test("lets a harness override the global approval", () => {
        const roles = resolve({
            approval: "safe",
            harnesses: { pi: { approval: "yolo" } },
            roles: { implementer: "pi" },
        });

        expect(roles.implementer.approval).toBe("yolo");
        expect(roles.fixer.approval).toBe("yolo");
        expect(roles.triager.approval).toBe("safe");
    });
});