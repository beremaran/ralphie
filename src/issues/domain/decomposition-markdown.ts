import { type GitHubIssue } from "../../github/domain.ts";
import type { IssueBreakdownDecision } from "./decisions.ts";
import { RalphieError } from "../../shared/error.ts";

export const DEFAULT_MAX_DECOMPOSITION_DEPTH = 3;
export const RALPHIE_DECOMPOSITION_MARKER = "ralphie:decomposition";

export type DecompositionLineage = {
    readonly rootIssueNumber: number;
    readonly parentIssueNumber: number;
    readonly depth: number;
};

export class DecompositionDepthLimitError extends RalphieError {
    constructor(
        readonly depth: number,
        readonly maximumDepth: number,
    ) {
        super({
            message: `Decomposition depth ${depth} exceeds the configured maximum of ${maximumDepth}.`,
        });
        this.name = "DecompositionDepthLimitError";
    }
}

const validateDepth = (depth: number, maximumDepth?: number): void => {
    if (!Number.isInteger(depth) || depth < 1) {
        throw new RalphieError({
            message: `Decomposition depth ${depth} must be a positive integer.`,
        });
    }
    if (
        maximumDepth !== undefined &&
        (!Number.isInteger(maximumDepth) || maximumDepth < 1)
    ) {
        throw new RalphieError({
            message: `Maximum decomposition depth ${maximumDepth} must be a positive integer.`,
        });
    }
    if (maximumDepth !== undefined && depth > maximumDepth) {
        throw new DecompositionDepthLimitError(depth, maximumDepth);
    }
};

const issueLink = (number: number): string => `#${number}`;

export const decompositionMarker = (
    lineage: DecompositionLineage,
    key: string,
): string => {
    validateDepth(lineage.depth);
    return `<!-- ${RALPHIE_DECOMPOSITION_MARKER} root=${lineage.rootIssueNumber} parent=${lineage.parentIssueNumber} key=${JSON.stringify(key)} depth=${lineage.depth} -->`;
};

const MARKER_PATTERN =
    /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/;

export type ParsedDecompositionMarker = {
    readonly rootIssueNumber: number;
    readonly parentIssueNumber: number;
    readonly key: string;
    readonly depth: number;
};

/** Parse the stable Ralphie decomposition marker, if any. */
export const parseDecompositionMarker = (
    body: string | null,
): ParsedDecompositionMarker | undefined => {
    if (body === null) return undefined;
    const marker = body.match(MARKER_PATTERN);
    if (marker === null) return undefined;
    let key: string;
    try {
        const parsed = JSON.parse(marker[3]!);
        if (typeof parsed !== "string" || parsed.length === 0) return undefined;
        key = parsed;
    } catch {
        return undefined;
    }
    return {
        rootIssueNumber: Number(marker[1]),
        parentIssueNumber: Number(marker[2]),
        key,
        depth: Number(marker[4]),
    };
};

/**
 * True when an issue is a decomposed parent that GitHub tracks via sub-issues.
 * The parent body is never modified, so the native sub-issue count is the
 * signal; the legacy rewritten-body marker still counts for older runs.
 */
export const isDecomposedParent = (issue: GitHubIssue): boolean =>
    (issue.subIssueCount ?? 0) > 0 ||
    issue.body?.includes(`<!-- ${RALPHIE_DECOMPOSITION_MARKER} original=`) ===
        true;

/** Derive lineage for the children of an issue, including recursively generated children. */
export const nextDecompositionLineage = (
    issue: GitHubIssue,
    maximumDepth = DEFAULT_MAX_DECOMPOSITION_DEPTH,
): DecompositionLineage => {
    const marker = parseDecompositionMarker(issue.body);
    const depth = marker === undefined ? 1 : marker.depth + 1;
    validateDepth(depth, maximumDepth);
    return {
        rootIssueNumber: marker?.rootIssueNumber ?? issue.number,
        parentIssueNumber: issue.number,
        depth,
    };
};

/** Read GitHub issue-number blockers from a generated child body. */
export const parseGeneratedIssueDependencies = (
    issue: GitHubIssue,
): ReadonlyArray<number> => {
    if (!issue.body?.includes(`<!-- ${RALPHIE_DECOMPOSITION_MARKER} `))
        return [];
    const section = issue.body
        .split(/^## (?:Blocked by|Dependencies)[ \t]*\n\n/m)[1]
        ?.split("\n\n## ")[0];
    if (section === undefined) return [];
    return [...section.matchAll(/^- #(\d+)(?:\s|$)/gm)].map((match) =>
        Number(match[1]),
    );
};

type BreakdownChild = IssueBreakdownDecision["issues"][number];

/**
 * Order children so every blocker precedes the children it blocks. The
 * decomposer's own order is kept wherever the graph allows it.
 */
export const orderChildrenByDependencies = (
    children: ReadonlyArray<BreakdownChild>,
): ReadonlyArray<BreakdownChild> => {
    const ordered: BreakdownChild[] = [];
    const placed = new Set<string>();
    while (ordered.length < children.length) {
        const next = children.find(
            (child) =>
                !placed.has(child.key) &&
                child.dependsOn.every((key) => placed.has(key)),
        );
        if (next === undefined) {
            throw new RalphieError({
                message: "The breakdown dependency graph contains a cycle.",
            });
        }
        ordered.push(next);
        placed.add(next.key);
    }
    return ordered;
};

/**
 * Render a child in the to-tickets issue template (Parent, What to build,
 * Acceptance criteria, Blocked by) behind the stable recovery marker. Every
 * blocker must already have an issue number.
 */
export const renderChildIssueBody = (input: {
    readonly child: BreakdownChild;
    readonly lineage: DecompositionLineage;
    readonly issueNumbers: Readonly<Record<string, number>>;
}): string => {
    const { child, lineage, issueNumbers } = input;
    const blockers = child.dependsOn.map((key) => {
        const number = issueNumbers[key];
        if (number === undefined) {
            throw new RalphieError({
                message: `Cannot render blocker ${key}; its GitHub issue number is unknown.`,
            });
        }
        return `- ${issueLink(number)}`;
    });
    return `${decompositionMarker(lineage, child.key)}

## Parent

${issueLink(lineage.parentIssueNumber)}

## What to build

${child.whatToBuild}

## Acceptance criteria

${child.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}

## Blocked by

${blockers.length === 0 ? "None (can start immediately)" : blockers.join("\n")}`;
};