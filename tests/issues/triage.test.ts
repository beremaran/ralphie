import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../../src/github/domain.ts";
import type { GitRepositoryInvariantService } from "../../src/git/ports.ts";
import { makeTriageService } from "../../src/issues/app/triage.ts";
import type { ResolutionVerificationService } from "../../src/issues/app/resolution-verification.ts";
import type { IssueExecutionContext } from "../../src/issues/app/execution-model.ts";
import {
    HandOffReason,
    IssueResolutionStatus,
} from "../../src/issues/domain/decisions.ts";
import { withDisclaimer } from "../../src/issues/domain/hand-off.ts";
import {
    isAgentBrief,
    triageBucket,
    triageDecisionSchema,
    type TriageStateLabels,
} from "../../src/issues/domain/triage.ts";
import { defaultRoles } from "../shared/agent-sessions.ts";
import { makeFakeHarness } from "../shared/fake-harness.ts";
import { makeTestProgressRecorder } from "../shared/progress-recorder.ts";
import { testLayout } from "../shared/test-values.ts";

const labels: TriageStateLabels = {
    "needs-triage": "needs-triage",
    "needs-info": "needs-info",
    "ready-for-agent": "ready-for-agent",
    "ready-for-human": "ready-for-human",
    wontfix: "wontfix",
};

const issue = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
    number: 7,
    title: "Add a thing",
    url: "https://github.com/owner/repo/issues/7",
    author: "reporter",
    body: "Please add a thing.",
    labels: [],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    ...overrides,
});

const comment = (id: number, author: string, body: string) => ({
    id,
    author,
    body,
    updatedAt: "2026-08-28T00:00:00.000Z",
});

describe("triage buckets", () => {
    test("an issue without a state label was never triaged", () => {
        expect(triageBucket(issue({ labels: ["bug"] }), labels)).toBe(
            "unlabelled",
        );
    });

    test("needs-triage issues are triage work", () => {
        expect(triageBucket(issue({ labels: ["Needs-Triage"] }), labels)).toBe(
            "needs-triage",
        );
    });

    test("needs-info waits for a reply after the last triage notes", () => {
        const notes = comment(1, "ralphie", withDisclaimer("## Triage Notes"));
        const waiting = issue({
            labels: ["needs-info"],
            comments: [notes],
        });
        const replied = issue({
            labels: ["needs-info"],
            comments: [notes, comment(2, "reporter", "Here is more.")],
        });
        const answeredThenAskedAgain = issue({
            labels: ["needs-info"],
            comments: [
                comment(2, "reporter", "Old answer."),
                notes,
                comment(3, "someone-else", "A drive-by comment."),
            ],
        });

        expect(triageBucket(waiting, labels)).toBeUndefined();
        expect(triageBucket(replied, labels)).toBe("needs-info-reply");
        expect(triageBucket(answeredThenAskedAgain, labels)).toBeUndefined();
    });

    test("states that need no triage are left alone", () => {
        for (const label of ["ready-for-agent", "ready-for-human", "wontfix"]) {
            expect(triageBucket(issue({ labels: [label] }), labels)).toBe(
                undefined,
            );
        }
        expect(
            triageBucket(
                issue({ labels: ["needs-triage", "ready-for-human"] }),
                labels,
            ),
        ).toBeUndefined();
        expect(
            triageBucket(issue({ state: "closed" }), labels),
        ).toBeUndefined();
    });

    test("an Agent Brief is recognised with the disclaimer first", () => {
        expect(isAgentBrief("## Agent Brief\n\nDo it.")).toBe(true);
        expect(isAgentBrief(withDisclaimer("## Agent Brief\n\nDo it."))).toBe(
            true,
        );
        expect(isAgentBrief(withDisclaimer("## Triage Notes"))).toBe(false);
    });
});

describe("triage decisions", () => {
    test("have no way to reject a request", () => {
        expect(
            triageDecisionSchema.safeParse({
                outcome: "wontfix",
                summary: "No.",
            }).success,
        ).toBe(false);
    });

    test("a promotion needs an Agent Brief", () => {
        expect(
            triageDecisionSchema.safeParse({
                outcome: "promote",
                brief: "Just do it.",
            }).success,
        ).toBe(false);
        expect(
            triageDecisionSchema.safeParse({
                outcome: "promote",
                brief: "## Agent Brief\n\nDo it.",
            }).success,
        ).toBe(true);
    });
});

const invariant: GitRepositoryInvariantService = {
    capture: async () => ({ branch: "develop", head: "abc" }),
    verify: async () => {},
};

const contextFor = (
    harness: ReturnType<typeof makeFakeHarness>,
    target: GitHubIssue = issue(),
): IssueExecutionContext => ({
    issue: target,
    repository: "owner/repo",
    repositoryPath: "/work/repository",
    targetBranch: "develop",
    workspace: "/work/workspace",
    runId: "test-run",
    runLayout: testLayout("/work/workspace", "test-run"),
    agent: { harness: harness.service, roles: defaultRoles() },
    repositoryInvariant: invariant,
});

const verifier = (
    status: IssueResolutionStatus,
    calls: number[] = [],
): ResolutionVerificationService => ({
    verify: async (context) => {
        calls.push(context.issue.number);
        return {
            decision: {
                status,
                summary: "Verified.",
                evidence: ["src/thing.ts implements it."],
            },
            sessionID: "verification",
        };
    },
});

const triageWith = (
    value: unknown,
    verification = verifier(IssueResolutionStatus.Resolved),
) => {
    const harness = makeFakeHarness({
        roles: { triager: { value: { result: value } } },
    });
    const service = makeTriageService({
        progress: makeTestProgressRecorder([]),
        resolutionVerification: verification,
    });
    return {
        harness,
        run: () =>
            service.triage({
                context: contextFor(harness),
                bucket: "unlabelled",
                labels,
            }),
    };
};

describe("triage service", () => {
    test("runs the vendored triage skill in a read-only triager session", async () => {
        const { harness, run } = triageWith({
            outcome: "promote",
            brief: "## Agent Brief\n\nDo it.",
        });

        await run();

        const [request] = harness.requestsFor("triager");
        expect(request?.access).toBe("read-only");
        expect(request?.prompt).toContain("/triage");
    });

    test("promotes with the brief", async () => {
        const { run } = triageWith({
            outcome: "promote",
            brief: "  ## Agent Brief\n\nDo it.\n",
        });

        expect(await run()).toEqual({
            kind: "promote",
            brief: "## Agent Brief\n\nDo it.",
        });
    });

    test("hands a reporter question to needs-info and a human decision to ready-for-human", async () => {
        const needsInfo = await triageWith({
            outcome: "needs_info",
            reason: "missing_information",
            summary: "Seen on one machine.",
            evidence: ["src/a.ts"],
            questions: ["Which version?"],
        }).run();
        const human = await triageWith({
            outcome: "ready_for_human",
            summary: "A design call.",
            evidence: [],
            questions: ["Pick a storage engine."],
        }).run();

        expect(needsInfo).toMatchObject({
            kind: "hand-off",
            reason: HandOffReason.MissingInformation,
        });
        expect(human).toMatchObject({
            kind: "hand-off",
            reason: HandOffReason.NeedsHumanJudgment,
        });
    });

    test("closes as implemented only after a fresh verification resolves it", async () => {
        const verified: number[] = [];
        const claim = {
            outcome: "already_implemented",
            summary: "It lives in src/thing.ts.",
            evidence: ["src/thing.ts"],
        };

        const proven = await triageWith(
            claim,
            verifier(IssueResolutionStatus.Resolved, verified),
        ).run();
        const disputed = await triageWith(
            claim,
            verifier(IssueResolutionStatus.Unresolved, verified),
        ).run();

        expect(verified).toEqual([7, 7]);
        expect(proven.kind).toBe("already-implemented");
        expect(disputed).toMatchObject({
            kind: "hand-off",
            reason: HandOffReason.NeedsHumanJudgment,
        });
    });

    test("a failing verification hands off instead of closing", async () => {
        const result = await triageWith(
            {
                outcome: "already_implemented",
                summary: "It lives in src/thing.ts.",
                evidence: ["src/thing.ts"],
            },
            {
                verify: async () => {
                    throw new Error("verifier crashed");
                },
            },
        ).run();

        expect(result.kind).toBe("hand-off");
    });

    test("a failed session is reported to the caller", async () => {
        const harness = makeFakeHarness({
            roles: {
                triager: {
                    failure: { kind: "harness", message: "model is down" },
                },
            },
        });
        const service = makeTriageService({
            progress: makeTestProgressRecorder([]),
            resolutionVerification: verifier(IssueResolutionStatus.Resolved),
        });

        await expect(
            service.triage({
                context: contextFor(harness),
                bucket: "needs-triage",
                labels,
            }),
        ).rejects.toThrow();
    });
});