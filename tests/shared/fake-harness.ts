import { z } from "zod";

import type {
    HarnessFailure,
    HarnessOutcome,
    HarnessRole,
    HarnessService,
    SessionEvent,
    SessionEventListener,
    SessionRequest,
} from "../../src/harness/ports.ts";

/** What a scripted session ends with. */
export type FakeOutcome =
    | {
          /** The structured value; validated against the request's schema. */
          readonly value?: unknown;
          readonly text?: string;
          readonly harnessSessionID?: string;
          /** Events the session streams before it ends. */
          readonly events?: readonly SessionEvent[];
      }
    | { readonly failure: HarnessFailure };

/** An outcome, or a function that picks one from the request. */
export type FakeResponse =
    | FakeOutcome
    | ((request: SessionRequest, callIndex: number) => FakeOutcome);

export type FakeHarnessOptions = {
    /**
     * Responses per role. A list answers calls in order and its last entry
     * repeats. A role with no response makes the fake throw, so a workflow
     * test fails loudly when it starts a session it did not expect.
     */
    readonly roles?: Partial<
        Record<HarnessRole, FakeResponse | readonly FakeResponse[]>
    >;
    /** Receives every event, as the progress adapters would. */
    readonly listener?: SessionEventListener;
};

export type FakeHarness = {
    readonly service: HarnessService;
    /** Every request received, in order. */
    readonly requests: readonly SessionRequest[];
    /** Requests received for one role. */
    readonly requestsFor: (role: HarnessRole) => readonly SessionRequest[];
};

const pick = (
    responses: FakeResponse | readonly FakeResponse[],
    callIndex: number,
): FakeResponse => {
    if (!Array.isArray(responses)) return responses as FakeResponse;
    const list = responses as readonly FakeResponse[];
    const chosen = list[Math.min(callIndex, list.length - 1)];
    if (chosen === undefined)
        throw new Error("FakeHarness: empty response list");
    return chosen;
};

const outcomeFor = (
    options: FakeHarnessOptions,
    request: SessionRequest,
    callIndex: number,
): FakeOutcome => {
    const responses = options.roles?.[request.role];
    if (responses === undefined) {
        throw new Error(
            `FakeHarness: no response scripted for role "${request.role}"`,
        );
    }
    const chosen = pick(responses, callIndex);
    return typeof chosen === "function" ? chosen(request, callIndex) : chosen;
};

/**
 * In-memory harness for workflow tests.
 *
 * Scripts one outcome per role and call, records the requests, brackets each
 * session with the same events the real service sends, and validates scripted
 * values against the request's schema so a fake can never return a value the
 * real harness would have rejected.
 */
export const makeFakeHarness = (
    options: FakeHarnessOptions = {},
): FakeHarness => {
    const requests: SessionRequest[] = [];
    const callsByRole = new Map<HarnessRole, number>();
    let sessions = 0;

    const run = async (
        request: SessionRequest & { readonly resultSchema?: z.ZodType },
    ): Promise<HarnessOutcome<unknown>> => {
        requests.push(request);
        const callIndex = callsByRole.get(request.role) ?? 0;
        callsByRole.set(request.role, callIndex + 1);
        const outcome = outcomeFor(options, request, callIndex);

        sessions += 1;
        const context = {
            sessionID: `fake-session-${sessions}`,
            directory: request.directory,
            harness: request.harness,
            ...(request.title === undefined ? {} : { title: request.title }),
        };
        const emit = (event: SessionEvent): void =>
            options.listener?.(event, context);
        emit({ type: "session_started" });
        for (const event of "failure" in outcome
            ? []
            : (outcome.events ?? [])) {
            emit(event);
        }
        const result = settle(request, outcome, `fake-harness-${sessions}`);
        if (!result.ok)
            emit({ type: "error", message: result.failure.message });
        emit({ type: "session_finished" });
        return result;
    };

    return {
        service: { run: run as HarnessService["run"] },
        requests,
        requestsFor: (role) =>
            requests.filter((request) => request.role === role),
    };
};

const settle = (
    request: SessionRequest & { readonly resultSchema?: z.ZodType },
    outcome: FakeOutcome,
    defaultSessionID: string,
): HarnessOutcome<unknown> => {
    if ("failure" in outcome) return { ok: false, failure: outcome.failure };
    const harnessSessionID = outcome.harnessSessionID ?? defaultSessionID;
    const text = outcome.text ?? "";
    if (request.resultSchema === undefined) {
        return { ok: true, harnessSessionID, text, value: undefined };
    }
    const parsed = request.resultSchema.safeParse(outcome.value);
    if (!parsed.success) {
        return {
            ok: false,
            failure: {
                kind: "invalid_result",
                message: `FakeHarness: scripted value for role "${request.role}" does not match the schema: ${z.prettifyError(parsed.error)}`,
                harnessSessionID,
            },
        };
    }
    return { ok: true, harnessSessionID, text, value: parsed.data };
};