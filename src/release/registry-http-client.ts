import { RalphieError } from "../shared/error.ts";
import {
    isContentDigest,
    manifestDigest,
    RegistryMalformedResponseError,
    RegistryRequestError,
    WRITABLE_MANIFEST_MEDIA_TYPES,
    type ManifestMediaType,
    type RegistryClient,
    type RegistryManifestPutResult,
    type RegistryManifestReferenceState,
    type RegistryPushedBlob,
} from "./registry-reconcile.ts";

export type OciRegistryHttpClientOptions = {
    /** Registry base URL, for example `https://ghcr.io`. */
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
    readonly fetchImpl?: typeof fetch;
};

const MANIFEST_ACCEPT = WRITABLE_MANIFEST_MEDIA_TYPES.join(", ");

const normalizeBaseUrl = (baseUrl: string): string => {
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new RalphieError({
            message: `Invalid registry base URL: ${baseUrl}.`,
        });
    }
    if (parsed.username !== "" || parsed.password !== "") {
        throw new RalphieError({
            message: `Registry base URL must not embed credentials: ${baseUrl}.`,
        });
    }
    if (
        parsed.protocol === "http:" &&
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1"
    ) {
        throw new RalphieError({
            message: `Refusing plain-HTTP registry base URL ${baseUrl}: only https or a loopback http:// fixture is allowed.`,
        });
    }
    return parsed.toString().replace(/\/$/, "");
};

const repositoryFromPath = (pathname: string): string | undefined => {
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
    return `${segments[1]}/${segments[2]}`;
};

const scopeFor = (repository: string | undefined): string =>
    repository === undefined ? "" : `repository:${repository}:pull,push`;

type BearerChallenge = {
    readonly realm: string;
    readonly service?: string;
    readonly scope?: string;
};

const parseAuthParameters = (
    text: string,
): Readonly<Record<string, string>> => {
    const parameters: Record<string, string> = {};
    for (const pair of text.split(",")) {
        const match =
            /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/.exec(
                pair,
            );
        if (match !== null) {
            parameters[match[1] ?? ""] = match[2] ?? match[3] ?? "";
        }
    }
    return parameters;
};

const parseBearerChallenge = (
    header: string | null,
    baseUrl: string,
): BearerChallenge => {
    if (header === null) {
        throw new RegistryMalformedResponseError({
            message: "Registry did not advertise a WWW-Authenticate challenge.",
        });
    }
    const match = /^bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) {
        throw new RegistryMalformedResponseError({
            message: `Registry challenge is not a Bearer challenge: ${header}.`,
        });
    }
    const parameters = parseAuthParameters(match[1] ?? "");
    const realm = parameters["realm"];
    if (realm === undefined || realm.length === 0) {
        throw new RegistryMalformedResponseError({
            message: `Registry challenge is missing its realm: ${header}.`,
        });
    }
    return {
        realm: new URL(realm, baseUrl).toString(),
        service: parameters["service"],
        scope: parameters["scope"],
    };
};

/**
 * OCI Distribution HTTP client for GHCR-style registries. Requests are
 * authenticated with a Bearer token obtained from the registry's `WWW-
 * Authenticate` challenge. `putManifest` always sends `If-None-Match: *` —
 * there is no unconditional tag write in this client — and returns a CAS
 * rejection (409/412) as status data while throwing on every other failure.
 */
export class OciRegistryHttpClient implements RegistryClient {
    readonly #baseUrl: string;
    readonly #username: string;
    readonly #password: string;
    readonly #fetch: typeof fetch;
    readonly #tokens = new Map<string, string>();

    constructor(options: OciRegistryHttpClientOptions) {
        this.#baseUrl = normalizeBaseUrl(options.baseUrl);
        this.#username = options.username;
        this.#password = options.password;
        this.#fetch = options.fetchImpl ?? globalThis.fetch;
    }

    async inspectManifestReference(
        repository: string,
        reference: string,
    ): Promise<RegistryManifestReferenceState> {
        const response = await this.request(
            `/v2/${repository}/manifests/${encodeURIComponent(reference)}`,
            { method: "GET", headers: { accept: MANIFEST_ACCEPT } },
        );
        if (response.status === 404) return { kind: "missing" };
        if (!response.ok) {
            throw new RegistryRequestError({
                message: `Cannot inspect ${repository}:${reference}: registry answered HTTP ${response.status}.`,
            });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = manifestDigest(bytes);
        const header = response.headers.get("docker-content-digest");
        if (header !== null && header !== digest) {
            throw new RegistryMalformedResponseError({
                message: `Registry reported digest ${header} for ${repository}:${reference} but the manifest body digests to ${digest}.`,
            });
        }
        return {
            kind: "present",
            digest,
            bytes,
            mediaType: response.headers.get("content-type") ?? undefined,
        };
    }

    async putManifest(
        repository: string,
        reference: string,
        manifestBytes: Uint8Array,
        mediaType: ManifestMediaType,
    ): Promise<RegistryManifestPutResult> {
        const response = await this.request(
            `/v2/${repository}/manifests/${encodeURIComponent(reference)}`,
            {
                method: "PUT",
                headers: {
                    "content-type": mediaType,
                    "if-none-match": "*",
                },
                body: manifestBytes,
            },
        );
        const header = response.headers.get("docker-content-digest");
        if (header !== null && !isContentDigest(header)) {
            throw new RegistryMalformedResponseError({
                message: `Registry returned a malformed digest header '${header}' for the put of ${repository}:${reference}.`,
            });
        }
        return { status: response.status, digest: header ?? undefined };
    }

    async deleteManifestReference(
        repository: string,
        reference: string,
    ): Promise<void> {
        const response = await this.request(
            `/v2/${repository}/manifests/${encodeURIComponent(reference)}`,
            { method: "DELETE" },
        );
        if (
            response.status !== 202 &&
            response.status !== 204 &&
            response.status !== 404
        ) {
            throw new RegistryRequestError({
                message: `Cannot delete ${repository}:${reference}: registry answered HTTP ${response.status}.`,
            });
        }
    }

    async blobExists(repository: string, digest: string): Promise<boolean> {
        const response = await this.request(
            `/v2/${repository}/blobs/${digest}`,
            {
                method: "HEAD",
            },
        );
        if (response.status === 200) return true;
        if (response.status === 404) return false;
        throw new RegistryRequestError({
            message: `Cannot check blob ${repository}:${digest}: registry answered HTTP ${response.status}.`,
        });
    }

    async pushBlob(
        repository: string,
        bytes: Uint8Array,
    ): Promise<RegistryPushedBlob> {
        const digest = manifestDigest(bytes);
        if (await this.blobExists(repository, digest)) {
            return { size: bytes.byteLength, digest };
        }
        const start = await this.request(`/v2/${repository}/blobs/uploads/`, {
            method: "POST",
        });
        if (start.status !== 202) {
            throw new RegistryRequestError({
                message: `Blob upload session for ${repository} failed with HTTP ${start.status}.`,
            });
        }
        const location = start.headers.get("location");
        if (location === null) {
            throw new RegistryMalformedResponseError({
                message:
                    "Blob upload response did not include a Location header.",
            });
        }
        const uploadUrl = new URL(location, this.#baseUrl);
        uploadUrl.searchParams.set("digest", digest);
        const finish = await this.request(
            uploadUrl.pathname + uploadUrl.search,
            {
                method: "PUT",
                body: bytes,
            },
        );
        if (finish.status !== 201) {
            throw new RegistryRequestError({
                message: `Blob upload for ${repository} failed with HTTP ${finish.status}.`,
            });
        }
        return { size: bytes.byteLength, digest };
    }

    private async request(path: string, init: RequestInit): Promise<Response> {
        const scope = scopeFor(
            repositoryFromPath(new URL(path, this.#baseUrl).pathname),
        );
        let response = await this.authorizedRequest(path, init, scope);
        if (response.status === 401) {
            this.#tokens.delete(scope);
            response = await this.authorizedRequest(path, init, scope);
        }
        return response;
    }

    private async authorizedRequest(
        path: string,
        init: RequestInit,
        scope: string,
    ): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${await this.token(scope)}`);
        return this.#fetch(new URL(path, this.#baseUrl), { ...init, headers });
    }

    private async token(scope: string): Promise<string> {
        const cached = this.#tokens.get(scope);
        if (cached !== undefined) return cached;
        const challengeResponse = await this.#fetch(`${this.#baseUrl}/v2/`, {
            method: "GET",
        });
        if (challengeResponse.status !== 401) {
            throw new RegistryRequestError({
                message: `Registry /v2/ must challenge with 401 before token issuance, got HTTP ${challengeResponse.status}.`,
            });
        }
        const challenge = parseBearerChallenge(
            challengeResponse.headers.get("www-authenticate"),
            this.#baseUrl,
        );
        const effectiveScope = challenge.scope ?? scope;
        const cachedForEffective = this.#tokens.get(effectiveScope);
        if (cachedForEffective !== undefined) return cachedForEffective;
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service !== undefined) {
            tokenUrl.searchParams.set("service", challenge.service);
        }
        tokenUrl.searchParams.set("scope", effectiveScope);
        const basic = `Basic ${Buffer.from(
            `${this.#username}:${this.#password}`,
        ).toString("base64")}`;
        const tokenResponse = await this.#fetch(tokenUrl, {
            method: "GET",
            headers: { authorization: basic },
        });
        if (!tokenResponse.ok) {
            throw new RegistryRequestError({
                message: `Registry token request failed with HTTP ${tokenResponse.status}.`,
            });
        }
        const payload = (await tokenResponse.json()) as {
            token?: unknown;
            access_token?: unknown;
        };
        const token =
            typeof payload.token === "string"
                ? payload.token
                : typeof payload.access_token === "string"
                  ? payload.access_token
                  : undefined;
        if (token === undefined) {
            throw new RegistryMalformedResponseError({
                message:
                    "Registry token response did not include a token or access_token field.",
            });
        }
        this.#tokens.set(effectiveScope, token);
        return token;
    }
}

export const createOciRegistryHttpClient = (
    options: OciRegistryHttpClientOptions,
): RegistryClient => new OciRegistryHttpClient(options);