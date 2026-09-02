/**
 * Deterministic loopback fake for GHCR-style OCI Distribution registries.
 *
 * The fixture mirrors `src/github/rest-fixture.ts`: it serves the exact
 * distribution endpoints exercised by `OciRegistryHttpClient` (Bearer token
 * challenge, manifest reads/writes/deletes, blob reads and single-shot
 * uploads) over an ephemeral loopback port, keeps state in memory, and
 * records every observation. Behavior knobs model registries that ignore or
 * reject conditional writes, answer create conflicts with 409 instead of 412,
 * misstate digests, validate referenced content, deny authenticated requests,
 * or fail blob uploads — the fail-closed cases the create-only contract
 * must survive. One-shot `onceBeforePut` / `onceBeforeRead` hooks let tests
 * simulate a writer racing between inspection and write.
 *
 * Unrecognized paths are answered loudly so an accidental request can never
 * be forwarded to a real registry.
 */

import { randomBytes } from "node:crypto";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

import { manifestDigest } from "./registry-reconcile.ts";

export type RegistryFixtureOptions = {
    /** PUT ignores If-None-Match and overwrites an existing reference. */
    readonly ignoreConditionalHeaders?: boolean;
    /** Conditional writes are unsupported (405), modeling no CAS operation. */
    readonly rejectConditionalWrites?: boolean;
    /** An existing-tag create conflict answers 409 instead of 412. */
    readonly conflictOnExistingCreate?: boolean;
    /** Manifest responses carry a malformed `Docker-Content-Digest`. */
    readonly misstateDigest?: boolean;
    /** Manifest writes validate referenced blobs/child manifests first. */
    readonly validateReferencedContent?: boolean;
    /** Authenticated registry requests fail with 403 (auth failure). */
    readonly denyAuthorizedRequests?: boolean;
    /** Blob upload finishes fail with 500. */
    readonly failBlobUploads?: boolean;
    /** Force this status for every manifest read. */
    readonly forcedManifestReadStatus?: number;
    /** Force this status for every manifest write. */
    readonly forcedManifestPutStatus?: number;
};

export type RegistryFixtureObservation = {
    readonly method: string;
    /** Request target exactly as received (path plus query string). */
    readonly path: string;
    readonly authorization: string | undefined;
    readonly ifNoneMatch: string | undefined;
    readonly contentType: string | undefined;
    readonly bodyBytes: number;
};

export type RegistryFixtureManifestView = {
    readonly digest: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
};

export type RegistryFixture = {
    readonly baseUrl: string;
    readonly close: () => Promise<void>;
    /** Clear state, observations, and pending hooks. */
    readonly reset: () => void;
    readonly observations: () => ReadonlyArray<RegistryFixtureObservation>;
    readonly takeObservations: () => ReadonlyArray<RegistryFixtureObservation>;
    /** Directly store a tag (and its content address), bypassing the wire. */
    readonly setTag: (
        repository: string,
        reference: string,
        bytes: Uint8Array,
        mediaType: string,
    ) => RegistryFixture;
    /** Directly store a blob, bypassing the wire. */
    readonly setBlob: (
        repository: string,
        digest: string,
        bytes: Uint8Array,
    ) => RegistryFixture;
    readonly tag: (
        repository: string,
        reference: string,
    ) => RegistryFixtureManifestView | undefined;
    readonly blob: (
        repository: string,
        digest: string,
    ) => Uint8Array | undefined;
    /**
     * One-shot hook invoked at the start of the next manifest PUT, before the
     * compare-and-swap check and store — the inspection-to-write race window.
     */
    readonly onceBeforePut: (hook: () => void) => RegistryFixture;
    /** One-shot hook invoked at the start of the next manifest read. */
    readonly onceBeforeRead: (hook: () => void) => RegistryFixture;
};

export const REGISTRY_FIXTURE_USERNAME = "ralphie-fixture";
export const REGISTRY_FIXTURE_PASSWORD = "ralphie-fixture-token";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const isDigestReference = (reference: string): boolean =>
    DIGEST_PATTERN.test(reference);

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

type FixtureManifest = {
    readonly digest: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
};

type FixtureState = {
    /** `repository#reference` keyed tag entries. */
    readonly tags: Map<string, FixtureManifest>;
    /** `repository#digest` keyed content-addressed entries. */
    readonly content: Map<string, FixtureManifest>;
    /** `repository#digest` keyed blobs. */
    readonly blobs: Map<string, Uint8Array>;
};

type FixtureHooks = {
    readonly beforePut: Array<() => void>;
    readonly beforeRead: Array<() => void>;
};

type RegistryTarget = {
    readonly repository: string;
    readonly reference: string;
};

const keyOf = (repository: string, reference: string): string =>
    `${repository}#${reference}`;

const createFixtureState = (): FixtureState => ({
    tags: new Map(),
    content: new Map(),
    blobs: new Map(),
});

const readManifest = (
    state: FixtureState,
    repository: string,
    reference: string,
): FixtureManifest | undefined => {
    if (isDigestReference(reference)) {
        return state.content.get(keyOf(repository, reference));
    }
    return state.tags.get(keyOf(repository, reference));
};

const manifestTarget = (pathname: string): RegistryTarget | undefined => {
    const segments = pathname
        .split("/")
        .filter((segment) => segment.length > 0);
    if (
        segments[0] !== "v2" ||
        segments[1] === undefined ||
        segments[2] === undefined
    ) {
        return undefined;
    }
    if (segments[3] !== "manifests" || segments[4] === undefined) {
        return undefined;
    }
    return {
        repository: `${segments[1]}/${segments[2]}`,
        reference: segments[4],
    };
};

const blobTarget = (pathname: string): RegistryTarget | undefined => {
    const segments = pathname
        .split("/")
        .filter((segment) => segment.length > 0);
    if (
        segments[0] !== "v2" ||
        segments[1] === undefined ||
        segments[2] === undefined
    ) {
        return undefined;
    }
    if (segments[3] !== "blobs" || segments[4] === undefined) {
        return undefined;
    }
    return {
        repository: `${segments[1]}/${segments[2]}`,
        reference: segments[4],
    };
};

const uploadTarget = (pathname: string): string | undefined => {
    const segments = pathname
        .split("/")
        .filter((segment) => segment.length > 0);
    if (
        segments[0] !== "v2" ||
        segments[1] === undefined ||
        segments[2] === undefined
    ) {
        return undefined;
    }
    if (segments[3] !== "blobs" || segments[4] !== "uploads") {
        return undefined;
    }
    return `${segments[1]}/${segments[2]}`;
};

const challengeHeader = (baseUrl: string): string =>
    `Bearer realm="${baseUrl}/token",service="ghcr-fixture"`;

const readBody = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        request.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_REQUEST_BODY_BYTES) {
                reject(new Error("Registry fixture request body too large."));
                request.pause();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });

const respondEmpty = (
    response: ServerResponse,
    status: number,
    headers: Record<string, string> = {},
): void => {
    response.writeHead(status, { connection: "close", ...headers });
    response.end();
};

const respondBytes = (
    response: ServerResponse,
    status: number,
    bytes: Uint8Array,
    headers: Record<string, string> = {},
): void => {
    response.writeHead(status, {
        "content-length": bytes.byteLength,
        connection: "close",
        ...headers,
    });
    response.end(Buffer.from(bytes));
};

const respondJson = (
    response: ServerResponse,
    status: number,
    value: unknown,
): void => {
    const text = JSON.stringify(value);
    respondBytes(response, status, new TextEncoder().encode(text), {
        "content-type": "application/json; charset=utf-8",
    });
};

const digestHeaderFor = (
    state: FixtureState,
    existing: FixtureManifest | undefined,
    options: RegistryFixtureOptions,
    bytes: Uint8Array,
): string => {
    if (options.misstateDigest) return "not-a-digest";
    return (existing ?? { digest: manifestDigest(bytes) }).digest;
};

const referencedDigests = (bytes: Uint8Array): ReadonlyArray<string> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
        return [];
    }
    const record = parsed as Record<string, unknown>;
    const required: string[] = [];
    const appendDigest = (item: unknown): void => {
        const digest =
            item !== null && typeof item === "object"
                ? (item as Record<string, unknown>)["digest"]
                : undefined;
        if (typeof digest === "string") required.push(digest);
    };
    appendDigest(record["config"]);
    const layers = record["layers"];
    if (Array.isArray(layers)) {
        for (const layer of layers) appendDigest(layer);
    }
    const manifests = record["manifests"];
    if (Array.isArray(manifests)) {
        for (const child of manifests) appendDigest(child);
    }
    return required;
};

const referencedContentMissing = (
    state: FixtureState,
    repository: string,
    bytes: Uint8Array,
): boolean =>
    referencedDigests(bytes).some(
        (digest) =>
            !state.blobs.has(keyOf(repository, digest)) &&
            !state.content.has(keyOf(repository, digest)),
    );

const storeManifest = (
    state: FixtureState,
    repository: string,
    reference: string,
    bytes: Uint8Array,
    digest: string,
    mediaType: string,
): FixtureManifest => {
    const entry: FixtureManifest = { digest, bytes, mediaType };
    state.tags.set(keyOf(repository, reference), entry);
    state.content.set(keyOf(repository, digest), entry);
    return entry;
};

type HandleRequestInput = {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly state: FixtureState;
    readonly hooks: FixtureHooks;
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
    readonly options: RegistryFixtureOptions;
    readonly observations: RegistryFixtureObservation[];
    /** Request body read exactly once at dispatch time. */
    readonly body: Uint8Array;
};

/** Dispatch input before the request body has been read. */
type UnreadRequestInput = Omit<HandleRequestInput, "body">;

const handleTokenRequest = (input: HandleRequestInput): void => {
    const expected = `Basic ${Buffer.from(
        `${input.username}:${input.password}`,
    ).toString("base64")}`;
    if (input.request.headers.authorization !== expected) {
        respondJson(input.response, 401, {
            errors: [
                { code: "UNAUTHORIZED", message: "authentication required" },
            ],
        });
        return;
    }
    respondJson(input.response, 200, {
        token: `fixture-token-${randomBytes(8).toString("hex")}`,
    });
};

const handleManifestRead = (input: HandleRequestInput): void => {
    input.hooks.beforeRead.shift()?.();
    if (input.options.forcedManifestReadStatus !== undefined) {
        respondEmpty(input.response, input.options.forcedManifestReadStatus);
        return;
    }
    const target = manifestTarget(
        new URL(input.request.url ?? "/", input.baseUrl).pathname,
    );
    if (target === undefined) {
        respondJson(input.response, 500, {
            message:
                "Local registry fixture rejected an unknown manifest path.",
        });
        return;
    }
    const existing = readManifest(
        input.state,
        target.repository,
        target.reference,
    );
    const digest = digestHeaderFor(
        input.state,
        existing,
        input.options,
        new Uint8Array(),
    );
    if (existing === undefined) {
        respondEmpty(input.response, 404);
        return;
    }
    const method = (input.request.method ?? "GET").toUpperCase();
    const headers = {
        "docker-content-digest": digest,
        "content-type": existing.mediaType,
    };
    if (method === "HEAD") {
        respondEmpty(input.response, 200, headers);
        return;
    }
    respondBytes(input.response, 200, existing.bytes, headers);
};

const applyPutFailures = async (
    input: HandleRequestInput,
    target: RegistryTarget,
    bytes: Uint8Array,
): Promise<boolean> => {
    if (input.options.forcedManifestPutStatus !== undefined) {
        respondEmpty(input.response, input.options.forcedManifestPutStatus);
        return false;
    }
    const digest = manifestDigest(bytes);
    if (isDigestReference(target.reference) && target.reference !== digest) {
        respondJson(input.response, 400, {
            errors: [
                {
                    code: "DIGEST_INVALID",
                    message: `Digest ${target.reference} does not match the manifest content ${digest}.`,
                },
            ],
        });
        return false;
    }
    if (
        input.options.validateReferencedContent &&
        referencedContentMissing(input.state, target.repository, bytes)
    ) {
        respondJson(input.response, 400, {
            errors: [
                {
                    code: "MANIFEST_INVALID",
                    message:
                        "The manifest references content that does not exist.",
                },
            ],
        });
        return false;
    }
    return true;
};

const handleManifestPut = async (input: HandleRequestInput): Promise<void> => {
    const target = manifestTarget(
        new URL(input.request.url ?? "/", input.baseUrl).pathname,
    );
    if (target === undefined) {
        respondJson(input.response, 500, {
            message:
                "Local registry fixture rejected an unknown manifest path.",
        });
        return;
    }
    const bytes = input.body;
    input.hooks.beforePut.shift()?.();
    if (!(await applyPutFailures(input, target, bytes))) return;
    const digest = manifestDigest(bytes);
    const existing = readManifest(
        input.state,
        target.repository,
        target.reference,
    );
    if (input.options.ignoreConditionalHeaders) {
        // The registry accepts and overwrites regardless of the guard.
    } else if (input.options.rejectConditionalWrites) {
        respondEmpty(input.response, 405);
        return;
    } else if (existing !== undefined) {
        if (input.request.headers["if-none-match"] === "*") {
            respondEmpty(
                input.response,
                input.options.conflictOnExistingCreate ? 409 : 412,
            );
            return;
        }
        // A raw registry would overwrite; this contract's client always
        // sends the guard, so this branch is unreachable from the client.
    }
    const entry = storeManifest(
        input.state,
        target.repository,
        target.reference,
        bytes,
        digest,
        input.request.headers["content-type"] ?? "application/octet-stream",
    );
    const responseHeaders = {
        "docker-content-digest": digestHeaderFor(
            input.state,
            entry,
            input.options,
            bytes,
        ),
        "content-type": entry.mediaType,
    };
    respondEmpty(input.response, 201, responseHeaders);
};

const handleManifestDelete = (input: HandleRequestInput): void => {
    const target = manifestTarget(
        new URL(input.request.url ?? "/", input.baseUrl).pathname,
    );
    if (target === undefined) {
        respondJson(input.response, 500, {
            message:
                "Local registry fixture rejected an unknown manifest path.",
        });
        return;
    }
    const existing = readManifest(
        input.state,
        target.repository,
        target.reference,
    );
    if (existing === undefined) {
        respondEmpty(input.response, 404);
        return;
    }
    input.state.tags.delete(keyOf(target.repository, target.reference));
    if (isDigestReference(target.reference)) {
        input.state.content.delete(keyOf(target.repository, target.reference));
    }
    respondEmpty(input.response, 202);
};

const handleBlobHeadOrGet = (input: HandleRequestInput): void => {
    const target = blobTarget(
        new URL(input.request.url ?? "/", input.baseUrl).pathname,
    );
    if (target === undefined) {
        respondJson(input.response, 500, {
            message: "Local registry fixture rejected an unknown blob path.",
        });
        return;
    }
    const bytes = input.state.blobs.get(
        keyOf(target.repository, target.reference),
    );
    const method = (input.request.method ?? "GET").toUpperCase();
    if (bytes === undefined) {
        respondEmpty(input.response, 404);
        return;
    }
    if (method === "HEAD") {
        respondEmpty(input.response, 200, {
            "docker-content-digest": target.reference,
        });
        return;
    }
    respondBytes(input.response, 200, bytes, {
        "docker-content-digest": target.reference,
    });
};

const handleUploadStart = (input: HandleRequestInput): void => {
    const target = uploadTarget(
        new URL(input.request.url ?? "/", input.baseUrl).pathname,
    );
    if (target === undefined) {
        respondJson(input.response, 500, {
            message: "Local registry fixture rejected an unknown upload path.",
        });
        return;
    }
    const id = randomBytes(8).toString("hex");
    respondEmpty(input.response, 202, {
        location: `/v2/${target}/blobs/uploads/${id}`,
    });
};

const handleUploadFinish = async (input: HandleRequestInput): Promise<void> => {
    const url = new URL(input.request.url ?? "/", input.baseUrl);
    const target = uploadTarget(url.pathname);
    if (target === undefined) {
        respondJson(input.response, 500, {
            message: "Local registry fixture rejected an unknown upload path.",
        });
        return;
    }
    if (input.options.failBlobUploads) {
        respondJson(input.response, 500, {
            message: "Local registry fixture forced a blob upload failure.",
        });
        return;
    }
    const bytes = input.body;
    const digest = url.searchParams.get("digest");
    if (digest === null || digest !== manifestDigest(bytes)) {
        respondJson(input.response, 400, {
            errors: [{ code: "DIGEST_INVALID", message: "digest mismatch" }],
        });
        return;
    }
    input.state.blobs.set(keyOf(target, digest), bytes);
    respondEmpty(input.response, 201, {
        "docker-content-digest": digest,
    });
};

const dispatchUnprotected = async (
    input: HandleRequestInput,
    method: string,
    url: URL,
): Promise<boolean> => {
    if (method === "GET" && url.pathname === "/v2/") {
        respondEmpty(input.response, 401, {
            "www-authenticate": challengeHeader(input.baseUrl),
        });
        return true;
    }
    if (method === "GET" && url.pathname === "/token") {
        handleTokenRequest(input);
        return true;
    }
    return false;
};

const dispatchManifestRoute = async (
    input: HandleRequestInput,
    method: string,
    url: URL,
): Promise<boolean> => {
    if (
        !url.pathname.startsWith("/v2/") ||
        !url.pathname.includes("/manifests/")
    ) {
        return false;
    }
    if (method === "PUT") {
        await handleManifestPut(input);
        return true;
    }
    if (method === "DELETE") {
        handleManifestDelete(input);
        return true;
    }
    if (method === "GET" || method === "HEAD") {
        handleManifestRead(input);
        return true;
    }
    return false;
};

const dispatchBlobRoute = async (
    input: HandleRequestInput,
    method: string,
    url: URL,
): Promise<boolean> => {
    if (!url.pathname.startsWith("/v2/") || !url.pathname.includes("/blobs/")) {
        return false;
    }
    if (url.pathname.endsWith("/uploads/") && method === "POST") {
        handleUploadStart(input);
        return true;
    }
    if (url.pathname.includes("/uploads/") && method === "PUT") {
        await handleUploadFinish(input);
        return true;
    }
    if (method === "GET" || method === "HEAD") {
        handleBlobHeadOrGet(input);
        return true;
    }
    return false;
};

const handleRegistryRequest = async (
    input: UnreadRequestInput,
): Promise<void> => {
    const method = (input.request.method ?? "GET").toUpperCase();
    const requestUrl = input.request.url ?? "/";
    const url = new URL(requestUrl, input.baseUrl);
    const body = await readBody(input.request);
    input.observations.push({
        method,
        path: requestUrl,
        authorization: input.request.headers.authorization,
        ifNoneMatch: input.request.headers["if-none-match"],
        contentType: input.request.headers["content-type"],
        bodyBytes: body.byteLength,
    });
    const routed: HandleRequestInput = {
        ...input,
        body: new Uint8Array(body),
    };
    if (await dispatchUnprotected(routed, method, url)) return;
    if (routed.options.denyAuthorizedRequests) {
        respondEmpty(routed.response, 403);
        return;
    }
    if (routed.request.headers.authorization === undefined) {
        respondEmpty(routed.response, 401, {
            "www-authenticate": challengeHeader(routed.baseUrl),
        });
        return;
    }
    if (await dispatchManifestRoute(routed, method, url)) return;
    if (await dispatchBlobRoute(routed, method, url)) return;
    respondJson(routed.response, 500, {
        message: `Local registry fixture rejected ${method} ${url.pathname}: no fixture route serves this endpoint.`,
    });
};

/** Start a deterministic fake OCI registry on an ephemeral loopback port. */
export const startRegistryFixture = async (
    options: RegistryFixtureOptions = {},
): Promise<RegistryFixture> => {
    const state = createFixtureState();
    const hooks: FixtureHooks = { beforePut: [], beforeRead: [] };
    const observations: RegistryFixtureObservation[] = [];
    let baseUrl = "";
    let fixture: RegistryFixture;

    const server: Server = createServer((request, response) => {
        handleRegistryRequest({
            request,
            response,
            state,
            hooks,
            baseUrl,
            username: REGISTRY_FIXTURE_USERNAME,
            password: REGISTRY_FIXTURE_PASSWORD,
            options,
            observations,
        }).catch((error) => {
            if (response.writableEnded || response.destroyed) return;
            respondJson(response, 500, {
                message: `Local registry fixture failed: ${String(error)}`,
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error(
            "Local registry fixture could not bind a loopback port.",
        );
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    fixture = {
        baseUrl,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        },
        reset: () => {
            observations.length = 0;
            hooks.beforePut.length = 0;
            hooks.beforeRead.length = 0;
            state.tags.clear();
            state.content.clear();
            state.blobs.clear();
        },
        observations: () => [...observations],
        takeObservations: () => observations.splice(0, observations.length),
        setTag: (repository, reference, bytes, mediaType) => {
            storeManifest(
                state,
                repository,
                reference,
                bytes,
                manifestDigest(bytes),
                mediaType,
            );
            return fixture;
        },
        setBlob: (repository, digest, bytes) => {
            state.blobs.set(keyOf(repository, digest), bytes);
            return fixture;
        },
        tag: (repository, reference) => {
            const entry = readManifest(state, repository, reference);
            return entry === undefined ? undefined : { ...entry };
        },
        blob: (repository, digest) =>
            state.blobs.get(keyOf(repository, digest)),
        onceBeforePut: (hook) => {
            hooks.beforePut.push(hook);
            return fixture;
        },
        onceBeforeRead: (hook) => {
            hooks.beforeRead.push(hook);
            return fixture;
        },
    };
    return fixture;
};