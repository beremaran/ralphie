import { describe, expect, test } from "bun:test";

import { provideRepositoryFacts } from "../../src/agent/repository-facts.ts";
import {
    buildDecompositionPrompt,
    buildHandOffVerificationPrompt,
    buildPreflightPrompt,
    buildResolutionVerificationPrompt,
    buildTriagePrompt,
} from "../../src/agent/prompts.ts";
import { makeGitRepositoryFactsService } from "../../src/git/adapters/repository-facts.ts";
import type {
    HarnessService,
    SessionRequest,
} from "../../src/harness/ports.ts";
import { makeGitFixture } from "../shared/git-fixture.ts";

const request = (overrides: Partial<SessionRequest>): SessionRequest => ({
    role: "resolution-verifier",
    harness: "pi",
    prompt: "PROMPT",
    directory: "/work/repo",
    access: "read-only",
    timeoutMs: 1000,
    ...overrides,
});

const recordingHarness = (): {
    readonly harness: HarnessService;
    readonly prompts: string[];
} => {
    const prompts: string[] = [];
    const run = async (r: SessionRequest) => {
        prompts.push(r.prompt);
        return { ok: true as const, harnessSessionID: "s", text: "" };
    };
    return { harness: { run } as unknown as HarnessService, prompts };
};

describe("provideRepositoryFacts", () => {
    test("appends the facts to new read-only sessions only", async () => {
        const { harness, prompts } = recordingHarness();
        const wrapped = provideRepositoryFacts(
            harness,
            async () => "FACTS-HERE",
        );
        await wrapped.run(request({}));
        await wrapped.run(request({ access: "yolo", role: "implementer" }));
        await wrapped.run(request({ resumeSessionID: "earlier" }));
        expect(prompts[0]).toContain("<repository-facts>");
        expect(prompts[0]).toContain("FACTS-HERE");
        expect(prompts[0]).toContain("You have no shell");
        expect(prompts[1]).toBe("PROMPT");
        expect(prompts[2]).toBe("PROMPT");
    });
});

describe("git repository facts adapter", () => {
    test("reports HEAD, status, log and tracked files", async () => {
        const fixture = await makeGitFixture();
        try {
            const facts = await makeGitRepositoryFactsService(
                (await import("../../src/process/adapters/command-runner.ts"))
                    .CommandRunnerLive,
            ).read(fixture.repositoryPath);
            expect(facts).toContain(`HEAD: ${fixture.headSha}`);
            expect(facts).toContain("head commit");
            expect(facts).toContain("base.txt");
            expect(facts).toContain("uncommitted.txt");
        } finally {
            await fixture.cleanup();
        }
    });
});

describe("read-only prompts state that there is no shell", () => {
    const base = {
        issue: {
            number: 7,
            title: "T",
            url: "https://github.com/o/r/issues/7",
            body: "B",
            labels: [],
        },
        repositoryPath: "/work/repo",
        targetBranch: "main",
    };
    const prompts: ReadonlyArray<readonly [string, string]> = [
        ["preflight", buildPreflightPrompt(base)],
        ["hand-off verifier", buildHandOffVerificationPrompt(base)],
        ["resolution verifier", buildResolutionVerificationPrompt(base)],
        [
            "decomposer",
            buildDecompositionPrompt({
                ...base,
                toTicketsInvocation: "/to-tickets",
            }),
        ],
        [
            "triager",
            buildTriagePrompt({
                ...base,
                triageInvocation: "/triage",
                bucket: "unlabelled",
                labels: {
                    "needs-triage": "needs-triage",
                    "needs-info": "needs-info",
                    "ready-for-agent": "ready-for-agent",
                    "ready-for-human": "ready-for-human",
                    wontfix: "wontfix",
                },
            }),
        ],
    ];
    for (const [name, prompt] of prompts) {
        test(name, () => {
            expect(prompt).toContain("NO SHELL");
            expect(prompt).toContain("<repository-facts>");
            expect(prompt).not.toContain("git ls-files when");
        });
    }
});