import { EDITING_ROLES, type HarnessProbe } from "../ports.ts";
import type { RoleAssignments } from "./roles.ts";

/** Harnesses with neither a sandbox nor an approval system to run `safe`. */
export const HARNESSES_WITHOUT_SAFE_MODE: ReadonlyArray<string> = [
    "pi",
    "opencode",
];

/** What startup found: errors stop the run, warnings are only reported. */
export type StartupReport = {
    readonly errors: ReadonlyArray<string>;
    readonly warnings: ReadonlyArray<string>;
};

export type StartupCheckInput = {
    readonly roles: RoleAssignments;
    readonly maxBudgetUsd?: number | undefined;
    /** Whether AFK triage runs; the triager needs no harness when it does not. */
    readonly triageEnabled?: boolean | undefined;
};

export type HarnessStartupChecker = (
    input: StartupCheckInput,
) => Promise<StartupReport>;

/** The roles each harness is assigned, in the roles' own order. */
const rolesByHarness = (
    roles: RoleAssignments,
    triageEnabled: boolean,
): ReadonlyMap<string, ReadonlyArray<string>> => {
    const grouped = new Map<string, string[]>();
    for (const [role, assignment] of Object.entries(roles)) {
        if (role === "triager" && !triageEnabled) continue;
        grouped.set(assignment.harness, [
            ...(grouped.get(assignment.harness) ?? []),
            role,
        ]);
    }
    return grouped;
};

const safeEditingRoles = (
    roles: RoleAssignments,
    harness: string,
): ReadonlyArray<string> =>
    EDITING_ROLES.filter(
        (role) =>
            roles[role].harness === harness && roles[role].approval === "safe",
    );

const approvalFix = (harness: string, editing: ReadonlyArray<string>): string =>
    `set harnesses.${harness}.approval: yolo (or approval: yolo), or move ` +
    `${editing.join(" and ")} to another harness with roles.${editing[0]}`;

const installationErrors = async (
    probe: HarnessProbe,
    harnesses: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<{
    readonly errors: ReadonlyArray<string>;
    readonly warnings: ReadonlyArray<string>;
    readonly installed: ReadonlyArray<string>;
}> => {
    const results = await Promise.all(
        [...harnesses].map(async ([harness, roles]) => ({
            harness,
            roles,
            result: await probe.installed(harness),
        })),
    );
    const errors = results.flatMap(({ harness, roles, result }) =>
        result.ok
            ? []
            : [
                  `Harness ${harness} is not usable (${result.message}). ` +
                      `Install it, or assign its roles (${roles.join(", ")}) ` +
                      `to another harness with roles.default or roles.<role>.`,
              ],
    );
    return {
        errors,
        warnings: results.flatMap(({ result }) =>
            result.ok && result.warning !== undefined ? [result.warning] : [],
        ),
        installed: results.flatMap(({ harness, result }) =>
            result.ok ? [harness] : [],
        ),
    };
};

const approvalErrors = async (
    probe: HarnessProbe,
    roles: RoleAssignments,
    installed: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
    const errors: string[] = [];
    for (const harness of installed) {
        const editing = safeEditingRoles(roles, harness);
        if (editing.length === 0) continue;
        if (HARNESSES_WITHOUT_SAFE_MODE.includes(harness)) {
            errors.push(
                `${editing.join(" and ")} would edit with ${harness}, which ` +
                    `has no sandbox or approval system, so it needs yolo: ` +
                    `${approvalFix(harness, editing)}.`,
            );
            continue;
        }
        const result = await probe.safeAccess(harness);
        if (!result.ok) {
            errors.push(
                `Safe approval is not available on ${harness} for ` +
                    `${editing.join(" and ")} (${result.message}): ` +
                    `${approvalFix(harness, editing)}.`,
            );
        }
    }
    return errors;
};

const budgetWarnings = (
    probe: HarnessProbe,
    harnesses: ReadonlyMap<string, ReadonlyArray<string>>,
    maxBudgetUsd: number | undefined,
): ReadonlyArray<string> =>
    maxBudgetUsd === undefined
        ? []
        : [...harnesses.keys()]
              .filter((harness) => !probe.capabilities(harness)?.budgetCap)
              .map(
                  (harness) =>
                      `limits.maxBudgetUsd (${maxBudgetUsd}) is not enforced ` +
                      `by ${harness}; its sessions run without a spend cap.`,
              );

/**
 * Check, before any work starts, that every assigned harness is installed,
 * (and at the minimum supported version), that `safe` approval is available where configured, and that editing roles
 * never run on a harness without a sandbox unless they are set to `yolo`.
 * Every message names the configuration change that fixes it.
 */
export const makeHarnessStartupChecker =
    (probe: HarnessProbe): HarnessStartupChecker =>
    async ({ roles, maxBudgetUsd, triageEnabled = true }) => {
        const harnesses = rolesByHarness(roles, triageEnabled);
        const installation = await installationErrors(probe, harnesses);
        return {
            errors: [
                ...installation.errors,
                ...(await approvalErrors(probe, roles, installation.installed)),
            ],
            warnings: [
                ...installation.warnings,
                ...budgetWarnings(probe, harnesses, maxBudgetUsd),
            ],
        };
    };