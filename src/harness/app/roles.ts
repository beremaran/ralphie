import { HARNESS_ROLES, type HarnessName, type HarnessRole } from "../ports.ts";

/** How editing roles are approved; read-only roles never need it. */
export type SessionApproval = "safe" | "yolo";

/** The harness, model and effort one role runs with. */
export type RoleAssignment = {
    readonly harness: string;
    /** Whether editing sessions run under the harness's approval system. */
    readonly approval: SessionApproval;
    readonly model?: string;
    readonly effort?: string;
};

export type RoleAssignments = Readonly<Record<HarnessRole, RoleAssignment>>;

type RoleSetting =
    | string
    | {
          readonly harness: string;
          readonly model?: string | undefined;
          readonly effort?: string | undefined;
      };

type HarnessDefaults = {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly approval?: SessionApproval | undefined;
};

/** The configured `harnesses` and `roles` keys, as the resolver reads them. */
export type RoleConfiguration = {
    readonly approval?: SessionApproval | undefined;
    readonly harnesses: Readonly<Record<string, HarnessDefaults | undefined>>;
    readonly roles: Readonly<Record<string, RoleSetting | undefined>>;
};

/** The harness a configuration without `roles.default` runs everything on. */
export const DEFAULT_HARNESS: HarnessName = "claude";

const REVIEWER_ROLES: ReadonlyArray<HarnessRole> = [
    "standards-reviewer",
    "spec-reviewer",
];

const assign = (
    configuration: RoleConfiguration,
    setting: RoleSetting,
): RoleAssignment => {
    const harness = typeof setting === "string" ? setting : setting.harness;
    const defaults = configuration.harnesses[harness];
    const own = typeof setting === "string" ? undefined : setting;
    const model = own?.model ?? defaults?.model;
    const effort = own?.effort ?? defaults?.effort;
    return {
        harness,
        approval: defaults?.approval ?? configuration.approval ?? "safe",
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
    };
};

/**
 * Resolve every role's assignment. A role without its own setting falls back
 * to `default`; both reviewers prefer `reviewer` when it is set; the fixer
 * follows the implementer's resolved assignment.
 */
export const resolveRoleAssignments = (
    configuration: RoleConfiguration,
): RoleAssignments => {
    const { roles } = configuration;
    const fallback = roles.default ?? DEFAULT_HARNESS;
    const settingFor = (role: HarnessRole): RoleSetting | undefined =>
        roles[role] ??
        (REVIEWER_ROLES.includes(role) ? roles.reviewer : undefined);
    const resolved = {} as Record<HarnessRole, RoleAssignment>;
    for (const role of HARNESS_ROLES) {
        if (role === "fixer") continue;
        resolved[role] = assign(configuration, settingFor(role) ?? fallback);
    }
    resolved.fixer =
        roles.fixer === undefined
            ? resolved.implementer
            : assign(configuration, roles.fixer);
    return resolved;
};