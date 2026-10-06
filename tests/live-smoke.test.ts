import { describe, expect, test } from "bun:test";

import { HAND_OFF_MARKER } from "../src/github/adapters/hand-off.ts";
import { RalphieExitCode } from "../src/workflow/exit-code.ts";
import {
    allIssuesListed,
    HALTED_EXIT_CODE,
    type ImplementationEvidence,
    judgeHandOff,
    judgeImplementation,
    smokeExitCode,
    smokeScenarios,
    greetingFile,
    greetingText,
    parseRunLog,
    judgeDecomposition,
    smokeVerdict,
    type SmokeChild,
    parseSmokeOptions,
    requireScratchRepository,
    SCRATCH_ENV,
    smokeConfig,
} from "../scripts/live-smoke.ts";

describe("live smoke guard", () => {
    test("requires the repository to be named in flag and environment", () => {
        expect(() => requireScratchRepository(undefined, {})).toThrow(
            "required",
        );
        expect(() => requireScratchRepository("a/b", {})).toThrow("Refusing");
        expect(() =>
            requireScratchRepository("a/b", { [SCRATCH_ENV]: "a/c" }),
        ).toThrow("Refusing");
        expect(requireScratchRepository("a/b", { [SCRATCH_ENV]: "a/b" })).toBe(
            "a/b",
        );
    });

    test("refuses the project repository even when named", () => {
        expect(() =>
            requireScratchRepository("beremaran/ralphie", {
                [SCRATCH_ENV]: "beremaran/ralphie",
            }),
        ).toThrow("not a scratch");
    });

    test("parses harness selection and rejects unknown names", () => {
        const environment = { [SCRATCH_ENV]: "a/b" };
        expect(
            parseSmokeOptions(
                ["--scratch-repo", "a/b", "--harness", "claude,pi"],
                environment,
            ).harnesses,
        ).toEqual(["claude", "pi"]);
        expect(() =>
            parseSmokeOptions(
                ["--scratch-repo", "a/b", "--harness", "x"],
                environment,
            ),
        ).toThrow("Unknown");
    });

    test("config assigns the harness to every role and filters intake", () => {
        const config = smokeConfig("codex", "/tmp/w");
        expect(config).toContain("default: codex");
        expect(config).toContain("requireLabels: [smoke-codex]");
    });
});

describe("live smoke evidence", () => {
    const done: ImplementationEvidence = {
        state: "CLOSED",
        stateReason: "COMPLETED",
        closedByRalphie: true,
        newCommits: 1,
        changedFiles: ["greeting-abc.txt"],
        file: "greeting-abc.txt",
        expected: "hello abc",
        greeting: "hello abc\n",
        reviewed: true,
    };

    test("passes only with a closure and a commit that adds the greeting", () => {
        expect(judgeImplementation(done)).toEqual([]);
    });

    test("a closed issue with no commit and no closure event is not enough", () => {
        const problems = judgeImplementation({
            ...done,
            closedByRalphie: false,
            newCommits: 0,
            changedFiles: [],
            greeting: undefined,
            reviewed: false,
        }).join(";");
        expect(problems).toContain("no review stage");
        expect(problems).toContain("no closure by Ralphie");
        expect(problems).toContain("nothing was implemented");
        expect(problems).toContain("greeting-abc.txt");
    });

    test("requires the commit to touch the greeting file", () => {
        expect(
            judgeImplementation({ ...done, changedFiles: ["other.txt"] }),
        ).toEqual(["no new commit touched greeting-abc.txt"]);
    });

    test("an open issue is reported as not closed", () => {
        expect(judgeImplementation({ ...done, state: "OPEN" })).toEqual([
            "implementation issue was not closed",
        ]);
    });

    test("waits until every created issue is listed", () => {
        expect(allIssuesListed([1, 2, 3], [1, 3])).toBe(false);
        expect(allIssuesListed([1, 2, 3], [3, 2, 1, 9])).toBe(true);
    });

    test("reads closures and the final summary from the JSON Lines log", () => {
        const log = parseRunLog(
            [
                "not json",
                JSON.stringify({
                    stage: "issue-closure",
                    status: "succeeded",
                    message: "Issue #7 closed as completed.",
                    issue: { number: 7 },
                }),
                JSON.stringify({
                    stage: "issue-closure",
                    status: "failed",
                    message: "Issue #8 close failed",
                    issue: { number: 8 },
                }),
                JSON.stringify({
                    stage: "run",
                    status: "succeeded",
                    message: "Run completed: 1 completed",
                }),
            ].join("\n"),
        );
        expect([...log.closedAsCompleted]).toEqual([7]);
        expect(log.summary).toBe("Run completed: 1 completed");
        expect(parseRunLog("").summary).toBeUndefined();
    });
});

describe("live smoke verdicts", () => {
    const child = (overrides: Partial<SmokeChild>): SmokeChild => ({
        number: 10,
        state: "OPEN",
        stateReason: null,
        labels: ["ready-for-agent"],
        comments: [],
        ...overrides,
    });

    test("uses the exit code Ralphie reports for a halt", () => {
        expect(HALTED_EXIT_CODE).toBe(RalphieExitCode.Halted);
    });

    test("uses the marker Ralphie puts on hand-off comments", () => {
        const handedOff = child({
            labels: ["ready-for-human"],
            comments: [`<!-- ${HAND_OFF_MARKER} -->\nNeeds a decision.`],
        });
        expect(judgeDecomposition([handedOff])).toBeUndefined();
    });

    test("no children is not a pass", () => {
        expect(judgeDecomposition([])).toContain("no child issues");
    });

    test("children that were never worked are not a pass", () => {
        expect(
            judgeDecomposition([child({}), child({ number: 11 })]),
        ).toContain("no child issue was worked");
    });

    test("a child Ralphie closed as completed passes", () => {
        expect(
            judgeDecomposition([
                child({ state: "CLOSED", stateReason: "COMPLETED" }),
            ]),
        ).toBeUndefined();
    });

    test("a child closed as not planned (the script cleanup) does not pass", () => {
        expect(
            judgeDecomposition([
                child({ state: "CLOSED", stateReason: "NOT_PLANNED" }),
            ]),
        ).toBeDefined();
    });

    test("a hand-off blamed on a failed session does not pass", () => {
        expect(
            judgeDecomposition([
                child({
                    labels: ["ready-for-human"],
                    comments: [
                        `<!-- ${HAND_OFF_MARKER} -->\nAn agent session failed while Ralphie was working: You've hit your session limit`,
                    ],
                }),
            ]),
        ).toBeDefined();
    });

    test("a halt is inconclusive, never a pass or a fail", () => {
        expect(smokeVerdict(HALTED_EXIT_CODE, ["ralphie exited 75"])).toBe(
            "INCONCLUSIVE",
        );
        expect(smokeVerdict(0, [])).toBe("PASS");
        expect(smokeVerdict(0, ["x"])).toBe("FAIL");
        expect(smokeVerdict(1, ["ralphie exited 1"])).toBe("FAIL");
    });
});
describe("live smoke run uniqueness, hand-off and exit", () => {
    test("each run asks for its own file and content", () => {
        expect(greetingFile("a1")).not.toBe(greetingFile("b2"));
        const [implementation] = smokeScenarios("pi", "a1");
        expect(implementation?.body).toContain(greetingFile("a1"));
        expect(implementation?.body).toContain(greetingText("a1"));
        expect(implementation?.title).toContain("a1");
    });

    test("reads review stage events per issue", () => {
        const log = parseRunLog(
            JSON.stringify({
                stage: "review",
                status: "started",
                message: "Reviewing",
                issue: { number: 4 },
            }),
        );
        expect([...log.reviewed]).toEqual([4]);
    });

    test("an untouched open issue is not a hand-off", () => {
        const problems = judgeHandOff({
            state: "OPEN",
            labels: ["ready-for-agent"],
            comments: [],
        }).join(";");
        expect(problems).toContain("none of the labels");
        expect(problems).toContain("no Ralphie hand-off comment");
    });

    test("a labelled issue with Ralphie's comment is a hand-off", () => {
        expect(
            judgeHandOff({
                state: "OPEN",
                labels: ["ready-for-human"],
                comments: [`<!-- ${HAND_OFF_MARKER} -->\nWhat format?`],
            }),
        ).toEqual([]);
    });

    test("a closed or missing hand-off issue fails", () => {
        expect(judgeHandOff(undefined)).toHaveLength(1);
        expect(
            judgeHandOff({
                state: "CLOSED",
                labels: ["needs-info"],
                comments: [`<!-- ${HAND_OFF_MARKER} -->`],
            }),
        ).toEqual(["hand-off issue should stay open for a human"]);
    });

    test("fails when no harness ran", () => {
        expect(smokeExitCode(0, 0)).toBe(1);
        expect(smokeExitCode(0, 2)).toBe(0);
        expect(smokeExitCode(1, 2)).toBe(1);
    });
});