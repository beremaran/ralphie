export class RalphieError extends Error {
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input.message);
        this.name = "RalphieError";
        if (input.cause !== undefined) {
            this.cause = input.cause;
        }
    }
}

/** The run stopped early because the environment, not an issue, failed. */
export class RunHaltedError extends RalphieError {
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "RunHaltedError";
    }
}