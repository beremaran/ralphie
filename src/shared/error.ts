export class RalphieError extends Error {
    readonly _tag: string = "RalphieError";

    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input.message);
        this.name = "RalphieError";
        if (input.cause !== undefined) {
            this.cause = input.cause;
        }
    }
}