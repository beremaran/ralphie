import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeSkillFileSystem } from "../../src/harness/adapters/skill-file-system.ts";
import { makeHarnessService } from "../../src/harness/app/harness-service.ts";
import {
    makeSessionPreparation,
    skillInvocation,
    skillLocation,
} from "../../src/harness/app/skill-injection.ts";
import { HARNESS_NAMES } from "../../src/harness/ports.ts";
import { makeScriptedAdapter } from "./scripted-adapter.ts";

const LABELS = {
    "needs-triage": "triage-me",
    "needs-info": "needs-info",
    "ready-for-agent": "agent-ok",
    "ready-for-human": "ready-for-human",
    wontfix: "wontfix",
};

const exists = async (path: string): Promise<boolean> =>
    await stat(path).then(
        () => true,
        () => false,
    );

let root: string;
let skills: string;
let checkout: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ralphie-skills-"));
    skills = join(root, "skills");
    checkout = join(root, "repo");
    await mkdir(join(skills, "tdd"), { recursive: true });
    await writeFile(join(skills, "tdd", "SKILL.md"), "ralphie tdd");
    await mkdir(join(skills, "triage"), { recursive: true });
    await writeFile(join(skills, "triage", "SKILL.md"), "ralphie triage");
    await writeFile(join(skills, "LICENSE"), "not a skill");
    await mkdir(join(checkout, ".git"), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** Run one session and report what the harness could see while it ran. */
const sessionView = async (harness: string) => {
    const location = skillLocation(harness) ?? "";
    const seen: Record<string, string | undefined> = {};
    const scripted = makeScriptedAdapter({
        name: harness,
        nativeSchema: true,
        turns: [{ outcome: { ok: true, harnessSessionID: "s", text: "ok" } }],
    });
    const adapter = {
        ...scripted.adapter,
        runTurn: async (
            turn: Parameters<typeof scripted.adapter.runTurn>[0],
        ) => {
            for (const name of ["tdd", "triage"]) {
                seen[name] = await readFile(
                    join(checkout, location, name, "SKILL.md"),
                    "utf8",
                ).catch(() => undefined);
            }
            seen["tracker"] = await readFile(
                join(checkout, "docs/agents/issue-tracker.md"),
                "utf8",
            ).catch(() => undefined);
            seen["labels"] = await readFile(
                join(checkout, "docs/agents/triage-labels.md"),
                "utf8",
            ).catch(() => undefined);
            return await scripted.adapter.runTurn(turn);
        },
    };
    const service = makeHarnessService({
        adapters: { [harness]: adapter },
        listener: () => {},
        ids: { next: () => "id" },
        preparation: makeSessionPreparation({
            fileSystem: nodeSkillFileSystem,
            skillsDirectory: skills,
            labels: LABELS,
        }),
    });
    const outcome = await service.run({
        role: "implementer",
        harness,
        prompt: "go",
        directory: checkout,
        access: "safe",
        timeoutMs: 1000,
    });
    return { outcome, seen, location };
};

describe("skill injection per harness", () => {
    for (const harness of HARNESS_NAMES) {
        test(`${harness} sees the skills during the session only`, async () => {
            const { outcome, seen, location } = await sessionView(harness);
            expect(outcome.ok).toBe(true);
            expect(seen["tdd"]).toBe("ralphie tdd");
            expect(seen["triage"]).toBe("ralphie triage");
            expect(await exists(join(checkout, location, "tdd"))).toBe(false);
            expect(await exists(join(checkout, location, "LICENSE"))).toBe(
                false,
            );
        });

        test(`${harness} gets excludes for everything injected`, async () => {
            const { location } = await sessionView(harness);
            const exclude = await readFile(
                join(checkout, ".git/info/exclude"),
                "utf8",
            );
            expect(exclude).toContain(`/${location}/`);
            expect(exclude).toContain("/docs/agents/issue-tracker.md");
            expect(exclude).toContain("/docs/agents/triage-labels.md");
        });
    }
});

describe("shadowing", () => {
    test("Ralphie's copy wins and the repository skill comes back", async () => {
        const repoSkill = join(checkout, ".claude/skills/tdd");
        await mkdir(repoSkill, { recursive: true });
        await writeFile(join(repoSkill, "SKILL.md"), "repo tdd");
        const other = join(checkout, ".claude/skills/own");
        await mkdir(other, { recursive: true });
        await writeFile(join(other, "SKILL.md"), "repo own");

        const { seen } = await sessionView("claude");

        expect(seen["tdd"]).toBe("ralphie tdd");
        expect(await readFile(join(repoSkill, "SKILL.md"), "utf8")).toBe(
            "repo tdd",
        );
        expect(await readFile(join(other, "SKILL.md"), "utf8")).toBe(
            "repo own",
        );
        expect(await exists(join(skills, "tdd", "SKILL.md"))).toBe(true);
    });

    test("an interrupted session's displaced skill is recovered", async () => {
        const shadowed = join(checkout, ".claude/.ralphie-shadowed/tdd");
        await mkdir(shadowed, { recursive: true });
        await writeFile(join(shadowed, "SKILL.md"), "repo tdd");
        await mkdir(join(checkout, ".claude/skills/tdd"), { recursive: true });
        await writeFile(
            join(checkout, ".claude/skills/tdd/SKILL.md"),
            "stale ralphie",
        );

        await sessionView("claude");

        expect(
            await readFile(
                join(checkout, ".claude/skills/tdd/SKILL.md"),
                "utf8",
            ),
        ).toBe("repo tdd");
    });
});

describe("generated docs", () => {
    test("render the label table and forbid gh", async () => {
        const { seen } = await sessionView("claude");
        expect(seen["labels"]).toContain("| `ready-for-agent` | `agent-ok` |");
        expect(seen["tracker"]).toContain("prompt");
        expect(seen["tracker"]).toContain("gh");
    });

    test("the repository's committed docs win and stay untouched", async () => {
        const docs = join(checkout, "docs/agents");
        await mkdir(docs, { recursive: true });
        await writeFile(join(docs, "issue-tracker.md"), "committed");

        const { seen } = await sessionView("claude");

        expect(seen["tracker"]).toBe("committed");
        expect(seen["labels"]).toContain("agent-ok");
        expect(await readFile(join(docs, "issue-tracker.md"), "utf8")).toBe(
            "committed",
        );
        expect(await exists(join(docs, "triage-labels.md"))).toBe(false);
        const exclude = await readFile(
            join(checkout, ".git/info/exclude"),
            "utf8",
        );
        expect(exclude).not.toContain("issue-tracker.md");
    });
});

describe("skillInvocation", () => {
    test("renders each harness's user-only skill syntax", () => {
        expect(skillInvocation("claude", "tdd")).toBe("/tdd");
        expect(skillInvocation("codex", "tdd")).toBe("$tdd");
        expect(skillInvocation("pi", "tdd")).toBe("/skill:tdd");
        expect(skillInvocation("opencode", "tdd")).toContain("tdd");
    });
});