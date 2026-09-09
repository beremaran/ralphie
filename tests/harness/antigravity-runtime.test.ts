import { describe, expect, test } from "bun:test";

import {
    discoverAntigravityRuntime,
    parseAntigravityVersion,
    requireAntigravityRuntime,
    type AntigravityFileSystem,
} from "../../src/harness/index.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";

const result = (stdout: string, exitCode = 0): CommandResult => ({
    exitCode,
    stdout,
    stderr: "",
});

const fileSystem = (paths: ReadonlySet<string>): AntigravityFileSystem => ({
    isExecutable: async (path) => paths.has(path),
    realpath: async (path) => path,
});

const compatibleRunner: CommandRunnerService = {
    run: async (_command, args) => {
        if (args.includes("--version")) {
            return result("Antigravity 1.4.2 (ACP protocol 1)");
        }
        if (args.includes("--protocol-version")) {
            return result("ACP protocol 1");
        }
        return result('{"capabilities":{"resume":true,"events":true}}');
    },
};

describe("Antigravity runtime discovery", () => {
    test("parses human-readable and prefixed versions", () => {
        expect(parseAntigravityVersion("Antigravity v1.4.2")).toBe("1.4.2");
        expect(parseAntigravityVersion("version 2.0")).toBe("2.0");
    });

    test("reports a missing runtime with setup guidance", async () => {
        const discovered = await discoverAntigravityRuntime({
            environment: { PATH: "/one:/two" },
            fileSystem: fileSystem(new Set()),
        });

        expect(discovered).toMatchObject({
            status: "missing",
            message: "No Antigravity runtime was found.",
        });
        expect(discovered.setupHint).toContain("Install Antigravity");
    });

    test("does not silently choose between PATH runtimes", async () => {
        const discovered = await discoverAntigravityRuntime({
            environment: { PATH: "/one:/two" },
            fileSystem: fileSystem(
                new Set(["/one/antigravity", "/two/antigravity"]),
            ),
        });

        expect(discovered.status).toBe("ambiguous");
        expect(discovered.candidates).toEqual([
            "/one/antigravity",
            "/two/antigravity",
        ]);
    });

    test("reports ambiguity for a bare configured executable", async () => {
        const discovered = await discoverAntigravityRuntime({
            config: { executable: "antigravity" },
            environment: { PATH: "/one:/two" },
            fileSystem: fileSystem(
                new Set(["/one/antigravity", "/two/antigravity"]),
            ),
        });

        expect(discovered.status).toBe("ambiguous");
        expect(discovered.candidates).toEqual([
            "/one/antigravity",
            "/two/antigravity",
        ]);
    });

    test("validates version, ACP protocol, and required features", async () => {
        const discovered = await discoverAntigravityRuntime({
            config: { requiredFeatures: ["resume"] },
            commandRunner: compatibleRunner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered.status).toBe("available");
        expect(discovered.runtime).toMatchObject({
            executable: "/bin/antigravity",
            version: "1.4.2",
            protocolVersion: "1",
            features: ["events", "resume"],
        });
    });

    test("accepts required capabilities outside the standard set", async () => {
        const discovered = await discoverAntigravityRuntime({
            config: { requiredFeatures: ["custom-acp-feature"] },
            commandRunner: {
                run: async (_command, args) =>
                    args.includes("--version")
                        ? result("Antigravity 1.4.2")
                        : args.includes("--protocol-version")
                          ? result("ACP protocol 1")
                          : result(
                                '{"capabilities":{"custom-acp-feature":true}}',
                            ),
            },
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered.status).toBe("available");
        expect(discovered.runtime?.features).toEqual(["custom-acp-feature"]);
    });

    test("parses nested capabilities surrounded by human-readable output", async () => {
        const runner: CommandRunnerService = {
            run: async (_command, args) => {
                if (args.includes("--version")) {
                    return result("Antigravity 1.4.2");
                }
                if (args.includes("--protocol-version")) {
                    return result("ACP protocol 1");
                }
                return result(
                    'capabilities:\n{"capabilities":{"resume":true,"events":true}}\nend',
                );
            },
        };

        const discovered = await discoverAntigravityRuntime({
            config: { requiredFeatures: ["resume"] },
            commandRunner: runner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered.status).toBe("available");
        expect(discovered.runtime?.features).toEqual(["events", "resume"]);
    });

    test("accepts a bare protocol version from the protocol probe", async () => {
        const runner: CommandRunnerService = {
            run: async (_command, args) => {
                if (args.includes("--version")) {
                    return result("Antigravity 1.4.2");
                }
                if (args.includes("--protocol-version")) {
                    return result("1");
                }
                return result('{"capabilities":{"resume":true}}');
            },
        };

        const discovered = await discoverAntigravityRuntime({
            commandRunner: runner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered.status).toBe("available");
        expect(discovered.runtime?.protocolVersion).toBe("1");
    });

    test("rejects successful capabilities probes without valid features", async () => {
        const runner: CommandRunnerService = {
            run: async (_command, args) =>
                args.includes("--version")
                    ? result("Antigravity 1.4.2 (ACP protocol 1)")
                    : args.includes("--protocol-version")
                      ? result("ACP protocol 1")
                      : result('{"ok":true}'),
        };

        const discovered = await discoverAntigravityRuntime({
            commandRunner: runner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered).toMatchObject({
            status: "incompatible",
            message:
                "The configured Antigravity runtime did not report parseable ACP capabilities.",
        });
    });

    test("always validates the dedicated protocol probe", async () => {
        const calls: string[] = [];
        const runner: CommandRunnerService = {
            run: async (_command, args) => {
                if (args.includes("--version")) {
                    calls.push("version");
                    return result("Antigravity 1.4.2 (ACP protocol 1)");
                }
                if (args.includes("--protocol-version")) {
                    calls.push("protocol");
                    return result("ACP protocol 2");
                }
                calls.push("capabilities");
                return result('{"capabilities":{"resume":true}}');
            },
        };

        const discovered = await discoverAntigravityRuntime({
            commandRunner: runner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered.status).toBe("incompatible");
        expect(calls).toEqual(["version", "protocol"]);
    });

    test("fails closed when the capabilities probe fails without requirements", async () => {
        const runner: CommandRunnerService = {
            run: async (_command, args) =>
                args.includes("--version")
                    ? result("Antigravity 1.4.2 (ACP protocol 1)")
                    : args.includes("--protocol-version")
                      ? result("ACP protocol 1")
                      : result("capabilities unavailable", 1),
        };

        const discovered = await discoverAntigravityRuntime({
            commandRunner: runner,
            environment: { PATH: "/bin" },
            fileSystem: fileSystem(new Set(["/bin/antigravity"])),
        });

        expect(discovered).toMatchObject({
            status: "incompatible",
            message:
                "The configured Antigravity runtime did not report its ACP capabilities.",
        });
    });

    test("requires a compatible runtime before session startup", async () => {
        const calls: string[] = [];
        const available = {
            executable: "/bin/antigravity",
            version: "1.4.2",
            protocolVersion: "1",
            features: [],
            capabilities: {
                resume: false,
                "structured-output": false,
                "model-catalog": false,
                variants: false,
                events: false,
                permissions: false,
            },
        } as const;
        const runtime = await requireAntigravityRuntime({
            discover: async () => {
                calls.push("discover");
                return {
                    status: "available",
                    candidates: [available.executable],
                    message: "ready",
                    setupHint: "",
                    runtime: available,
                };
            },
            probe: async () => ({
                kind: "google-antigravity",
                available: true,
                authenticated: false,
            }),
        });

        expect(runtime).toEqual(available);
        expect(calls).toEqual(["discover"]);
    });

    test("reports version drift without exposing probe output", async () => {
        const runner: CommandRunnerService = {
            run: async () =>
                result("Antigravity 1.4.2\nsecret-token=do-not-report"),
        };
        const discovered = await discoverAntigravityRuntime({
            config: { minimumVersion: "2.0.0" },
            commandRunner: runner,
            environment: { ANTIGRAVITY_EXECUTABLE: "/opt/antigravity" },
            fileSystem: fileSystem(new Set(["/opt/antigravity"])),
        });

        expect(discovered.status).toBe("incompatible");
        expect(discovered.message).toContain("1.4.2");
        expect(discovered.message).not.toContain("secret-token");
        expect(discovered.setupHint).toContain("supported Antigravity release");
    });
});