const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const CAN = 0x18;
const SUB = 0x1a;
const ST = 0x9c;
const CSI = 0x9b;
const OSC = 0x9d;
const DCS = 0x90;
const SOS = 0x98;
const PM = 0x9e;
const APC = 0x9f;

type StringControl = "osc" | "dcs" | "sos" | "pm" | "apc";
type ParserMode =
    | "ground"
    | "escape"
    | "escape-intermediate"
    | "csi"
    | "string";

export type TerminalStreamBoundaryState = {
    /** Whether the last terminal-affecting text ended with a newline. */
    readonly atLineBoundary: boolean;
    /** Whether an escape sequence or control string is incomplete at the current chunk end. */
    readonly controlSequenceOpen: boolean;
    /** Whether a redraw can be inserted without splitting text or a control sequence. */
    readonly redrawSafe: boolean;
};

export type TerminalStreamBoundaryTracker = {
    /** Consume one arbitrary stream chunk and return the resulting state. */
    readonly write: (chunk: string) => TerminalStreamBoundaryState;
    /** Compatibility aliases for callers that describe writes as stream input. */
    readonly append: (chunk: string) => TerminalStreamBoundaryState;
    readonly feed: (chunk: string) => TerminalStreamBoundaryState;
    readonly track: (chunk: string) => TerminalStreamBoundaryState;
    readonly consume: (chunk: string) => TerminalStreamBoundaryState;
    readonly getState: () => TerminalStreamBoundaryState;
    readonly state: () => TerminalStreamBoundaryState;
    /** True even when an incomplete non-printing sequence follows the newline. */
    readonly isAtLineBoundary: () => boolean;
    /** True only when the line boundary is also safe for a redraw. */
    readonly isSafeLineBoundary: () => boolean;
    readonly isAtSafeLineBoundary: () => boolean;
    readonly isSafeToRedraw: () => boolean;
    readonly isRedrawSafe: () => boolean;
    readonly canRedraw: () => boolean;
    readonly hasOpenControlSequence: () => boolean;
    readonly isControlSequenceOpen: () => boolean;
    readonly hasOpenControlString: () => boolean;
    readonly isControlStringOpen: () => boolean;
    readonly reset: () => void;
};

export type TerminalBoundaryState = TerminalStreamBoundaryState;
export type TerminalBoundaryTracker = TerminalStreamBoundaryTracker;

const isC0 = (code: number): boolean => code <= 0x1f || code === 0x7f;

const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9f;

const movesCursor = (code: number): boolean =>
    code === 0x08 ||
    code === 0x09 ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d;

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

const isEscapeIntermediate = (code: number): boolean =>
    code >= 0x20 && code <= 0x2f;

const stringControlFor = (code: number): StringControl | undefined => {
    switch (code) {
        case OSC:
            return "osc";
        case DCS:
            return "dcs";
        case SOS:
            return "sos";
        case PM:
            return "pm";
        case APC:
            return "apc";
        default:
            return undefined;
    }
};

const stringControlForEscape = (code: number): StringControl | undefined => {
    switch (code) {
        case 0x5d:
            return "osc";
        case 0x50:
            return "dcs";
        case 0x58:
            return "sos";
        case 0x5e:
            return "pm";
        case 0x5f:
            return "apc";
        default:
            return undefined;
    }
};

/** Create a stateful, rendering-independent terminal stream boundary parser. */
export const makeTerminalStreamBoundaryTracker =
    (): TerminalStreamBoundaryTracker => {
        let mode: ParserMode = "ground";
        let stringControl: StringControl | undefined;
        let stringEscapePending = false;
        let atLineBoundary = true;

        const closeControl = (): void => {
            mode = "ground";
            stringControl = undefined;
            stringEscapePending = false;
        };

        const openString = (control: StringControl): void => {
            mode = "string";
            stringControl = control;
            stringEscapePending = false;
        };

        const consumeGround = (code: number): void => {
            if (code === ESC) {
                mode = "escape";
                return;
            }
            const control = stringControlFor(code);
            if (control !== undefined) {
                openString(control);
                return;
            }
            if (code === CSI) {
                mode = "csi";
                return;
            }
            if (code === 0x0a || movesCursor(code)) {
                atLineBoundary = code === 0x0a;
                return;
            }
            if (isC0(code) || isC1(code)) return;
            atLineBoundary = false;
        };

        const consumeEscape = (code: number): void => {
            if (code === ESC) {
                mode = "escape";
                return;
            }
            if (code === 0x5b) {
                mode = "csi";
                return;
            }
            const control = stringControlForEscape(code);
            if (control !== undefined) {
                openString(control);
                return;
            }
            if (code === CAN || code === SUB) {
                closeControl();
                return;
            }
            if (isEscapeIntermediate(code)) {
                mode = "escape-intermediate";
                return;
            }
            closeControl();
        };

        const consumeEscapeIntermediate = (code: number): void => {
            if (code === ESC) {
                mode = "escape";
                return;
            }
            if (code === CAN || code === SUB) {
                closeControl();
                return;
            }
            if (isEscapeIntermediate(code)) return;
            closeControl();
        };

        const consumeCsi = (code: number): void => {
            if (code === ESC) {
                mode = "escape";
                return;
            }
            if (code === CAN || code === SUB) {
                closeControl();
                return;
            }
            if (isCsiFinal(code)) closeControl();
        };

        const consumeStringAfterEscape = (code: number): void => {
            stringEscapePending = false;
            if (code === BACKSLASH || code === ST) {
                closeControl();
                return;
            }
            if (code === CAN || code === SUB) {
                closeControl();
                return;
            }
            if (stringControl === "osc" && code === BEL) {
                closeControl();
                return;
            }
            if (code === ESC) stringEscapePending = true;
        };

        const consumeString = (code: number): void => {
            if (stringEscapePending) {
                consumeStringAfterEscape(code);
                return;
            }
            if (code === ESC) {
                stringEscapePending = true;
                return;
            }
            if (code === ST || (stringControl === "osc" && code === BEL)) {
                closeControl();
                return;
            }
            if (code === CAN || code === SUB) closeControl();
        };

        const consumeCode = (code: number): void => {
            switch (mode) {
                case "ground":
                    consumeGround(code);
                    return;
                case "escape":
                    consumeEscape(code);
                    return;
                case "escape-intermediate":
                    consumeEscapeIntermediate(code);
                    return;
                case "csi":
                    consumeCsi(code);
                    return;
                case "string":
                    consumeString(code);
                    return;
            }
        };

        const getState = (): TerminalStreamBoundaryState => {
            const controlSequenceOpen = mode !== "ground";
            return {
                atLineBoundary,
                controlSequenceOpen,
                redrawSafe: atLineBoundary && !controlSequenceOpen,
            };
        };

        const write = (chunk: string): TerminalStreamBoundaryState => {
            for (let index = 0; index < chunk.length; index += 1) {
                consumeCode(chunk.charCodeAt(index));
            }
            return getState();
        };

        const isAtLineBoundary = (): boolean => atLineBoundary;
        const isSafeLineBoundary = (): boolean => getState().redrawSafe;
        const hasOpenControlSequence = (): boolean => mode !== "ground";
        const hasOpenControlString = (): boolean => mode === "string";
        const reset = (): void => {
            closeControl();
            atLineBoundary = true;
        };

        return {
            write,
            append: write,
            feed: write,
            track: write,
            consume: write,
            getState,
            state: getState,
            isAtLineBoundary,
            isSafeLineBoundary,
            isAtSafeLineBoundary: isSafeLineBoundary,
            isSafeToRedraw: isSafeLineBoundary,
            isRedrawSafe: isSafeLineBoundary,
            canRedraw: isSafeLineBoundary,
            hasOpenControlSequence,
            isControlSequenceOpen: hasOpenControlSequence,
            hasOpenControlString,
            isControlStringOpen: hasOpenControlString,
            reset,
        };
    };

export const createTerminalStreamBoundaryTracker =
    makeTerminalStreamBoundaryTracker;
export const makeTerminalBoundaryTracker = makeTerminalStreamBoundaryTracker;
export const createTerminalBoundaryTracker = makeTerminalStreamBoundaryTracker;