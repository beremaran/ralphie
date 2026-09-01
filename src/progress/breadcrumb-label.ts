import { redactSensitiveText } from "../shared/redaction.ts";
import { dim } from "./colors.ts";
import {
    DISPLAY_ACTIVITY_LABELS,
    progressStageLabel,
    type DisplayState,
} from "./display-state.ts";

const ANSI_ESCAPE =
    /\u001b(?:\](?:[^\u0007]*\u0007|[^\u001b]*\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Text that is safe to use as a human breadcrumb label.
 *
 * Breadcrumbs are deliberately a presentation of already-reduced display
 * state. This is the last boundary before a label is rendered or compared,
 * so a secret-bearing variant cannot render differently from its key.
 */
export const sanitizeBreadcrumbLabel = (value: unknown): string => {
    const text = typeof value === "string" ? value : "";
    return redactSensitiveText(
        text
            .replace(ANSI_ESCAPE, "")
            .replace(/\r\n?/g, "\n")
            .replace(
                /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
                "",
            )
            .replace(/\s+/g, " ")
            .trim(),
    );
};

/** Canonical key shared by breadcrumb rendering and adjacent de-duplication. */
export const canonicalBreadcrumbKey = (value: unknown): string =>
    sanitizeBreadcrumbLabel(value);

/** Alias for callers that name the operation by its key boundary. */
export const sanitizeBreadcrumbKey = canonicalBreadcrumbKey;

const nonEmpty = (value: unknown): string | undefined => {
    const clean = sanitizeBreadcrumbLabel(value);
    return clean === "" ? undefined : clean;
};

const appendIssueContext = (parts: string[], state: DisplayState): void => {
    if (state.issue === undefined) return;
    parts.push(`[${state.issue.current}/${state.issue.total}]`);
    parts.push(`#${state.issue.number}`);
    const title = nonEmpty(state.issue.title);
    if (title !== undefined) parts.push(title);
};

const contextPartsFor = (state: DisplayState): string[] => {
    const parts: string[] = [];
    const repository = nonEmpty(state.repository);
    if (repository !== undefined) parts.push(`[${repository}]`);
    appendIssueContext(parts, state);
    if (state.reviewAttempt !== undefined) {
        parts.push(
            `Review ${state.reviewAttempt.current}/${state.reviewAttempt.total}`,
        );
    }
    if (state.stage !== undefined) {
        parts.push(`› ${progressStageLabel(state.stage)}`);
    }
    const activity = nonEmpty(
        state.activityLabel || DISPLAY_ACTIVITY_LABELS[state.activity],
    );
    if (activity !== undefined) parts.push(`› ${activity}`);
    return parts;
};

/**
 * Build a breadcrumb from the sanitized display context and current activity.
 * Codex events, tool arguments, and tool output are intentionally not inputs to
 * this function.
 */
export const breadcrumbLabelFor = (state: DisplayState): string =>
    sanitizeBreadcrumbLabel(contextPartsFor(state).join(" "));

/** Naming aliases for code that emphasizes the display-state boundary. */
export const breadcrumbLabelForDisplayState = breadcrumbLabelFor;
export const displayContextBreadcrumbLabel = breadcrumbLabelFor;

declare const displayContextCandidateBrand: unique symbol;

const approvedCandidates = new WeakSet<object>();

export type SanitizedBreadcrumb = {
    readonly label: string;
    readonly canonicalKey: string;
};

/**
 * A candidate created from reduced display state by breadcrumbCandidateFor.
 * The private brand and runtime provenance set prevent raw strings from being
 * supplied to preparation or rendering as if they were approved labels.
 */
export type BreadcrumbLabelCandidate = SanitizedBreadcrumb & {
    readonly [displayContextCandidateBrand]: true;
};

export type BreadcrumbLabel = SanitizedBreadcrumb;
export type BreadcrumbRenderResult = SanitizedBreadcrumb;
export type ApprovedBreadcrumbCandidate = BreadcrumbLabelCandidate;

const isApprovedBreadcrumbCandidate = (
    value: unknown,
): value is BreadcrumbLabelCandidate => {
    if (typeof value !== "object" || value === null) return false;
    if (!approvedCandidates.has(value)) return false;
    const candidate = value as {
        readonly label?: unknown;
        readonly canonicalKey?: unknown;
    };
    return (
        typeof candidate.label === "string" &&
        typeof candidate.canonicalKey === "string"
    );
};

const requireApprovedBreadcrumbCandidate = (
    candidate: BreadcrumbLabelCandidate,
): void => {
    if (!isApprovedBreadcrumbCandidate(candidate)) {
        throw new TypeError(
            "Breadcrumb candidate must be created from display context.",
        );
    }
};

const candidateFromLabel = (value: string): BreadcrumbLabelCandidate => {
    const label = sanitizeBreadcrumbLabel(value);
    const candidate = Object.freeze({
        label,
        canonicalKey: canonicalBreadcrumbKey(label),
    }) as BreadcrumbLabelCandidate;
    approvedCandidates.add(candidate);
    return candidate;
};

/** Sanitize an approved candidate and derive its key from the sanitized label. */
export const prepareBreadcrumbCandidate = (
    candidate: BreadcrumbLabelCandidate,
): SanitizedBreadcrumb => {
    requireApprovedBreadcrumbCandidate(candidate);
    const label = sanitizeBreadcrumbLabel(candidate.label);
    return { label, canonicalKey: canonicalBreadcrumbKey(label) };
};

/** Return an approved candidate from the current display context. */
export const breadcrumbCandidateFor = (
    state: DisplayState,
): BreadcrumbLabelCandidate => candidateFromLabel(breadcrumbLabelFor(state));

export const breadcrumbCandidateFromDisplayState = breadcrumbCandidateFor;
export const createBreadcrumbCandidate = breadcrumbCandidateFor;
export const makeBreadcrumbCandidate = breadcrumbCandidateFor;
export const createBreadcrumbLabel = prepareBreadcrumbCandidate;
export const makeBreadcrumbLabel = prepareBreadcrumbCandidate;
export const prepareBreadcrumbLabel = prepareBreadcrumbCandidate;

export type BreadcrumbRenderOptions = {
    /** Apply the repository's subdued terminal style when true. */
    readonly colors?: boolean;
    /** Custom subdued style, useful to share a renderer's color policy. */
    readonly style?: (text: string) => string;
};

const styleFor = (
    options: BreadcrumbRenderOptions,
): ((text: string) => string) =>
    options.style ?? (options.colors === true ? dim : (text) => text);

/** Render only the sanitized, subdued label text. */
export const renderBreadcrumbLabel = (
    candidate: BreadcrumbLabelCandidate,
    options: BreadcrumbRenderOptions = {},
): string => {
    const { label } = prepareBreadcrumbCandidate(candidate);
    if (label === "") return "";
    return styleFor(options)(label);
};

/** Render one complete transcript breadcrumb row. */
export const renderBreadcrumbLine = (
    candidate: BreadcrumbLabelCandidate,
    options: BreadcrumbRenderOptions = {},
): string => {
    const label = renderBreadcrumbLabel(candidate, options);
    return label === "" ? "" : `│  ${label}\n`;
};

/** Alias matching the other progress renderers' naming convention. */
export const renderBreadcrumb = renderBreadcrumbLine;
export const renderBreadcrumbCandidate = renderBreadcrumbLine;

/** Return an approved, sanitized label directly from display state. */
export const breadcrumbForDisplayState = (
    state: DisplayState,
): BreadcrumbLabelCandidate => breadcrumbCandidateFor(state);