import type {
    HarnessAdapter,
    TurnEvent,
    TurnOutcome,
    TurnRequest,
} from "../../src/harness/ports.ts";

export type ScriptedTurn = {
    readonly outcome: TurnOutcome;
    /** Events the adapter reports during the turn. */
    readonly events?: readonly TurnEvent[];
};

/**
 * Adapter that plays back scripted turns. The last turn repeats once the
 * script runs out, so a test can say "always invalid" with one entry.
 */
export const makeScriptedAdapter = (input: {
    readonly name?: string;
    readonly nativeSchema: boolean;
    readonly turns: readonly ScriptedTurn[];
}): { readonly adapter: HarnessAdapter; readonly requests: TurnRequest[] } => {
    const requests: TurnRequest[] = [];
    const adapter: HarnessAdapter = {
        name: input.name ?? "scripted",
        capabilities: { nativeSchema: input.nativeSchema, budgetCap: false },
        runTurn: async (turn) => {
            const turnNumber = requests.length;
            requests.push(turn);
            const scripted =
                input.turns[Math.min(turnNumber, input.turns.length - 1)];
            if (scripted === undefined) throw new Error("empty turn script");
            for (const event of scripted.events ?? []) turn.onEvent(event);
            return scripted.outcome;
        },
    };
    return { adapter, requests };
};