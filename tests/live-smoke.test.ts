import { describe, expect, test } from "bun:test";

import { HAND_OFF_MARKER } from "../src/github/adapters/hand-off.ts";
import { RalphieExitCode } from "../src/workflow/exit-code.ts";
import {
    HALTED_EXIT_CODE,
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