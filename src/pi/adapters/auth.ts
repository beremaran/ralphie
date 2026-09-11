import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
    AuthOperationOptions,
    Credential,
    CredentialInfo,
    CredentialStore,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

const AUTH_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = {
    retries: 8,
    factor: 1.5,
    minTimeout: 20,
    maxTimeout: 500,
    randomize: true,
} as const;

type AuthFileData = Record<string, Credential>;

const isErrorCode = (cause: unknown, code: string): boolean =>
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === code;

/**
 * Credential store backed by pi's `auth.json`.
 *
 * Pi write precedence is preserved: a stored credential owns its provider and
 * environment variables are only consulted when nothing is stored. Writes are
 * serialized in-process and guarded with a cross-process file lock so a
 * concurrent pi session cannot double-refresh a rotating OAuth token.
 */
export class FileCredentialStore implements CredentialStore {
    private readonly path: string;
    private tail: Promise<unknown> = Promise.resolve();

    constructor(options: { readonly path: string }) {
        this.path = options.path;
    }

    async read(
        providerId: string,
        options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
        options?.signal?.throwIfAborted();
        const data = await this.load();
        return data[providerId];
    }

    async list(
        options?: AuthOperationOptions,
    ): Promise<readonly CredentialInfo[]> {
        options?.signal?.throwIfAborted();
        const data = await this.load();
        return Object.entries(data).map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
        }));
    }

    async modify(
        providerId: string,
        fn: (
            current: Credential | undefined,
        ) => Promise<Credential | undefined>,
        options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
        return await this.enqueue(
            async () =>
                await this.withLock(async () => {
                    const data = await this.load();
                    const current = data[providerId];
                    const next = await fn(current);
                    if (next === undefined) return current;
                    data[providerId] = next;
                    await this.write(data);
                    return next;
                }, options),
        );
    }

    async delete(
        providerId: string,
        options?: AuthOperationOptions,
    ): Promise<void> {
        await this.enqueue(
            async () =>
                await this.withLock(async () => {
                    const data = await this.load();
                    if (!(providerId in data)) return;
                    delete data[providerId];
                    await this.write(data);
                }, options),
        );
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        this.tail = result.catch(() => undefined);
        return result;
    }

    private async withLock<T>(
        task: () => Promise<T>,
        options?: AuthOperationOptions,
    ): Promise<T> {
        options?.signal?.throwIfAborted();
        await this.ensureFile();
        const release = await lockfile.lock(this.path, {
            realpath: false,
            stale: LOCK_STALE_MS,
            retries: LOCK_RETRIES,
        });
        try {
            options?.signal?.throwIfAborted();
            return await task();
        } finally {
            await release().catch(() => undefined);
        }
    }

    private async ensureFile(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
            await access(this.path);
        } catch {
            await writeFile(this.path, "{}\n", {
                ...AUTH_WRITE_OPTIONS,
                flag: "wx",
            }).catch((cause: unknown) => {
                if (!isErrorCode(cause, "EEXIST")) throw cause;
            });
        }
    }

    private async load(): Promise<AuthFileData> {
        try {
            const raw = await readFile(this.path, "utf-8");
            const text = raw.replace(/^\uFEFF/, "");
            if (text.trim() === "") return {};
            const parsed = JSON.parse(text) as unknown;
            if (
                parsed === null ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
            ) {
                throw new Error("auth.json must contain a JSON object.");
            }
            return parsed as AuthFileData;
        } catch (cause) {
            if (isErrorCode(cause, "ENOENT")) return {};
            throw new Error(
                `Failed to read the pi credential store at ${this.path}.`,
                { cause },
            );
        }
    }

    private async write(data: AuthFileData): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
        await writeFile(
            temporary,
            `${JSON.stringify(data, null, 2)}\n`,
            AUTH_WRITE_OPTIONS,
        );
        await rename(temporary, this.path);
    }
}