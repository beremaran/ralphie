import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
    EDIT_SESSION_TIMEOUT_MS,
    READ_ONLY_SESSION_TIMEOUT_MS,
    sessionRequest,
} from "../../src/agent/sessions.ts";
import { requestStructuredOutput } from "../../src/agent/structured-output.ts";
import { runAgentTask } from "../../src/agent/task-session.ts";
import { resolveRoleAssignments } from "../../src/harness/app/roles.ts";
import { RalphieError } from "../../src/shared/error.ts";
import { makeFakeHarness } from "../shared/fake-harness.ts";

const schema = z.object({ ok: z.boolean() });

const base = {
    directory: "/work/repository",
    title: "task",
    prompt: "Do the work.",
};

const defaultRoles = () => resolveRoleAssignments({ harnesses: {}, roles: {} });

describe("agent sessions over the harness", () => {
    test("start a structured session with the role's assignment and access", async () => {
        const fake = makeFakeHarness({
            roles: {
                "standards-reviewer": { value: { result: { ok: true } } },
            },
        });
        const roles = resolveRoleAssignments({
            harnesses: { claude: { model: "opus", effort: "high" } },
            roles: { reviewer: { harness: "claude", model: "sonnet" } },
        });

        const result = await requestStructuredOutput(
            { harness: fake.service, roles },
            { ...base, role: "standards-reviewer", schema },
        );

        expect(result.output).toEqual({ ok: true });
        const [request] = fake.requests;
        expect(request).toMatchObject({
            role: "standards-reviewer",
            harness: "claude",
            model: "sonnet",
            effort: "high",
            access: "read-only",
            directory: "/work/repository",
            timeoutMs: READ_ONLY_SESSION_TIMEOUT_MS,
        });
        expect(request?.prompt).toContain("Do the work.");
    });

    test("surface the hand-off side channel from the result", async () => {
        const fake = makeFakeHarness({
            roles: {
                preflight: {
                    value: {
                        result: { ok: true },
                        handOff: { reason: "missing_information" },
                    },
                },
            },
        });

        const result = await requestStructuredOutput(
            { harness: fake.service, roles: defaultRoles() },
            { ...base, role: "preflight", schema },
        );

        expect(result.handOff).toEqual({
            reason: "missing_information",
        });
    });

    test("give editing roles safe access and the editing timeout", async () => {
        const fake = makeFakeHarness({
            roles: { fixer: { text: "fixed", harnessSessionID: "h-1" } },
        });

        const result = await runAgentTask(
            { harness: fake.service, roles: defaultRoles() },
            { ...base, role: "fixer" },
        );

        expect(result).toEqual({ sessionID: "h-1", text: "fixed" });
        expect(fake.requests[0]).toMatchObject({
            role: "fixer",
            access: "safe",
            timeoutMs: EDIT_SESSION_TIMEOUT_MS,
        });
    });

    test("let a request narrow an editing role to read-only", async () => {
        const fake = makeFakeHarness({
            roles: { implementer: { value: { result: { ok: true } } } },
        });

        await requestStructuredOutput(
            { harness: fake.service, roles: defaultRoles() },
            { ...base, role: "implementer", access: "read-only", schema },
        );

        expect(fake.requests[0]?.access).toBe("read-only");
    });

    test("turn a failed session into an error that names the role and kind", async () => {
        const fake = makeFakeHarness({
            roles: {
                decomposer: {
                    failure: { kind: "timeout", message: "took too long" },
                },
            },
        });

        const error = await requestStructuredOutput(
            { harness: fake.service, roles: defaultRoles() },
            { ...base, role: "decomposer", schema },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RalphieError);
        expect((error as Error).message).toContain("decomposer");
        expect((error as Error).message).toContain("timeout");
        expect((error as Error).message).toContain("took too long");
    });

    test("fail a structured session whose result breaks the schema", async () => {
        const fake = makeFakeHarness({
            roles: { triager: { value: { result: { ok: "yes" } } } },
        });

        await expect(
            requestStructuredOutput(
                { harness: fake.service, roles: defaultRoles() },
                { ...base, role: "triager", schema },
            ),
        ).rejects.toThrow("invalid_result");
    });
});
describe("session limits and approval", () => {
    test("edit roles follow the configured approval mode", async () => {
        const fake = makeFakeHarness({
            roles: { implementer: { text: "done" } },
        });
        const roles = resolveRoleAssignments({
            approval: "yolo",
            harnesses: {},
            roles: {},
        });

        await runAgentTask(
            { harness: fake.service, roles },
            { ...base, role: "implementer" },
        );

        expect(fake.requestsFor("implementer")[0]?.access).toBe("yolo");
    });

    test("a read-only override stays read-only under yolo", () => {
        const fake = makeFakeHarness({});
        const roles = resolveRoleAssignments({
            approval: "yolo",
            harnesses: {},
            roles: {},
        });

        const request = sessionRequest(
            { harness: fake.service, roles },
            { ...base, role: "implementer", access: "read-only" },
        );

        expect(request.access).toBe("read-only");
    });

    test("pass the configured timeouts and budget cap", async () => {
        const fake = makeFakeHarness({
            roles: {
                implementer: { text: "done" },
                triager: { value: { result: { ok: true } } },
            },
        });
        const sessions = {
            harness: fake.service,
            roles: defaultRoles(),
            limits: {
                editTimeoutMs: 1_000,
                readOnlyTimeoutMs: 500,
                maxBudgetUsd: 2.5,
            },
        };

        await runAgentTask(sessions, { ...base, role: "implementer" });
        await requestStructuredOutput(sessions, {
            ...base,
            role: "triager",
            schema,
        });

        const edit = fake.requestsFor("implementer")[0];
        const readOnly = fake.requestsFor("triager")[0];
        expect([edit?.timeoutMs, edit?.maxBudgetUsd]).toEqual([1_000, 2.5]);
        expect([readOnly?.timeoutMs, readOnly?.maxBudgetUsd]).toEqual([
            500, 2.5,
        ]);
    });

    test("leave the budget cap unset by default", async () => {
        const fake = makeFakeHarness({
            roles: { implementer: { text: "done" } },
        });

        await runAgentTask(
            { harness: fake.service, roles: defaultRoles() },
            { ...base, role: "implementer" },
        );

        expect(fake.requestsFor("implementer")[0]).not.toHaveProperty(
            "maxBudgetUsd",
        );
    });
});