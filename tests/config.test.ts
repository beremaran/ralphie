import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { IssueOrder, IssueSort } from "../src/github/domain.ts";
import {
    temporaryDirectory,
    workflowErrorFor,
    workflowOptionsFor,
    writeTemporaryFile,
} from "./shared/config-fixture.ts";

describe("configuration file", () => {
    test("supplies every run setting for `ralphie owner/repo`", async () => {
        const config = await writeTemporaryFile(`
workspace: /tmp/ralphie-config-test
intake:
  requireLabels: [backend, ready]
  sort: updated:desc
limits:
  implementationAttempts: 4
  reviewRounds: 2
  verificationFixes: 6
  maxDecompositionDepth: 5
repos:
  acme/api:
    branch: develop
    verify:
      - bun run check
      - bun test
`);

        const options = await workflowOptionsFor([
            "acme/api",
            "--config",
            config,
        ]);

        expect(options).toMatchObject({
            repo: "acme/api",
            branch: "develop",
            workspace: "/tmp/ralphie-config-test",
            issueFilters: {
                labels: ["ready-for-agent", "backend", "ready"],
                sort: IssueSort.Updated,
                order: IssueOrder.Descending,
            },
            implementationAttempts: 4,
            reviewRounds: 2,
            verificationFixes: 6,
            maxDecompositionDepth: 5,
            verificationCommands: ["bun run check", "bun test"],
        });
    });

    test("applies built-in defaults to an empty file", async () => {
        const config = await writeTemporaryFile("");

        const options = await workflowOptionsFor([
            "acme/api",
            "--config",
            config,
        ]);

        expect(options).toMatchObject({
            repo: "acme/api",
            workspace: "~/.ralphie",
            issueFilters: {
                labels: ["ready-for-agent"],
                sort: IssueSort.Created,
                order: IssueOrder.Ascending,
            },
            implementationAttempts: 3,
            reviewRounds: 5,
            verificationFixes: 5,
            maxDecompositionDepth: 3,
            verificationCommands: [],
        });
        expect(options.branch).toBeUndefined();
    });
});

describe("precedence", () => {
    const layered = `
intake:
  requireLabels: [backend]
  sort: updated:desc
limits:
  reviewRounds: 4
  verificationFixes: 4
repos:
  acme/api:
    branch: develop
    intake:
      requireLabels: [api]
    limits:
      reviewRounds: 2
`;

    test("a repos entry overrides top-level settings for its repository only", async () => {
        const config = await writeTemporaryFile(layered);

        const api = await workflowOptionsFor(["acme/api", "--config", config]);
        const web = await workflowOptionsFor(["acme/web", "--config", config]);

        expect(api).toMatchObject({
            branch: "develop",
            issueFilters: {
                labels: ["ready-for-agent", "api"],
                sort: IssueSort.Updated,
            },
            reviewRounds: 2,
            verificationFixes: 4,
        });
        expect(web).toMatchObject({
            issueFilters: {
                labels: ["ready-for-agent", "backend"],
                sort: IssueSort.Updated,
            },
            reviewRounds: 4,
            verificationFixes: 4,
        });
        expect(web.branch).toBeUndefined();
    });

    test("matches the repos entry regardless of letter case", async () => {
        const config = await writeTemporaryFile(layered);

        const options = await workflowOptionsFor([
            "https://github.com/ACME/API.git",
            "--config",
            config,
        ]);

        expect(options).toMatchObject({ repo: "ACME/API", branch: "develop" });
    });

    test("--set overrides any key, winning over the repos entry", async () => {
        const config = await writeTemporaryFile(layered);

        const options = await workflowOptionsFor([
            "acme/api",
            "--config",
            config,
            "--set",
            "limits.reviewRounds=7",
            "--set",
            "intake.requireLabels=[urgent, backend]",
            "--set",
            "workspace=/tmp/one-off",
        ]);

        expect(options).toMatchObject({
            reviewRounds: 7,
            issueFilters: { labels: ["ready-for-agent", "urgent", "backend"] },
            workspace: "/tmp/one-off",
        });
    });

    test("--set reaches keys under a quoted owner/repo", async () => {
        const config = await writeTemporaryFile(layered);

        const options = await workflowOptionsFor([
            "acme/my.repo",
            "--config",
            config,
            "--set",
            'repos."acme/my.repo".branch=release',
            "--set",
            'repos."acme/my.repo".verify=["make test"]',
            "--set",
            "repos.acme/api.branch=ignored-for-other-repos",
        ]);

        expect(options).toMatchObject({
            repo: "acme/my.repo",
            branch: "release",
            verificationCommands: ["make test"],
        });
    });
});

describe("repository resolution", () => {
    test("a bare name takes defaultOwner and its repos entry", async () => {
        const config = await writeTemporaryFile(`
defaultOwner: acme
repos:
  acme/api:
    branch: develop
`);

        const options = await workflowOptionsFor(["api", "--config", config]);

        expect(options).toMatchObject({ repo: "acme/api", branch: "develop" });
    });

    test("a bare name falls back to the gh login", async () => {
        const config = await writeTemporaryFile("{}");
        let lookups = 0;

        const options = await workflowOptionsFor(["api", "--config", config], {
            factories: {
                githubLogin: async () => {
                    lookups += 1;
                    return "octocat";
                },
            },
        });

        expect(options.repo).toBe("octocat/api");
        expect(lookups).toBe(1);
    });

    test("--set defaultOwner wins over the file", async () => {
        const config = await writeTemporaryFile("defaultOwner: acme\n");

        const options = await workflowOptionsFor([
            "api",
            "--config",
            config,
            "--set",
            "defaultOwner=globex",
        ]);

        expect(options.repo).toBe("globex/api");
    });

    test("owner/repo and clone URLs ignore defaultOwner and gh", async () => {
        const config = await writeTemporaryFile("defaultOwner: acme\n");

        for (const [argument, repo] of [
            ["globex/api", "globex/api"],
            ["git@github.com:globex/web.git", "globex/web"],
        ] as const) {
            const options = await workflowOptionsFor([
                argument,
                "--config",
                config,
            ]);
            expect(options.repo).toBe(repo);
        }
    });

    test("rejects an invalid repository before reading config", async () => {
        const error = await workflowErrorFor(["not a repo"]);

        expect(error.message).toBe(
            "Invalid GitHub repository: not a repo. Expected owner/repository.",
        );
    });
});

const failureFor = async (
    yaml: string,
    extraArgs: ReadonlyArray<string> = [],
): Promise<{ readonly config: string; readonly message: string }> => {
    const config = await writeTemporaryFile(yaml);
    const error = await workflowErrorFor([
        "acme/api",
        "--config",
        config,
        ...extraArgs,
    ]);
    return { config, message: error.message };
};

describe("validation", () => {
    test("rejects credential-looking keys instead of storing them", async () => {
        const { message } = await failureFor(`
token: ghp_secret
harnesses:
  claude:
    apiKey: sk-secret
`);

        expect(message).toContain("  token: unknown key");
        expect(message).toContain("  harnesses.claude.apiKey: unknown key");
    });

    test("names the path of unknown keys, wrong types and unknown values", async () => {
        const { config, message } = await failureFor(`
workspac: /tmp/typo
intake:
  sort: newest
limits:
  reviewRounds: "3"
  verificationFixes: 0
repos:
  acme/api:
    branch: main
    bogus: true
`);

        expect(message).toStartWith(`Invalid configuration in ${config}:\n`);
        for (const line of [
            "  workspac: unknown key",
            "  intake.sort: Invalid option",
            "  limits.reviewRounds: Invalid input: expected number, received string",
            "  limits.verificationFixes: Too small",
            '  repos."acme/api".bogus: unknown key',
        ]) {
            expect(message).toContain(line);
        }
    });

    test("rejects unknown harness and role names at the exact path", async () => {
        const { message } = await failureFor(`
harnesses:
  cursor:
    model: x
roles:
  default: gemini
  reviewr: claude
  implementer:
    harness: claude
    effort: 3
`);

        for (const line of [
            "  harnesses.cursor: unknown key",
            "  roles.default: Invalid input",
            "  roles.reviewr: unknown key",
            "  roles.implementer: Invalid input",
        ]) {
            expect(message).toContain(line);
        }
    });

    test("layers roles and harnesses per repository and per run", async () => {
        const config = await writeTemporaryFile(`
harnesses:
  claude:
    model: opus
roles:
  default: claude
repos:
  acme/api:
    roles:
      reviewer: codex
`);

        const options = await workflowOptionsFor([
            "acme/api",
            "--config",
            config,
            "--set",
            "harnesses.claude.effort=low",
        ]);

        expect(options.roles.implementer).toEqual({
            harness: "claude",
            approval: "safe",
            model: "opus",
            effort: "low",
        });
        expect(options.roles["standards-reviewer"].harness).toBe("codex");
        expect(options.roles["spec-reviewer"].harness).toBe("codex");
    });

    test("rejects repository-only keys at the top level", async () => {
        const { message } = await failureFor(
            "branch: main\nverify: [bun test]\n",
        );

        expect(message).toContain("  branch: unknown key");
        expect(message).toContain("  verify: unknown key");
    });

    test("rejects repos keys that are not owner/repo", async () => {
        const { message } = await failureFor(
            "repos:\n  api:\n    branch: main\n",
        );

        expect(message).toContain("  repos.api: expected an owner/repo key");
    });

    test("rejects two triage roles mapped to the same label", async () => {
        const { message } = await failureFor(
            "labels:\n  ready-for-agent: ready\n  ready-for-human: Ready\n",
        );

        expect(message).toContain(
            "  labels.ready-for-human: uses the same label as ready-for-agent",
        );
    });

    test("marks problems introduced by --set", async () => {
        const { message } = await failureFor("{}", [
            "--set",
            "limits.reviewRound=3",
            "--set",
            'repos."acme/api".branch=[main]',
        ]);

        expect(message).toContain(
            "  limits.reviewRound: unknown key (from --set)",
        );
        expect(message).toContain(
            '  repos."acme/api".branch: Invalid input: expected string, received array (from --set)',
        );
    });

    test("rejects malformed --set arguments", async () => {
        for (const [argument, reason] of [
            ["limits.reviewRounds", "expected path=value"],
            ["limits..reviewRounds=3", 'cannot read a key at ".reviewRounds"'],
            ['repos."acme/api"x=3', 'expected "." after acme/api'],
            ["workspace.path=/tmp", "workspace is not a mapping"],
        ] as const) {
            const { message } = await failureFor("workspace: /tmp/w\n", [
                "--set",
                argument,
            ]);
            expect(message).toBe(`Invalid --set ${argument}: ${reason}.`);
        }
    });

    test("rejects a file that is not a mapping or not YAML", async () => {
        const list = await failureFor("- one\n- two\n");
        expect(list.message).toBe(
            `Invalid configuration in ${list.config}: the file must be a mapping of settings.`,
        );

        const broken = await failureFor("limits: [1,\n  b: {");
        expect(broken.message).toStartWith(
            `Configuration file ${broken.config} is not valid YAML:`,
        );
    });
});

describe("configuration location", () => {
    test("reads $XDG_CONFIG_HOME/ralphie/config.yaml by default", async () => {
        const config = await writeTemporaryFile(
            "workspace: /tmp/from-xdg\n",
            "xdg/ralphie/config.yaml",
        );
        const xdg = join(dirname(config), "..");

        const options = await workflowOptionsFor(["acme/api"], {
            environment: { XDG_CONFIG_HOME: xdg },
        });

        expect(options.workspace).toBe("/tmp/from-xdg");
    });

    test("falls back to ~/.config/ralphie/config.yaml", async () => {
        const config = await writeTemporaryFile(
            "workspace: /tmp/from-home\n",
            "home/.config/ralphie/config.yaml",
        );
        const home = join(dirname(config), "..", "..");

        const options = await workflowOptionsFor(["acme/api"], {
            environment: {},
            homeDirectory: home,
        });

        expect(options.workspace).toBe("/tmp/from-home");
    });

    test("fails clearly when there is no config file", async () => {
        const home = await temporaryDirectory();

        const error = await workflowErrorFor(["acme/api"], {
            homeDirectory: home,
        });

        expect(error.message).toBe(
            `No configuration file found at ${join(home, ".config", "ralphie", "config.yaml")}. ` +
                "Run ralphie init to create one (see docs/configuration.md), or pass --config <path>.",
        );
    });

    test("fails when the --config file does not exist", async () => {
        const missing = join(await temporaryDirectory(), "missing.yaml");

        const error = await workflowErrorFor(["acme/api", "--config", missing]);

        expect(error.message).toBe(`Configuration file not found: ${missing}.`);
    });
});