/**
 * Deterministic cross-platform PTY command driver (test-only).
 *
 * Launches an arbitrary command on a real pseudo-terminal on darwin/linux
 * (the only environments this repository runs CI on) and exposes:
 *
 * - marker synchronization (`waitFor`) instead of arbitrary sleeps;
 * - raw output capture from the PTY master;
 * - final-screen inspection through a small terminal emulator that tracks
 *   scrollback separately from the visible screen (screen-vs-scrollback
 *   oracle) and honors ANSI cursor/erase effects;
 * - `resize(columns, rows)` through TIOCSWINSZ (the kernel delivers SIGWINCH
 *   to the child's foreground process group, so a Bun child sees its
 *   `stderr` "resize" event and updated `columns`/`rows`);
 * - input injection and SIGINT/SIGTERM/SIGHUP/SIGKILL delivery to the
 *   child's process group;
 * - exit-status waiting with timeouts;
 * - idempotent teardown that kills the child process group and the relay
 *   helper, leaving nothing behind.
 *
 * The PTY is allocated by a small embedded Python relay (openpty + fork)
 * because the supported Bun versions do not expose resize/input on their
 * experimental `pty: true` spawn API. Python 3 ships on the ubuntu and
 * macOS GitHub Actions runners and on local darwin/linux developer
 * machines, and its `pty` module behaves identically on both platforms.
 * The child runs as its own session leader on the PTY; the relay only
 * proxies bytes and ioctls and never interprets application output.
 */

type PtyRelayPayload = {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cols: number;
    readonly rows: number;
};

/** Embedded relay: openpty, fork a session leader, proxy bytes and ioctls. */
const PTY_RELAY_PROGRAM = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time

payload = json.loads(base64.b64decode(sys.argv[1]))
child_argv = payload["argv"]
env = payload.get("env") or {}
columns = payload["cols"]
rows = payload["rows"]

# The relay must survive stray terminal signals while it owns the PTY.
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

sync_read, sync_write = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(sync_read)
    os.setsid()
    # SIG_IGN dispositions survive exec; restore defaults so the child can
    # install its own SIGINT/SIGTERM handlers (and bash traps work).
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.write(sync_write, b"x")
    os.close(sync_write)
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.close(master)
    env = {str(key): str(value) for key, value in env.items() if value is not None}
    os.execvpe(child_argv[0], child_argv, env)

os.close(sync_write)
os.read(sync_read, 1)
os.close(sync_read)
os.close(slave)
pgid = os.getpgid(pid)


def report(message):
    sys.stderr.write(json.dumps(message) + "\n")
    sys.stderr.flush()


report({"event": "ready", "childPid": pid, "childPgid": pgid})


def handle_resize(message):
    fcntl.ioctl(
        master,
        termios.TIOCSWINSZ,
        struct.pack(
            "HHHH",
            message.get("rows", rows),
            message.get("cols", columns),
            0,
            0,
        ),
    )


def handle_write(message):
    os.write(master, base64.b64decode(message["data"]))


def handle_signal(message):
    os.killpg(pgid, getattr(signal, message["name"]))


handlers = {"resize": handle_resize, "write": handle_write, "signal": handle_signal}
pending = b""
done = None
status = None
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.2)
        for fd in readable:
            if fd == master:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    os.close(master)
                    master = -1
                else:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                continue
            chunk = sys.stdin.buffer.read1()
            if not chunk:
                continue
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if not line.strip():
                    continue
                message = json.loads(line)
                handlers[message["op"]](message)
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done = pid
            status = None
        if done or master == -1:
            break
    if not done:
        # The last slave fd closed, so the child is exiting (or detached).
        # Reap it with a bounded wait, then report its exit status so the
        # driver can assert process-group cleanup.
        deadline = time.time() + 5.0
        while True:
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done = pid
                status = None
            if done:
                break
            if time.time() > deadline:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                done, status = os.waitpid(pid, 0)
                break
            time.sleep(0.05)
    if done:
        if os.WIFEXITED(status):
            code = os.WEXITSTATUS(status)
            term_signal = None
        else:
            code = None
            term_signal = os.WTERMSIG(status)
        report({"event": "exit", "code": code, "signal": term_signal})
finally:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    report({"event": "closed"})
    os._exit(0)
`;

export type PtySignalName = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL";

export type PtyWaitOptions = {
    readonly timeoutMs?: number;
};

export type PtyExitInfo = {
    readonly code: number | null;
    readonly signal: string | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;

/** True when `pid` (or, for a negative pid, its process group) still exists. */
export const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const charWidth = (character: string): number => {
    const width = Bun.stringWidth(character);
    return Number.isFinite(width) && width > 0 ? width : 1;
};

const isCsiParam = (code: number): boolean => code >= 0x30 && code <= 0x3f;
const isCsiIntermediate = (code: number): boolean =>
    code >= 0x20 && code <= 0x2f;
const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

const csiParams = (parameters: string, index: number): number => {
    const value = Number(parameters.split(";")[index]);
    return Number.isFinite(value) && value > 0 ? value : 1;
};

/**
 * Minimal terminal emulator for final-screen inspection.
 *
 * Consumes raw PTY bytes the way a real terminal would: printable and wide
 * characters, autowrap, cursor motion (CUP, CUU/CUD/CUF/CUB, VPA, CHA), line
 * and screen erasure, newlines, carriage returns, backspace, and tabs. SGR,
 * OSC/DCS strings, and private-mode sequences are consumed without side
 * effects. Everything scrolled past the bottom row is kept in the scrollback
 * so tests can tell what is on screen from what already scrolled away.
 */
export class PtyScreen {
    private width: number;
    private height: number;
    private cursorRow = 0;
    private cursorCol = 0;
    private rows: string[][] = [];
    private history: string[] = [];

    constructor(width: number, height: number) {
        this.width = Math.max(1, Math.floor(width));
        this.height = Math.max(1, Math.floor(height));
        this.rows = Array.from({ length: this.height }, () =>
            Array.from({ length: this.width }, () => ""),
        );
    }

    readonly columns = (): number => this.width;

    readonly rowsCount = (): number => this.height;

    /** Scroll one line: push the top row into history and grow at the bottom. */
    private readonly scroll = (): void => {
        const top = this.rows.shift();
        if (top !== undefined) this.history.push(top.join("").trimEnd());
        this.rows.push(Array.from({ length: this.width }, () => ""));
        this.cursorRow = this.height - 1;
    };

    private readonly lineFeed = (): void => {
        if (this.cursorRow >= this.height - 1) {
            this.scroll();
        } else {
            this.cursorRow += 1;
        }
        this.cursorCol = 0;
    };

    private readonly carriageReturn = (): void => {
        this.cursorCol = 0;
    };

    private readonly clearRowRange = (
        row: number,
        from: number,
        to: number,
    ): void => {
        const cells = this.rows[row] as string[];
        for (let column = from; column < to; column += 1) {
            cells[column] = "";
        }
    };

    private readonly replaceRows = (): void => {
        this.rows = Array.from({ length: this.height }, () =>
            Array.from({ length: this.width }, () => ""),
        );
    };

    private readonly eraseInLine = (mode: number): void => {
        if (mode === 1)
            this.clearRowRange(this.cursorRow, 0, this.cursorCol + 1);
        else this.clearRowRange(this.cursorRow, this.cursorCol, this.width);
    };

    private readonly eraseInDisplay = (mode: number): void => {
        if (mode === 2) {
            this.replaceRows();
            return;
        }
        const fromRow = mode === 1 ? 0 : this.cursorRow;
        const limitRow = mode === 1 ? this.cursorRow : this.height - 1;
        for (let row = fromRow; row <= limitRow; row += 1) {
            const start = row < this.cursorRow ? 0 : this.cursorCol;
            this.clearRowRange(row, start, this.width);
        }
    };

    private readonly putCell = (character: string): void => {
        if (this.cursorCol >= this.width) {
            this.lineFeed();
        }
        const cells = this.rows[this.cursorRow] as string[];
        cells[this.cursorCol] = character;
        const width = charWidth(character);
        this.cursorCol = Math.min(this.width, this.cursorCol + width);
    };

    private readonly applyCsi = (parameters: string, final: string): void => {
        const [firstParameter = 1, secondParameter = 1] = parameters
            .split(";")
            .map((value) => (value === "" ? NaN : Number(value)));
        const useSecond = (value: number): number =>
            Number.isFinite(value) && value > 0 ? value : 1;
        switch (final) {
            case "A":
                this.cursorRow = Math.max(
                    0,
                    this.cursorRow - csiParams(parameters, 0),
                );
                return;
            case "B":
                this.cursorRow = Math.min(
                    this.height - 1,
                    this.cursorRow + csiParams(parameters, 0),
                );
                return;
            case "C":
                this.cursorCol = Math.min(
                    this.width - 1,
                    this.cursorCol + csiParams(parameters, 0),
                );
                return;
            case "D":
                this.cursorCol = Math.max(
                    0,
                    this.cursorCol - csiParams(parameters, 0),
                );
                return;
            case "E":
                this.cursorRow = Math.min(
                    this.height - 1,
                    this.cursorRow + csiParams(parameters, 0),
                );
                this.cursorCol = 0;
                return;
            case "F":
                this.cursorRow = Math.max(
                    0,
                    this.cursorRow - csiParams(parameters, 0),
                );
                this.cursorCol = 0;
                return;
            case "G":
                this.cursorCol = Math.max(
                    0,
                    Math.min(this.width - 1, useSecond(firstParameter) - 1),
                );
                return;
            case "d":
                this.cursorRow = Math.max(
                    0,
                    Math.min(this.height - 1, useSecond(firstParameter) - 1),
                );
                return;
            case "H":
            case "f":
                this.cursorRow = Math.max(
                    0,
                    Math.min(this.height - 1, useSecond(firstParameter) - 1),
                );
                this.cursorCol = Math.max(
                    0,
                    Math.min(this.width - 1, useSecond(secondParameter) - 1),
                );
                return;
            case "J":
                this.eraseInDisplay(
                    useSecond(firstParameter) === 2
                        ? 2
                        : useSecond(firstParameter),
                );
                return;
            case "K":
                this.eraseInLine(useSecond(firstParameter));
                return;
            default:
                // SGR (m), SM/RM (h/l), DECSTBM (r), and every other CSI
                // final is consumed without altering the visible surface.
                return;
        }
    };

    private readonly consumeCsi = (text: string, start: number): number => {
        let index = start + 2;
        if (text.charCodeAt(index) === 0x3f) index += 1; // private DEC prefix
        let parameters = "";
        while (index < text.length && isCsiParam(text.charCodeAt(index))) {
            parameters += text[index];
            index += 1;
        }
        while (
            index < text.length &&
            isCsiIntermediate(text.charCodeAt(index))
        ) {
            index += 1;
        }
        if (index >= text.length) return text.length;
        const final = text.charCodeAt(index);
        if (!isCsiFinal(final)) return index + 1;
        this.applyCsi(parameters, text[index] as string);
        return index + 1;
    };

    /** Consume OSC (or DCS/APC/PM/SOS) through BEL or ST (ESC \). */
    private readonly consumeString = (text: string, start: number): number => {
        for (let index = start + 2; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code === 0x07) return index + 1;
            if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
                return index + 2;
            }
        }
        return text.length;
    };

    /** Reverse index (ESC M): move up, inserting a line at the top. */
    private readonly reverseIndex = (): void => {
        if (this.cursorRow === 0) {
            const bottom = this.rows.pop();
            if (bottom === undefined) return;
            this.rows.unshift(Array.from({ length: this.width }, () => ""));
            this.history.pop();
            return;
        }
        this.cursorRow -= 1;
    };

    private readonly resetSurface = (): void => {
        this.eraseInDisplay(2);
        this.cursorRow = 0;
        this.cursorCol = 0;
    };

    private readonly consumeEscape = (text: string, start: number): number => {
        const first = text.charCodeAt(start + 1);
        if (first === 0x5b) return this.consumeCsi(text, start);
        if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(first)) {
            return this.consumeString(text, start);
        }
        if ([0x37, 0x38].includes(first)) return start + 2; // save/restore
        if (first === 0x44 || first === 0x45) {
            this.lineFeed();
            return start + 2;
        }
        if (first === 0x4d) {
            this.reverseIndex();
            return start + 2;
        }
        if (first === 0x63) {
            this.resetSurface();
            return start + 2;
        }
        return start + 2;
    };

    private readonly consumeCharacter = (
        text: string,
        index: number,
    ): number => {
        const code = text.charCodeAt(index);
        if (code === 0x1b) return this.consumeEscape(text, index);
        if (code === 0x0a || code === 0x0b || code === 0x0c) {
            this.lineFeed();
            return index + 1;
        }
        if (code === 0x0d) {
            this.carriageReturn();
            return index + 1;
        }
        if (code === 0x08) {
            this.cursorCol = Math.max(0, this.cursorCol - 1);
            return index + 1;
        }
        if (code === 0x09) {
            this.cursorCol = Math.min(
                this.width - 1,
                this.cursorCol + (8 - (this.cursorCol % 8)),
            );
            return index + 1;
        }
        if (code <= 0x1f || code === 0x7f) return index + 1;

        const character = text[index] as string;
        if (charWidth(character) === 0) return index + 1;
        this.putCell(character);
        return index + 1;
    };

    /** Feed raw PTY bytes exactly as a terminal would render them. */
    readonly feed = (text: string): void => {
        let index = 0;
        while (index < text.length) {
            index = this.consumeCharacter(text, index);
        }
    };

    /** Re-model the surface at a new size, keeping everything scrolled away. */
    readonly resize = (columns: number, rows: number): void => {
        for (const row of this.rows) {
            const line = row.join("").trimEnd();
            if (line !== "") this.history.push(line);
        }
        this.width = Math.max(1, Math.floor(columns));
        this.height = Math.max(1, Math.floor(rows));
        this.rows = Array.from({ length: this.height }, () =>
            Array.from({ length: this.width }, () => ""),
        );
        this.cursorRow = 0;
        this.cursorCol = 0;
    };

    /** The currently visible screen rows, trailing whitespace trimmed. */
    readonly screen = (): readonly string[] =>
        this.rows.map((row) => row.join("").trimEnd());

    /** Rows that scrolled past the bottom of the visible screen. */
    readonly scrollback = (): readonly string[] => [...this.history];
}

type StdinSink = {
    readonly write: (text: string) => unknown;
    readonly flush?: () => void;
    readonly end?: () => void;
};

type MarkerWaiter = {
    readonly marker: string;
    readonly resolve: (raw: string) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
};

type ExitWaiter = {
    readonly resolve: (info: PtyExitInfo) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
};

export type PtyLaunchOptions = {
    /** Command (argv) to run inside the PTY; it becomes a session leader. */
    readonly command: readonly string[];
    readonly columns: number;
    readonly rows: number;
    /** Extra variables merged over the driver's own environment. */
    readonly env?: Readonly<Record<string, string | undefined>>;
};

export type PtySession = {
    /** PID of the Python relay that owns the PTY (direct spawn child). */
    readonly helperPid: number;
    /** PID of the command running inside the PTY (undefined pre-ready). */
    readonly childPid: () => number | undefined;
    /** Process-group ID of the command (equals its PID: session leader). */
    readonly childPgid: () => number | undefined;
    readonly raw: () => string;
    /** Visible rows of the terminal screen, per the embedded oracle. */
    readonly screen: () => readonly string[];
    /** Rows that scrolled past the bottom of the visible screen. */
    readonly scrollback: () => readonly string[];
    /** Resolve with the raw capture once `marker` is present in it. */
    readonly waitFor: (
        marker: string,
        options?: PtyWaitOptions,
    ) => Promise<string>;
    /** Resolve with the child's exit status once the relay reports it. */
    readonly waitForExit: (options?: PtyWaitOptions) => Promise<PtyExitInfo>;
    /** Write raw bytes into the PTY master (the child's stdin). */
    readonly write: (text: string) => void;
    /** Deliver a signal to the child's process group. */
    readonly sendSignal: (name: PtySignalName) => void;
    /** Change the PTY size; the kernel delivers SIGWINCH to the child. */
    readonly resize: (columns: number, rows: number) => void;
    /** Idempotent teardown: kill the child group and the relay helper. */
    readonly close: () => Promise<void>;
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

export const launchPtyCommand = async (
    options: PtyLaunchOptions,
): Promise<PtySession> => {
    const payload = Buffer.from(
        JSON.stringify({
            argv: [...options.command],
            env: options.env ?? {},
            cols: options.columns,
            rows: options.rows,
        } satisfies PtyRelayPayload),
    ).toString("base64");

    const proc = Bun.spawn({
        cmd: ["python3", "-c", PTY_RELAY_PROGRAM, payload],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const sink = proc.stdin as unknown as StdinSink | undefined;

    let raw = "";
    let oracle = new PtyScreen(options.columns, options.rows);
    let childPid: number | undefined;
    let childPgid: number | undefined;
    let exitInfo: PtyExitInfo | undefined;
    let closed = false;
    const markerWaiters: MarkerWaiter[] = [];
    const exitWaiters: ExitWaiter[] = [];
    let stderrBuffer = "";

    const rejectAll = (message: string): void => {
        const error = new Error(message);
        for (const waiter of markerWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        for (const waiter of exitWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    };

    const inspect = (): string => {
        const tail = raw.length > 400 ? `...${raw.slice(-400)}` : raw;
        return `raw tail: ${JSON.stringify(tail)}`;
    };

    const processChunk = (chunk: string): void => {
        raw += chunk;
        oracle.feed(chunk);
        for (const waiter of [...markerWaiters]) {
            if (!raw.includes(waiter.marker)) continue;
            clearTimeout(waiter.timer);
            const index = markerWaiters.indexOf(waiter);
            if (index >= 0) markerWaiters.splice(index, 1);
            waiter.resolve(raw);
        }
    };

    let readyResolve: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
        readyResolve = resolve;
    });

    const handleRelayMessage = (message: { event?: string }): void => {
        if (message.event === "ready") {
            childPid = (message as { childPid?: number }).childPid;
            childPgid = (message as { childPgid?: number }).childPgid;
            readyResolve();
            return;
        }
        if (message.event !== "exit") return;
        const info: PtyExitInfo = {
            code: (message as { code?: number | null }).code ?? null,
            signal: (message as { signal?: string | null }).signal ?? null,
        };
        exitInfo = info;
        for (const waiter of exitWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.resolve(info);
        }
        rejectAll(
            `child exited (code ${String(info.code)}, ` +
                `signal ${String(info.signal)}) before the marker arrived`,
        );
    };

    const stdoutReader = proc.stdout.getReader();
    void (async () => {
        try {
            while (!closed) {
                const { done, value } = await stdoutReader.read();
                if (done) break;
                processChunk(Buffer.from(value).toString("utf8"));
            }
        } catch {
            // Canceled on close; nothing to surface.
        }
    })();

    const drainRelayLines = (): void => {
        while (stderrBuffer.includes("\n")) {
            const newline = stderrBuffer.indexOf("\n");
            const line = stderrBuffer.slice(0, newline);
            stderrBuffer = stderrBuffer.slice(newline + 1);
            try {
                handleRelayMessage(JSON.parse(line) as { event?: string });
            } catch {
                // Not a relay event line; ignore.
            }
        }
    };

    const stderrReader = proc.stderr.getReader();
    void (async () => {
        try {
            while (!closed) {
                const { done, value } = await stderrReader.read();
                if (done) break;
                stderrBuffer += Buffer.from(value).toString("utf8");
                drainRelayLines();
            }
        } catch {
            // Canceled on close; nothing to surface.
        }
    })();

    const sendCommand = (message: Record<string, unknown>): void => {
        if (closed || sink === undefined) return;
        try {
            sink.write(`${JSON.stringify(message)}\n`);
            sink.flush?.();
        } catch {
            // The relay already exited; the close path handles cleanup.
        }
    };

    const swallow = async (
        operation: () => Promise<unknown>,
    ): Promise<void> => {
        try {
            await operation();
        } catch {
            // The relay or its streams are already gone.
        }
    };

    const sessionCleanup = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        rejectAll("PTY session closed.");
        if (childPgid !== undefined && isProcessAlive(childPgid)) {
            try {
                process.kill(-childPgid, "SIGKILL");
            } catch {
                // The group is already gone.
            }
        }
        await swallow(async () => proc.kill(9));
        await swallow(async () => stdoutReader.cancel());
        await swallow(async () => stderrReader.cancel());
        await swallow(() => proc.exited);
    };

    const registerMarkerWait = (
        marker: string,
        timeoutMs: number,
    ): Promise<string> =>
        new Promise<string>((resolve, reject) => {
            if (closed) {
                reject(
                    new Error(
                        `PTY session closed while waiting for ${marker}.`,
                    ),
                );
                return;
            }
            if (raw.includes(marker)) {
                resolve(raw);
                return;
            }
            if (exitInfo !== undefined) {
                reject(
                    new Error(
                        `child exited before marker ${marker}; ` +
                            `exit: ${JSON.stringify(exitInfo)}.`,
                    ),
                );
                return;
            }
            const timer = setTimeout(() => {
                const index = markerWaiters.indexOf(waiter);
                if (index >= 0) markerWaiters.splice(index, 1);
                reject(
                    new Error(
                        `timed out waiting for marker ${marker}. ${inspect()}`,
                    ),
                );
            }, timeoutMs);
            const waiter: MarkerWaiter = { marker, resolve, reject, timer };
            markerWaiters.push(waiter);
        });

    const registerExitWait = (timeoutMs: number): Promise<PtyExitInfo> =>
        new Promise<PtyExitInfo>((resolve, reject) => {
            if (closed) {
                reject(
                    new Error("PTY session closed before the child exited."),
                );
                return;
            }
            if (exitInfo !== undefined) {
                resolve(exitInfo);
                return;
            }
            const timer = setTimeout(() => {
                const index = exitWaiters.indexOf(waiter);
                if (index >= 0) exitWaiters.splice(index, 1);
                reject(
                    new Error(
                        `timed out waiting for the child to exit. ${inspect()}`,
                    ),
                );
            }, timeoutMs);
            const waiter: ExitWaiter = { resolve, reject, timer };
            exitWaiters.push(waiter);
        });

    const relayDiedEarly = proc.exited.then(() => {
        throw new Error(
            `PTY relay exited before reporting readiness. ` +
                `helper stderr: ${JSON.stringify(stderrBuffer)}. ` +
                inspect(),
        );
    });
    const ready = await Promise.race([
        readyPromise,
        relayDiedEarly.then(
            () => undefined,
            (error: unknown) => error,
        ),
        sleep(READY_TIMEOUT_MS).then(() => {
            return new Error(
                `PTY relay did not report readiness within ${READY_TIMEOUT_MS}ms. ` +
                    `helper stderr: ${JSON.stringify(stderrBuffer)}. ` +
                    inspect(),
            );
        }),
    ]);
    if (ready instanceof Error) {
        await sessionCleanup();
        throw ready;
    }

    void proc.exited.then(async (code) => {
        if (closed || exitInfo !== undefined) return;
        // The exit event travels on the helper's stderr pipe; give the
        // reader a short grace period to parse it before declaring failure.
        for (
            let attempt = 0;
            attempt < 20 && exitInfo === undefined;
            attempt += 1
        ) {
            await sleep(50);
        }
        if (closed || exitInfo !== undefined) return;
        rejectAll(
            `PTY relay exited unexpectedly with status ${String(code)} ` +
                `before the child exited. helper stderr: ` +
                `${JSON.stringify(stderrBuffer)}. ${inspect()}`,
        );
    });

    const session: PtySession = {
        helperPid: proc.pid,
        childPid: () => childPid,
        childPgid: () => childPgid,
        raw: () => raw,
        screen: () => oracle.screen(),
        scrollback: () => oracle.scrollback(),
        waitFor: (marker, waitOptions) =>
            registerMarkerWait(
                marker,
                waitOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ),
        waitForExit: (waitOptions) =>
            registerExitWait(waitOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        write: (text) => {
            sendCommand({
                op: "write",
                data: Buffer.from(text, "utf8").toString("base64"),
            });
        },
        sendSignal: (name) => {
            sendCommand({ op: "signal", name });
        },
        resize: (columns, rows) => {
            oracle.resize(columns, rows);
            sendCommand({ op: "resize", cols: columns, rows });
        },
        close: sessionCleanup,
    };

    return session;
};