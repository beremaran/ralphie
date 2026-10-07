import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { makeHarnessService } from "../../src/harness/app/harness-service.ts";
import type {
    HarnessAdapter,
    HarnessFailureKind,
    SessionAccess,
    TurnEvent,
    TurnOutcome,
    TurnRequest,
} from "../../src/harness/ports.ts";
import {
    CommandAbortedError,
    CommandTimeoutError,
    type CommandRunnerService,
} from "../../src/process/ports.ts";
import { RalphieError } from "../../src/shared/error.ts";
import {
    makeScriptedRunner,
    type ProcessScript,
    type RecordedInvocation,
} from "../harness/scripted-runner.ts";

/** Argument sequences that must appear (contiguously), and flags that must not. */
export type CommandLineCheck = {
    readonly present: readonly (readonly string[])[];
    readonly absent?: readonly string[];
};

/** An access level the harness cannot offer; it must refuse without spawning. */
export type RefusedAccess = {
    readonly refuses: { readonly messageIncludes: string };
};

/** A recorded process run and what a conforming adapter makes of it. */
export type RecordedStream = {
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode?: number;
};

export type HarnessAdapterFixtures = {
    /** Label for the suite, normally the harness name. */
    readonly name: string;
    readonly make: (runner: CommandRunnerService) => HarnessAdapter;
    /** Executable the adapter spawns. */
    readonly executable: string;
    readonly expectedCapabilities: HarnessAdapter["capabilities"];
    /** Checks applied to every invocation, whatever the request. */
    readonly commandLine: {
        readonly always: CommandLineCheck;
        readonly byAccess: Readonly<
            Record<SessionAccess, CommandLineCheck | RefusedAccess>
        >;
        readonly model: (model: string) => CommandLineCheck;
        readonly effort: (effort: string) => CommandLineCheck;
        readonly budget: (usd: number) => CommandLineCheck;
        readonly resume: (id: string) => CommandLineCheck;
        /** Native schema output; required when `nativeSchema` is declared. */
        readonly schema?: (schemaJson: string) => CommandLineCheck;
    };
    readonly streams: {
        /** A plain assistant reply with no tool use. */
        readonly reply: RecordedStream & {
            readonly expect: {
                readonly text: string;
                readonly harnessSessionID: string;
                readonly events: readonly TurnEvent[];
            };
        };
        /** A reply that runs a tool first. */
        readonly toolUse: RecordedStream & {
            /** Access level that runs tools; defaults to `safe`. */
            readonly access?: SessionAccess;
            readonly expect: {
                readonly text: string;
                readonly events: readonly TurnEvent[];
            };
        };
        /** Native structured output; required when `nativeSchema` is declared. */
        readonly structured?: RecordedStream & {
            readonly expect: { readonly structured: unknown };
        };
        /**
         * A stream whose structured result is `{ "answer": "ok" }`: native
         * output for `nativeSchema` adapters, the JSON block fallback for the
         * rest. Defaults to `structured` when that is given.
         */
        readonly validResult?: RecordedStream;
        /** Streams the adapter must classify as typed failures. */
        readonly failures: readonly (RecordedStream & {
            readonly name: string;
            readonly access: SessionAccess;
            readonly expect: {
                readonly kind: HarnessFailureKind;
                readonly messageIncludes: string;
            };
        })[];
    };
};

const SCHEMA = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
} as const;

const hasSequence = (
    args: readonly string[],
    sequence: readonly string[],
): boolean => {
    for (let start = 0; start + sequence.length <= args.length; start += 1) {
        if (sequence.every((part, offset) => args[start + offset] === part)) {
            return true;
        }
    }
    return false;
};

const expectCommandLine = (
    invocation: RecordedInvocation,
    check: CommandLineCheck,
): void => {
    for (const sequence of check.present) {
        expect(
            hasSequence(invocation.args, sequence),
            `expected arguments to contain ${JSON.stringify(sequence)}, got ${JSON.stringify(invocation.args)}`,
        ).toBe(true);
    }
    for (const flag of check.absent ?? []) {
        expect(
            invocation.args.includes(flag),
            `expected arguments to omit ${flag}, got ${JSON.stringify(invocation.args)}`,
        ).toBe(false);
    }
};

type Turn = {
    readonly outcome: TurnOutcome;
    readonly events: TurnEvent[];
    readonly invocations: RecordedInvocation[];
};

/**
 * Shared behavioral contract for every harness adapter.
 *
 * Adapters run against the process port with recorded streams standing in for
 * the real CLI, so the suite is offline. It owns the behavior that must be the
 * same for every harness (events, results, failures, timeouts, isolation of
 * the prompt from the command line) and takes each adapter's command-line
 * shape and recorded streams as fixtures.
 */
export const harnessAdapterContract = (
    fixtures: HarnessAdapterFixtures,
): void => {
    const run = async (
        scripts: readonly ProcessScript[],
        overrides: Partial<TurnRequest> = {},
    ): Promise<Turn> => {
        const { runner, invocations } = makeScriptedRunner(scripts);
        const adapter = fixtures.make(runner);
        const events: TurnEvent[] = [];
        const outcome = await adapter.runTurn({
            prompt: "Do the thing\n--with-dashes",
            directory: "/work/repo",
            access: "read-only",
            timeoutMs: 1234,
            env: { SESSION_MARKER: "present", GH_TOKEN: undefined },
            onEvent: (event) => events.push(event),
            ...overrides,
        });
        return { outcome, events, invocations };
    };

    const expectRefusal = async (
        access: SessionAccess,
        check: RefusedAccess,
    ): Promise<void> => {
        const { outcome, invocations } = await run([], { access });
        expect(invocations).toHaveLength(0);
        expect(outcome).toMatchObject({
            ok: false,
            failure: { kind: "access" },
        });
        if (outcome.ok) return;
        expect(outcome.failure.message).toContain(
            check.refuses.messageIncludes,
        );
    };

    const stream = (recorded: RecordedStream): ProcessScript => recorded;

    describe(`${fixtures.name} harness adapter contract`, () => {
        test("declares its capabilities", () => {
            const adapter = fixtures.make(makeScriptedRunner([]).runner);
            expect(adapter.capabilities).toEqual(fixtures.expectedCapabilities);
        });

        for (const access of ["read-only", "safe", "yolo"] as const) {
            test(`builds the ${access} command line`, async () => {
                const check = fixtures.commandLine.byAccess[access];
                if ("refuses" in check) {
                    await expectRefusal(access, check);
                    return;
                }
                const { invocations } = await run(
                    [stream(fixtures.streams.reply)],
                    { access },
                );
                expect(invocations).toHaveLength(1);
                const [invocation] = invocations;
                if (invocation === undefined) throw new Error("no invocation");
                expect(invocation.command).toBe(fixtures.executable);
                expectCommandLine(invocation, fixtures.commandLine.always);
                expectCommandLine(invocation, check);
            });
        }

        test("passes the prompt on stdin, never on the command line", async () => {
            const { invocations } = await run([stream(fixtures.streams.reply)]);
            const [invocation] = invocations;
            expect(invocation?.options.stdin).toBe(
                "Do the thing\n--with-dashes",
            );
            expect(invocation?.args.join(" ")).not.toContain("Do the thing");
        });

        test("runs in the session directory with its environment, timeout and signal", async () => {
            const controller = new AbortController();
            const { invocations } = await run(
                [stream(fixtures.streams.reply)],
                { signal: controller.signal },
            );
            const options = invocations[0]?.options;
            expect(options?.cwd).toBe("/work/repo");
            expect(options?.timeoutMs).toBe(1234);
            expect(options?.env).toEqual({
                SESSION_MARKER: "present",
                GH_TOKEN: undefined,
            });
            expect(options?.signal).toBeDefined();
            controller.abort();
            expect(options?.signal?.aborted).toBe(true);
        });

        test("runs every process in its own group with untrimmed stdout", async () => {
            const { invocations } = await run([stream(fixtures.streams.reply)]);
            expect(invocations[0]?.options.processGroup).toBe(true);
            expect(invocations[0]?.options.trimStdout).toBe(false);
        });

        test("passes model, effort and budget when given", async () => {
            const { invocations } = await run(
                [stream(fixtures.streams.reply)],
                { model: "some-model", effort: "high", maxBudgetUsd: 1.5 },
            );
            const [invocation] = invocations;
            if (invocation === undefined) throw new Error("no invocation");
            expectCommandLine(
                invocation,
                fixtures.commandLine.model("some-model"),
            );
            expectCommandLine(invocation, fixtures.commandLine.effort("high"));
            expectCommandLine(invocation, fixtures.commandLine.budget(1.5));
        });

        test("resumes a session by its harness id", async () => {
            const { invocations } = await run(
                [stream(fixtures.streams.reply)],
                { resumeSessionID: "resume-me" },
            );
            const [invocation] = invocations;
            if (invocation === undefined) throw new Error("no invocation");
            expectCommandLine(
                invocation,
                fixtures.commandLine.resume("resume-me"),
            );
            expectCommandLine(invocation, fixtures.commandLine.always);
        });

        test("returns the final text, the harness session id and normalized events", async () => {
            const { outcome, events } = await run([
                stream(fixtures.streams.reply),
            ]);
            expect(outcome).toEqual({
                ok: true,
                harnessSessionID:
                    fixtures.streams.reply.expect.harnessSessionID,
                text: fixtures.streams.reply.expect.text,
            });
            expect(events).toEqual([...fixtures.streams.reply.expect.events]);
        });

        test("pairs every tool result with the tool call that started it", async () => {
            const { outcome, events } = await run(
                [stream(fixtures.streams.toolUse)],
                { access: fixtures.streams.toolUse.access ?? "safe" },
            );
            expect(outcome.ok).toBe(true);
            expect(events).toEqual([...fixtures.streams.toolUse.expect.events]);
            const started = new Map<string, string>();
            for (const event of events) {
                if (event.type === "tool_call") {
                    started.set(event.callId, event.name);
                }
                if (event.type === "tool_result") {
                    expect(started.get(event.callId)).toBe(event.name);
                }
            }
        });

        test("reports usage once per turn, as a delta", async () => {
            const { events } = await run([stream(fixtures.streams.toolUse)], {
                access: fixtures.streams.toolUse.access ?? "safe",
            });
            expect(
                events.filter((event) => event.type === "usage"),
            ).toHaveLength(1);
        });

        const { structured } = fixtures.streams;
        if (fixtures.expectedCapabilities.nativeSchema) {
            test("asks for native schema output and returns the structured value", async () => {
                if (structured === undefined) {
                    throw new Error(
                        "fixtures must record a structured stream for a native-schema adapter",
                    );
                }
                const { outcome, invocations } = await run(
                    [stream(structured)],
                    { jsonSchema: SCHEMA },
                );
                const [invocation] = invocations;
                if (invocation === undefined) throw new Error("no invocation");
                expectCommandLine(
                    invocation,
                    fixtures.commandLine.schema?.(JSON.stringify(SCHEMA)) ?? {
                        present: [],
                    },
                );
                expect(outcome).toMatchObject({
                    ok: true,
                    structured: structured.expect.structured,
                });
            });

            test("asks for native schema output again when resuming", async () => {
                if (structured === undefined)
                    throw new Error("no structured stream");
                const { invocations } = await run([stream(structured)], {
                    jsonSchema: SCHEMA,
                    resumeSessionID: "resume-me",
                });
                const [invocation] = invocations;
                if (invocation === undefined) throw new Error("no invocation");
                expectCommandLine(
                    invocation,
                    fixtures.commandLine.schema?.(JSON.stringify(SCHEMA)) ?? {
                        present: [],
                    },
                );
                expectCommandLine(
                    invocation,
                    fixtures.commandLine.resume("resume-me"),
                );
            });
        } else {
            test("never requests native schema output", async () => {
                const { invocations } = await run(
                    [stream(fixtures.streams.reply)],
                    { jsonSchema: SCHEMA },
                );
                expect(invocations[0]?.args.join(" ")).not.toContain("schema");
            });
        }

        for (const failure of fixtures.streams.failures) {
            test(`classifies ${failure.name} as a ${failure.expect.kind} failure`, async () => {
                const { outcome } = await run([stream(failure)], {
                    access: failure.access,
                });
                expect(outcome.ok).toBe(false);
                if (outcome.ok) return;
                expect(outcome.failure.kind).toBe(failure.expect.kind);
                expect(outcome.failure.message).toContain(
                    failure.expect.messageIncludes,
                );
            });
        }

        test("fails with the exit code and stderr when the process dies without a result", async () => {
            const { outcome } = await run([
                { stdout: "", stderr: "segfault in harness", exitCode: 139 },
            ]);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.failure.kind).toBe("exit");
            expect(outcome.failure.message).toContain("139");
            expect(outcome.failure.message).toContain("segfault in harness");
        });

        test("fails when the process exits cleanly without a result", async () => {
            const { outcome } = await run([{ stdout: "", exitCode: 0 }]);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.failure.kind).toBe("harness");
        });

        test("ignores output lines that are not events", async () => {
            const reply = fixtures.streams.reply;
            const { outcome } = await run([
                {
                    ...reply,
                    stdout: `not an event\n\n${reply.stdout}\ntrailing noise`,
                },
            ]);
            expect(outcome.ok).toBe(true);
        });

        test("reports a timeout as a timeout failure", async () => {
            const { outcome } = await run([
                {
                    throws: new CommandTimeoutError({
                        command: fixtures.executable,
                        timeoutMs: 1234,
                    }),
                },
            ]);
            expect(outcome).toMatchObject({
                ok: false,
                failure: { kind: "timeout" },
            });
        });

        test("reports cancellation as an aborted failure", async () => {
            const { outcome } = await run([
                {
                    throws: new CommandAbortedError({
                        command: fixtures.executable,
                    }),
                },
            ]);
            expect(outcome).toMatchObject({
                ok: false,
                failure: { kind: "aborted" },
            });
        });

        test("reports a missing executable as unavailable", async () => {
            const { outcome } = await run([
                {
                    throws: new RalphieError({
                        message: `Could not execute ${fixtures.executable}. Is it installed and available on PATH?`,
                    }),
                },
            ]);
            expect(outcome).toMatchObject({
                ok: false,
                failure: { kind: "unavailable" },
            });
        });

        describe("structured results through the harness service", () => {
            const schema = z.object({ answer: z.string() });
            const service = (scripts: readonly ProcessScript[]) => {
                const { runner, invocations } = makeScriptedRunner(scripts);
                const adapter = fixtures.make(runner);
                return {
                    invocations,
                    run: async () =>
                        await makeHarnessService({
                            adapters: { [adapter.name]: adapter },
                            listener: () => undefined,
                            ids: { next: () => "ralphie-session" },
                        }).run({
                            role: "implementer",
                            harness: adapter.name,
                            prompt: "do it",
                            directory: "/work/repo",
                            access: "read-only",
                            timeoutMs: 1000,
                            resultSchema: schema,
                        }),
                };
            };
            const valid = (): RecordedStream => {
                const found =
                    fixtures.streams.validResult ?? fixtures.streams.structured;
                if (found === undefined) {
                    throw new Error("fixtures need a validResult stream");
                }
                return found;
            };

            test("resumes the session with the error, then accepts a valid result", async () => {
                const { run: runService, invocations } = service([
                    stream(fixtures.streams.reply),
                    stream(valid()),
                ]);
                const outcome = await runService();
                expect(outcome).toMatchObject({
                    ok: true,
                    value: { answer: "ok" },
                });
                expect(invocations).toHaveLength(2);
                const second = invocations[1];
                if (second === undefined) throw new Error("no resume turn");
                expectCommandLine(
                    second,
                    fixtures.commandLine.resume(
                        fixtures.streams.reply.expect.harnessSessionID,
                    ),
                );
            });

            test("fails closed when every turn stays invalid", async () => {
                const { run: runService, invocations } = service([
                    stream(fixtures.streams.reply),
                    stream(fixtures.streams.reply),
                    stream(fixtures.streams.reply),
                ]);
                const outcome = await runService();
                expect(outcome).toMatchObject({
                    ok: false,
                    failure: { kind: "invalid_result" },
                });
                expect(invocations.length).toBeGreaterThan(1);
            });
        });
    });
};