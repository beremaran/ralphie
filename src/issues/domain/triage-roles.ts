/** Matt Pocock's five canonical triage roles, in his documented order. */
export const TRIAGE_ROLES = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
] as const;

export type TriageRole = (typeof TRIAGE_ROLES)[number];

/** The label a repository uses for each triage role. */
export type TriageLabels = Readonly<Record<TriageRole, string>>;