import type { GitHubIssue } from "./issues.ts";
import type { IssueBreakdownDecision } from "../issues/decisions.ts";
import { RalphieError } from "../shared/error.ts";

export const MAX_DECOMPOSITION_DEPTH = 3;
export const RALPHIE_DECOMPOSITION_MARKER = "ralphie:decomposition";

export type DecompositionLineage = {
    readonly rootIssueNumber: number;
    readonly parentIssueNumber: number;
    readonly depth: number;
};

const validateDepth = (depth: number): void => {
    if (
        !Number.isInteger(depth) ||
        depth < 1 ||
        depth > MAX_DECOMPOSITION_DEPTH
    ) {
        throw new RalphieError({
            message: `Decomposition depth ${depth} is outside the supported range 1–${MAX_DECOMPOSITION_DEPTH}.`,
        });
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

/** True when an issue is a decomposed parent that GitHub tracks via sub-issues. */
export const isDecomposedParent = (issue: GitHubIssue): boolean =>
    issue.body?.includes(`<!-- ${RALPHIE_DECOMPOSITION_MARKER} original=`) ===
    true;

/** Derive lineage for the children of an issue, including recursively generated children. */
export const nextDecompositionLineage = (
    issue: GitHubIssue,
): DecompositionLineage => {
    const marker = parseDecompositionMarker(issue.body);
    const depth = marker === undefined ? 1 : marker.depth + 1;
    validateDepth(depth);
    return {
        rootIssueNumber: marker?.rootIssueNumber ?? issue.number,
        parentIssueNumber: issue.number,
        depth,
    };
};

/** Read GitHub issue-number dependencies from a generated child body. */
export const parseGeneratedIssueDependencies = (
    issue: GitHubIssue,
): ReadonlyArray<number> => {
    if (!issue.body?.includes(`<!-- ${RALPHIE_DECOMPOSITION_MARKER} `))
        return [];
    const dependencySection = issue.body
        .split("## Dependencies\n\n")[1]
        ?.split("\n\n## ")[0];
    if (dependencySection === undefined) return [];
    return [...dependencySection.matchAll(/^- #(\d+)(?:\s|$)/gm)].map((match) =>
        Number(match[1]),
    );
};

export const renderChildIssueBody = (input: {
    readonly child: IssueBreakdownDecision["issues"][number];
    readonly lineage: DecompositionLineage;
    readonly issueNumbers: Readonly<Record<string, number>>;
}): string => {
    const { child, lineage, issueNumbers } = input;
    const dependencies = child.dependsOn.map((key) => {
        const number = issueNumbers[key];
        if (number === undefined) {
            throw new RalphieError({
                message: `Cannot render dependency ${key}; its GitHub issue number is unknown.`,
            });
        }
        return `- ${issueLink(number)} (${key})`;
    });

    // Native sub-issues replace the body-level parent/sibling/lineage lists.
    // The stable marker remains as private recovery metadata and the
    // dependency section remains the queue's deterministic source of edges.
    return `${decompositionMarker(lineage, child.key)}

${child.body}

## Dependencies

${dependencies.length === 0 ? "- None" : dependencies.join("\n")}`;
};

export const renderDecomposedOriginalBody = (input: {
    readonly original: GitHubIssue;
    readonly breakdown: IssueBreakdownDecision;
    readonly issueNumbers: Readonly<Record<string, number>>;
    readonly lineage: DecompositionLineage;
}): string => {
    validateDepth(input.lineage.depth);
    const originalSection = "## Original issue content\n\n";
    const originalBody = input.original.body ?? "";
    const preservedOriginal = originalBody.includes(
        `<!-- ${RALPHIE_DECOMPOSITION_MARKER} original=`,
    )
        ? (originalBody.split(originalSection)[1] ?? "")
        : originalBody;
    const stack = input.breakdown.issues.map((child) => {
        const number = input.issueNumbers[child.key];
        if (number === undefined) {
            throw new RalphieError({
                message: `Cannot rewrite the original issue; child ${child.key} has no GitHub issue number.`,
            });
        }
        const dependencies = child.dependsOn
            .map((key) => input.issueNumbers[key])
            .filter((value): value is number => value !== undefined)
            .map(issueLink);
        return `- ${issueLink(number)} — ${child.title}${
            dependencies.length === 0
                ? ""
                : ` (depends on ${dependencies.join(", ")})`
        }`;
    });

    return `<!-- ${RALPHIE_DECOMPOSITION_MARKER} original=${input.original.number} depth=${input.lineage.depth} -->

This issue was decomposed into the following independently actionable issue stack:

${stack.join("\n")}

## Decomposition rationale

${input.breakdown.rationale}

## Original issue content

${preservedOriginal}`;
};