import { classifyFailure } from "../failure-classification.ts";
import type { z } from "zod";

import type { IdGenerator } from "../../run/ports.ts";
import type {
    HarnessAdapter,
    HarnessFailure,
    HarnessOutcome,
    HarnessService,
    SessionEvent,
    SessionEventListener,
    SessionRequest,
    StructuredSessionRequest,
    TurnEvent,
    TurnOutcome,
    TurnRequest,
} from "../ports.ts";
import type { SessionPreparation } from "./skill-injection.ts";
import {
    correctionPrompt,
    fallbackInstructions,
    parseFallbackResult,
    parseNativeResult,
    toJsonSchema,
} from "./structured-result.ts";

/** Resumes of one session allowed to repair an invalid structured result. */
const DEFAULT_MAX_RESULT_CORRECTIONS = 2;

type Dependencies = {
    readonly adapters: Readonly<Record<string, HarnessAdapter>>;
    readonly listener: SessionEventListener;
    readonly ids: IdGenerator;
    readonly maxResultCorrections?: number;
    /** Readies the checkout before a session and undoes it afterwards. */
    readonly preparation?: SessionPreparation;
};

type AnyRequest = SessionRequest & { readonly resultSchema?: z.ZodType };

type Failed = { readonly ok: false; readonly failure: HarnessFailure };

const failed = (
    kind: HarnessFailure["kind"],
    message: string,
    harnessSessionID?: string,
): Failed => ({
    ok: false,
    failure: {
        kind,
        message,
        ...(harnessSessionID === undefined ? {} : { harnessSessionID }),
    },
});

/** Why an invalid result cannot be sent back for another attempt, if so. */
const cannotRepair = (
    problem: string,
    corrections: number,
    maxCorrections: number,
    harnessSessionID: string | undefined,
): Failed | undefined => {
    if (corrections >= maxCorrections) {
        return failed(
            "invalid_result",
            `The structured result stayed invalid after ${corrections} correction${corrections === 1 ? "" : "s"}: ${problem}`,
            harnessSessionID,
        );
    }
    if (harnessSessionID === undefined) {
        return failed(
            "invalid_result",
            `The structured result was invalid and the harness reported no session to resume: ${problem}`,
        );
    }
    return undefined;
};

type TurnRunner = (input: {
    readonly prompt: string;
    readonly resumeSessionID: string | undefined;
}) => Promise<TurnOutcome>;

/** Run the one turn of a session that has no result contract. */
const runPlain = async (
    runTurn: TurnRunner,
    request: SessionRequest,
): Promise<HarnessOutcome<undefined>> => {
    const turn = await runTurn({
        prompt: request.prompt,
        resumeSessionID: request.resumeSessionID,
    });
    return turn.ok
        ? {
              ok: true,
              harnessSessionID: turn.harnessSessionID,
              text: turn.text,
              value: undefined,
          }
        : turn;
};

/**
 * Run turns until the reply validates, resuming the same session with the
 * validation error between attempts, and fail closed when the bound is hit.
 */
const runStructured = async <T>(input: {
    readonly runTurn: TurnRunner;
    readonly request: StructuredSessionRequest<T>;
    readonly native: boolean;
    readonly maxCorrections: number;
}): Promise<HarnessOutcome<T>> => {
    const { request, native } = input;
    const schema: z.ZodType<T> = request.resultSchema;
    const jsonSchema = toJsonSchema(schema);
    let prompt = native
        ? request.prompt
        : `${request.prompt}\n\n${fallbackInstructions(jsonSchema)}`;
    let resumeSessionID = request.resumeSessionID;
    for (let corrections = 0; ; corrections += 1) {
        const turn = await input.runTurn({ prompt, resumeSessionID });
        if (!turn.ok) return turn;
        const parsed = native
            ? parseNativeResult(schema, turn.structured)
            : parseFallbackResult(schema, turn.text);
        if (parsed.ok) {
            return {
                ok: true,
                harnessSessionID: turn.harnessSessionID,
                text: turn.text,
                value: parsed.value,
            };
        }
        const unrepairable = cannotRepair(
            parsed.problem,
            corrections,
            input.maxCorrections,
            turn.harnessSessionID,
        );
        if (unrepairable !== undefined) return unrepairable;
        resumeSessionID = turn.harnessSessionID;
        prompt = correctionPrompt(parsed.problem, !native, jsonSchema);
    }
};

/** The turn-independent settings every turn of a session shares. */
const sharedSettings = (
    request: SessionRequest,
): Omit<
    TurnRequest,
    "prompt" | "onEvent" | "resumeSessionID" | "jsonSchema"
> => ({
    directory: request.directory,
    access: request.access,
    timeoutMs: request.timeoutMs,
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: request.maxBudgetUsd }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
});

const runOnAdapter = async (
    adapter: HarnessAdapter,
    request: AnyRequest,
    emit: (event: TurnEvent) => void,
    maxCorrections: number,
): Promise<HarnessOutcome<unknown>> => {
    const { resultSchema } = request;
    const native = adapter.capabilities.nativeSchema;
    const jsonSchema =
        resultSchema !== undefined && native
            ? toJsonSchema(resultSchema)
            : undefined;
    const runTurn: TurnRunner = (turn) =>
        adapter.runTurn({
            ...sharedSettings(request),
            prompt: turn.prompt,
            onEvent: emit,
            ...(turn.resumeSessionID === undefined
                ? {}
                : { resumeSessionID: turn.resumeSessionID }),
            ...(jsonSchema === undefined ? {} : { jsonSchema }),
        });
    if (resultSchema === undefined) return await runPlain(runTurn, request);
    return await runStructured({
        runTurn,
        request: { ...request, resultSchema },
        native,
        maxCorrections,
    });
};

/** Run a session between preparing the checkout and releasing it. */
const runPrepared = async (
    preparation: SessionPreparation | undefined,
    request: AnyRequest,
    run: () => Promise<HarnessOutcome<unknown>>,
): Promise<HarnessOutcome<unknown>> => {
    if (preparation === undefined) return await run();
    let release: (() => Promise<void>) | undefined;
    try {
        release = await preparation({
            directory: request.directory,
            harness: request.harness,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed(
            "unavailable",
            `Could not prepare the session: ${message}`,
        );
    }
    try {
        return await run();
    } finally {
        await release();
    }
};

/**
 * Compose adapters into the harness service.
 *
 * The service owns what is the same for every harness: the session id and
 * the started, error and finished events, and structured results. A result
 * is requested natively when the adapter declares support, and otherwise as
 * a final JSON block. Both are validated with the caller's zod schema, and an
 * invalid one resumes the session with the error up to a bound.
 */
export const makeHarnessService = (deps: Dependencies): HarnessService => {
    const maxCorrections =
        deps.maxResultCorrections ?? DEFAULT_MAX_RESULT_CORRECTIONS;

    const run = async (
        request: AnyRequest,
    ): Promise<HarnessOutcome<unknown>> => {
        const context = {
            sessionID: deps.ids.next(),
            directory: request.directory,
            harness: request.harness,
            ...(request.title === undefined ? {} : { title: request.title }),
        };
        const emit = (event: SessionEvent): void =>
            deps.listener(event, context);
        emit({ type: "session_started" });
        const adapter = deps.adapters[request.harness];
        const outcome =
            adapter === undefined
                ? failed(
                      "unavailable",
                      `No harness named "${request.harness}" is available.`,
                  )
                : await runPrepared(deps.preparation, request, () =>
                      runOnAdapter(adapter, request, emit, maxCorrections),
                  );
        const settled: HarnessOutcome<unknown> = outcome.ok
            ? outcome
            : { ok: false, failure: classifyFailure(outcome.failure) };
        if (!settled.ok) {
            emit({ type: "error", message: settled.failure.message });
        }
        emit({ type: "session_finished" });
        return settled;
    };

    return { run: run as HarnessService["run"] };
};