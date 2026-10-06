import { describe, expect, test } from "bun:test";

import { makeHarnessProbe } from "../../src/harness/adapters/probe.ts";
import { resolveRoleAssignments } from "../../src/harness/app/roles.ts";
import { makeHarnessStartupChecker } from "../../src/harness/app/startup-checks.ts";
import type {
    HarnessAdapter,
    HarnessProbe,
    ProbeResult,
} from "../../src/harness/ports.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { makeScriptedRunner } from "./scripted-runner.ts";

const CAPABILITIES = {
    claude: { nativeSchema: true, budgetCap: true },
    codex: { nativeSchema: true, budgetCap: false },
    pi: { nativeSchema: false, budgetCap: false },
    opencode: { nativeSchema: false, budgetCap: false },
} as const;

const probeWith = (
    overrides: {
        readonly missing?: readonly string[];
        readonly safeDenied?: readonly string[];
    } = {},
): HarnessProbe => ({
    capabilities: (name) => CAPABILITIES[name as keyof typeof CAPABILITIES],
    installed: async (name): Promise<ProbeResult> =>
        overrides.missing?.includes(name)
            ? { ok: false, message: `${name} not found` }
            : { ok: true },
    safeAccess: async (name): Promise<ProbeResult> =>
        overrides.safeDenied?.includes(name)
            ? { ok: false, message: "auto mode unavailable" }
            : { ok: true },
});

const check = (
    configuration: Parameters<typeof resolveRoleAssignments>[0],
    probe: HarnessProbe,
    maxBudgetUsd?: number,
) =>
    makeHarnessStartupChecker(probe)({
        roles: resolveRoleAssignments(configuration),
        maxBudgetUsd,
    });

describe("harness startup checks", () => {
    test("accept the default configuration", async () => {
        const report = await check({ harnesses: {}, roles: {} }, probeWith());

        expect(report).toEqual({ errors: [], warnings: [] });
    });

    test("name the roles and the fix when a harness is missing", async () => {
        const report = await check(
            { harnesses: {}, roles: { reviewer: "codex" } },
            probeWith({ missing: ["codex"] }),
        );

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]).toContain("Harness codex is not usable");
        expect(report.errors[0]).toContain("standards-reviewer");
        expect(report.errors[0]).toContain("roles.default or roles.<role>");
    });

    test("name the fix when safe approval is unavailable", async () => {
        const report = await check(
            { harnesses: {}, roles: {} },
            probeWith({ safeDenied: ["claude"] }),
        );

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]).toContain("auto mode unavailable");
        expect(report.errors[0]).toContain("harnesses.claude.approval: yolo");
    });

    test("do not probe safe access when editing roles use yolo", async () => {
        const report = await check(
            { approval: "yolo", harnesses: {}, roles: {} },
            probeWith({ safeDenied: ["claude"] }),
        );

        expect(report.errors).toEqual([]);
    });

    test("refuse pi in an editing role without yolo", async () => {
        const report = await check(
            { harnesses: {}, roles: { implementer: "pi" } },
            probeWith(),
        );

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]).toContain("implementer and fixer");
        expect(report.errors[0]).toContain("no sandbox or approval system");
        expect(report.errors[0]).toContain("harnesses.pi.approval: yolo");
        expect(report.errors[0]).toContain("roles.implementer");
    });

    test("refuse OpenCode in an editing role without yolo", async () => {
        const report = await check(
            { harnesses: {}, roles: { fixer: "opencode" } },
            probeWith(),
        );

        expect(report.errors[0]).toContain("fixer would edit with opencode");
    });

    test("allow pi and OpenCode in editing roles set to yolo", async () => {
        const report = await check(
            {
                harnesses: { pi: { approval: "yolo" } },
                roles: { implementer: "pi", reviewer: "opencode" },
            },
            probeWith(),
        );

        expect(report.errors).toEqual([]);
    });

    test("allow pi in a read-only role without yolo", async () => {
        const report = await check(
            { harnesses: {}, roles: { reviewer: "pi" } },
            probeWith(),
        );

        expect(report.errors).toEqual([]);
    });

    test("warn about each harness that cannot enforce the budget cap", async () => {
        const report = await check(
            {
                harnesses: {},
                roles: { implementer: "claude", reviewer: "codex" },
            },
            probeWith(),
            5,
        );

        expect(report.errors).toEqual([]);
        expect(report.warnings).toHaveLength(1);
        expect(report.warnings[0]).toContain("codex");
        expect(report.warnings[0]).toContain("limits.maxBudgetUsd");
    });

    test("do not warn without a budget cap", async () => {
        const report = await check(
            { harnesses: {}, roles: { reviewer: "codex" } },
            probeWith(),
        );

        expect(report.warnings).toEqual([]);
    });
});

const INIT = (mode: string) =>
    JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s",
        permissionMode: mode,
    });

const probeFor = (scripts: Parameters<typeof makeScriptedRunner>[0]) => {
    const scripted = makeScriptedRunner(scripts);
    const adapters = {
        claude: { name: "claude", capabilities: CAPABILITIES.claude },
    } as unknown as Record<string, HarnessAdapter>;
    return {
        ...scripted,
        probe: makeHarnessProbe({ runner: scripted.runner, adapters }),
    };
};

describe("harness probe", () => {
    test("reports a harness whose executable cannot start", async () => {
        const { probe } = probeFor([
            { throws: new RalphieError({ message: "Could not execute pi." }) },
        ]);

        expect(await probe.installed("pi")).toEqual({
            ok: false,
            message: "Could not execute pi.",
        });
    });

    test("runs the version command with a bounded timeout", async () => {
        const { probe, invocations } = probeFor([{ stdout: "1.0.0\n" }]);

        expect(await probe.installed("codex")).toEqual({ ok: true });
        expect(invocations[0]?.command).toBe("codex");
        expect(invocations[0]?.args).toEqual(["--version"]);
        expect(invocations[0]?.options.timeoutMs).toBeLessThanOrEqual(30_000);
    });

    test("accepts Claude Code when auto mode is granted", async () => {
        const { probe, invocations } = probeFor([{ stdout: INIT("auto") }]);

        expect(await probe.safeAccess("claude")).toEqual({ ok: true });
        expect(invocations[0]?.args).toContain("auto");
    });

    test("rejects Claude Code when auto mode falls back", async () => {
        const { probe } = probeFor([{ stdout: INIT("default") }]);

        const result = await probe.safeAccess("claude");

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain("default");
    });

    test("rejects Claude Code when no init event arrives", async () => {
        const { probe } = probeFor([{ stdout: "", exitCode: 1 }]);

        expect((await probe.safeAccess("claude")).ok).toBe(false);
    });

    test("needs no probing for harnesses with a sandbox of their own", async () => {
        const { probe, invocations } = probeFor([]);

        expect(await probe.safeAccess("codex")).toEqual({ ok: true });
        expect(invocations).toHaveLength(0);
    });

    test("reports the configured capabilities", () => {
        const { probe } = probeFor([]);

        expect(probe.capabilities("claude")?.budgetCap).toBe(true);
        expect(probe.capabilities("nothing")).toBeUndefined();
    });
});
describe("harness minimum versions", () => {
    test("accepts the minimum version and newer", async () => {
        const { probe } = probeFor([
            { stdout: "codex-cli 0.160.0\n" },
            { stdout: "2.1.290 (Claude Code)\n" },
        ]);

        expect(await probe.installed("codex")).toEqual({ ok: true });
        expect(await probe.installed("claude")).toEqual({ ok: true });
    });

    test("names the harness and required version when too old", async () => {
        const { probe } = probeFor([{ stdout: "2.1.288 (Claude Code)\n" }]);

        const result = await probe.installed("claude");

        expect(result).toMatchObject({ ok: false });
        if (!result.ok) {
            expect(result.message).toContain("claude 2.1.288");
            expect(result.message).toContain("2.1.289");
        }
    });

    test("warns instead of failing when the version cannot be read", async () => {
        const { probe } = probeFor([{ stdout: "dev build\n" }]);

        const result = await probe.installed("pi");

        expect(result.ok).toBe(true);
        expect(result.ok && result.warning).toContain("pi 1.0.2");
    });

    test("startup reports the unreadable-version warning", async () => {
        const warning = "Could not read the pi version";
        const report = await check(
            { harnesses: {}, roles: { reviewer: "pi" } },
            {
                ...probeWith(),
                installed: async (name) =>
                    name === "pi" ? { ok: true, warning } : { ok: true },
            },
        );

        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([warning]);
    });
});

describe("startup checks and the triager", () => {
    const probe = probeWith({ missing: ["codex"] });
    const configuration = { harnesses: {}, roles: { triager: "codex" } };

    test("skip the triager's harness when triage is disabled", async () => {
        const report = await makeHarnessStartupChecker(probe)({
            roles: resolveRoleAssignments(configuration),
            triageEnabled: false,
        });

        expect(report.errors).toEqual([]);
    });

    test("check the triager's harness when triage is enabled", async () => {
        const report = await makeHarnessStartupChecker(probe)({
            roles: resolveRoleAssignments(configuration),
            triageEnabled: true,
        });

        expect(report.errors[0]).toContain("Harness codex is not usable");
    });
});