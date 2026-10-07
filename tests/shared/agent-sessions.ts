import type { AgentSessions } from "../../src/agent/sessions.ts";
import { resolveRoleAssignments } from "../../src/harness/app/roles.ts";
import type { HarnessService } from "../../src/harness/ports.ts";

/** The role assignments of a configuration that sets nothing. */
export const defaultRoles = () =>
    resolveRoleAssignments({ harnesses: {}, roles: {} });

/** Agent sessions over a fake harness, with default role assignments. */
export const sessionsFor = (harness: HarnessService): AgentSessions => ({
    harness,
    roles: defaultRoles(),
});