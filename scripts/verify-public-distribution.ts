#!/usr/bin/env bun

import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../package.json";

type JsonRecord = Record<string, unknown>;

export const REQUIRED_BINARY_ASSETS = [
    "ralphie-darwin-arm64",
    "ralphie-darwin-x64",
    "ralphie-linux-arm64",
    "ralphie-linux-x64",
] as const;

const REQUIRED_RELEASE_ASSETS = [
    ...REQUIRED_BINARY_ASSETS,
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
] as const;

const releaseTagPattern =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sha256Pattern = /^[0-9a-fA-F]{64}$/;
const repositorySlugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repositoryRoot = resolve(import.meta.dir, "..");
const userAgent = "ralphie-public-distribution-check";

export type DistributionTopology = {
    readonly branch: string;
    readonly description: string;
    readonly formulaUrl: string;
    readonly homepage: string;
    readonly image: string;
    readonly npmPackageUrl: string;
    readonly rawInstallerUrl: string;
    readonly releasesUrl: string;
    readonly repositoryUrl: string;
    readonly slug: string;
    readonly topics: ReadonlyArray<string>;
};

type ReleaseAsset = {
    readonly browserDownloadUrl: string;
    readonly name: string;
};

type LatestRelease = {
    readonly assets: ReadonlyArray<ReleaseAsset>;
    readonly tag: string;
    readonly version: string;
};

type VerifyOptions = {
    readonly help: boolean;
    readonly skipMetadata: boolean;
};

type RegistryDescriptor = {
    readonly digest: string;
    readonly platform?: JsonRecord;
};

const fail = (message: string): never => {
    throw new Error(`Public distribution verification: ${message}`);
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const recordFrom = (value: unknown, label: string): JsonRecord => {
    if (!isRecord(value)) return fail(`${label} is not a JSON object.`);
    return value;
};

const valueFrom = (record: JsonRecord, key: string, label: string): unknown => {
    const value = record[key];
    if (value === undefined) return fail(`${label} is missing '${key}'.`);
    return value;
};

const stringFrom = (record: JsonRecord, key: string, label: string): string => {
    const value = valueFrom(record, key, label);
    if (typeof value !== "string" || value.length === 0) {
        return fail(`${label} has no non-empty string '${key}'.`);
    }
    return value;
};

const extract = (text: string, pattern: RegExp, label: string): string => {
    const match = text.match(pattern);
    const value = match?.[1];
    if (value === undefined || value.length === 0) {
        return fail(`topology document has no ${label}.`);
    }
    return value;
};

const extractTopics = (text: string): ReadonlyArray<string> => {
    const topicText = extract(
        text,
        /^- topics:\s*([\s\S]*?)(?=\n\n)/m,
        "repository topics",
    );
    const topics = [...topicText.matchAll(/`([^`]+)`/g)].map(
        (match) => match[1] as string,
    );
    if (topics.length === 0) return fail("topology document has no topics.");
    return topics;
};

/** Parse the canonical endpoint and metadata contract from the topology doc. */
export const parseTopology = (text: string): DistributionTopology => {
    const slug = extract(
        text,
        /- canonical slug: `([^`]+)`;/,
        "canonical slug",
    );
    if (!repositorySlugPattern.test(slug)) {
        return fail(`canonical slug '${slug}' is not owner/repository.`);
    }

    const repositoryUrl = extract(
        text,
        /- repository: <(https:\/\/github\.com\/[^>]+)>;/,
        "repository URL",
    );
    const releasesUrl = extract(
        text,
        /- releases and native assets: <(https:\/\/github\.com\/[^>]+)>;/,
        "release URL",
    );
    const rawInstallerUrl = extract(
        text,
        /- raw installer: <(https:\/\/raw\.githubusercontent\.com\/[^>]+)>;/,
        "raw installer URL",
    );
    const formulaUrl = extract(
        text,
        /- Homebrew formula source: <(https:\/\/raw\.githubusercontent\.com\/[^>]+)>;/,
        "formula URL",
    );
    const image = extract(text, /- OCI image: `([^`]+)`;/, "OCI image");
    const npmPackageUrl = extract(
        text,
        /- npm package: <(https:\/\/www\.npmjs\.com\/[^>]+)>[.;]?/,
        "npm package URL",
    );
    const description = extract(
        text,
        /^- description: `([^`]+)`;/m,
        "repository description",
    );
    const homepage = extract(
        text,
        /^- homepage: <([^>]+)>;/m,
        "repository homepage",
    );

    const rawMatch = rawInstallerUrl.match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/scripts\/install\.sh$/,
    );
    const formulaMatch = formulaUrl.match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/Formula\/ralphie\.rb$/,
    );
    const branch = rawMatch?.[2];
    const formulaBranch = formulaMatch?.[2];
    if (
        rawMatch?.[1] !== slug ||
        formulaMatch?.[1] !== slug ||
        branch === undefined ||
        formulaBranch === undefined
    ) {
        return fail(
            "raw installer and formula URLs do not use the canonical slug.",
        );
    }
    if (branch !== formulaBranch) {
        return fail("raw installer and formula URLs do not use one branch.");
    }
    if (repositoryUrl !== `https://github.com/${slug}`) {
        return fail("repository URL does not match the canonical slug.");
    }
    if (releasesUrl !== `${repositoryUrl}/releases`) {
        return fail("release URL does not match the canonical repository.");
    }
    if (image !== `ghcr.io/${slug}`) {
        return fail("OCI image does not match the canonical slug.");
    }

    return {
        branch,
        description,
        formulaUrl,
        homepage,
        image,
        npmPackageUrl,
        rawInstallerUrl,
        releasesUrl,
        repositoryUrl,
        slug,
        topics: extractTopics(text),
    };
};

const readRequiredFile = async (
    path: string,
    label: string,
): Promise<string> => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read ${label}: ${message}`);
    }
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const isTransientStatus = (status: number): boolean =>
    status === 408 || status === 429 || status >= 500;

const fetchPublicOnce = async (
    url: string,
    init: RequestInit,
    headers: Headers,
    label: string,
): Promise<Response> => {
    try {
        return await fetch(url, {
            ...init,
            headers,
            redirect: "follow",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${label} could not be fetched: ${message}`);
    }
};

const requestPublic = async (
    url: string,
    init: RequestInit = {},
    label = url,
): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (headers.has("authorization")) {
        return fail(`${label} attempted to use an Authorization header.`);
    }
    headers.set("User-Agent", userAgent);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetchPublicOnce(url, init, headers, label);
        if (response.ok) return response;
        const status = response.status;
        await response.body?.cancel();
        if (attempt < 2 && isTransientStatus(status)) {
            await sleep(500 * (attempt + 1));
            continue;
        }
        return fail(`${label} returned HTTP ${status}.`);
    }
    return fail(`${label} could not be fetched.`);
};

const jsonFromResponse = async (
    response: Response,
    label: string,
): Promise<unknown> => {
    const body = await response.text();
    try {
        return JSON.parse(body) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${label} returned invalid JSON: ${message}`);
    }
};

const fetchPublicJson = async (url: string, label: string): Promise<unknown> =>
    jsonFromResponse(
        await requestPublic(
            url,
            { headers: { Accept: "application/vnd.github+json" } },
            label,
        ),
        label,
    );

const fetchPublicText = async (url: string, label: string): Promise<string> =>
    requestPublic(url, undefined, label).then((response) => response.text());

const assertCredentialsUnset = (): void => {
    const configured = ["GH_TOKEN", "GITHUB_TOKEN"].filter(
        (name) => (process.env[name] ?? "").trim().length > 0,
    );
    if (configured.length > 0) {
        return fail(
            `requires anonymous access; unset ${configured.join(" and ")} before running.`,
        );
    }
};

const verifyRepositoryMetadata = async (
    topology: DistributionTopology,
): Promise<void> => {
    const record = recordFrom(
        await fetchPublicJson(
            `https://api.github.com/repos/${topology.slug}`,
            "repository metadata",
        ),
        "repository metadata",
    );
    if (record.private !== false || record.visibility !== "public") {
        return fail("canonical repository is not public.");
    }
    if (record.description !== topology.description) {
        return fail(
            `repository description is '${String(record.description)}', expected '${topology.description}'.`,
        );
    }
    if (record.homepage !== topology.homepage) {
        return fail(
            `repository homepage is '${String(record.homepage)}', expected '${topology.homepage}'.`,
        );
    }
    const topics = valueFrom(record, "topics", "repository metadata");
    if (
        !Array.isArray(topics) ||
        topics.some((topic) => typeof topic !== "string")
    ) {
        return fail("repository metadata has no valid topics list.");
    }
    const missingTopics = topology.topics.filter(
        (topic) => !topics.includes(topic),
    );
    if (missingTopics.length > 0) {
        return fail(
            `repository metadata is missing topics: ${missingTopics.join(", ")}.`,
        );
    }
};

const requiredReadmeLinks = (
    topology: DistributionTopology,
): ReadonlyArray<string> => [
    `${topology.releasesUrl}/latest`,
    topology.releasesUrl,
    topology.rawInstallerUrl,
    topology.formulaUrl,
    topology.repositoryUrl,
    `https://${topology.image}`,
    `${topology.repositoryUrl}/blob/${topology.branch}/LICENSE`,
    topology.npmPackageUrl,
];

const rawLicenseUrlFor = (topology: DistributionTopology): string =>
    `https://raw.githubusercontent.com/${topology.slug}/${topology.branch}/LICENSE`;

const verifyReadme = async (
    topology: DistributionTopology,
    root: string,
): Promise<void> => {
    const readme = await readRequiredFile(join(root, "README.md"), "README");
    for (const link of requiredReadmeLinks(topology)) {
        if (!readme.includes(link))
            return fail(`README is missing canonical link ${link}.`);
    }
    const normalizedReadme = readme.replace(/\s+/g, " ");
    for (const phrase of [
        "macOS",
        "Linux",
        "arm64",
        "x64",
        "v<major>.<minor>.<patch>",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "Public artifacts do not require GitHub credentials",
    ]) {
        if (!normalizedReadme.includes(phrase)) {
            return fail(
                `README is missing public distribution detail '${phrase}'.`,
            );
        }
    }
};

const releaseAssetFrom = (
    value: unknown,
    index: number,
    topology: DistributionTopology,
    tag: string,
): ReleaseAsset => {
    const record = recordFrom(value, `release asset ${index + 1}`);
    const name = stringFrom(record, "name", `release asset ${index + 1}`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        return fail(`release asset '${name}' has an unsafe name.`);
    }
    const browserDownloadUrl = stringFrom(
        record,
        "browser_download_url",
        `release asset ${name}`,
    );
    const expectedUrl = `${topology.repositoryUrl}/releases/download/${tag}/${name}`;
    if (browserDownloadUrl !== expectedUrl) {
        return fail(
            `release asset '${name}' points to '${browserDownloadUrl}', expected '${expectedUrl}'.`,
        );
    }
    return { browserDownloadUrl, name };
};

const readOneByte = async (
    response: Response,
    label: string,
): Promise<void> => {
    if (response.body === null) return fail(`${label} returned no body.`);
    const reader = response.body.getReader();
    try {
        const first = await reader.read();
        if (
            first.done ||
            first.value === undefined ||
            first.value.byteLength === 0
        ) {
            return fail(`${label} returned an empty body.`);
        }
    } finally {
        await reader.cancel();
    }
};

const assertDownloadable = async (
    url: string,
    label: string,
): Promise<void> => {
    const response = await requestPublic(
        url,
        { headers: { Accept: "*/*", Range: "bytes=0-0" } },
        label,
    );
    await readOneByte(response, label);
};

const verifyChecksumManifest = (manifest: string, version: string): void => {
    const lines = manifest
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    if (lines.length !== REQUIRED_BINARY_ASSETS.length) {
        return fail(
            `SHA256SUMS for ${version} has ${lines.length} entries, expected ${REQUIRED_BINARY_ASSETS.length}.`,
        );
    }
    const entries = new Map<string, string>();
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (
            parts.length !== 2 ||
            parts[1] === undefined ||
            !sha256Pattern.test(parts[0] ?? "")
        ) {
            return fail(`SHA256SUMS has a malformed line '${line}'.`);
        }
        if (entries.has(parts[1]))
            return fail(`SHA256SUMS duplicates '${parts[1]}'.`);
        entries.set(parts[1], parts[0] as string);
    }
    for (const asset of REQUIRED_BINARY_ASSETS) {
        if (!entries.has(asset))
            return fail(`SHA256SUMS is missing '${asset}'.`);
    }
};

const verifyLatestRelease = async (
    topology: DistributionTopology,
): Promise<LatestRelease> => {
    const record = recordFrom(
        await fetchPublicJson(
            `https://api.github.com/repos/${topology.slug}/releases/latest`,
            "latest release",
        ),
        "latest release",
    );
    const tag = stringFrom(record, "tag_name", "latest release");
    const match = tag.match(releaseTagPattern);
    if (match === null) return fail(`latest release has invalid tag '${tag}'.`);
    if (record.draft !== false || record.prerelease !== false) {
        return fail("latest release is a draft or prerelease.");
    }
    const htmlUrl = stringFrom(record, "html_url", "latest release");
    if (htmlUrl !== `${topology.repositoryUrl}/releases/tag/${tag}`) {
        return fail("latest release points to a non-canonical release page.");
    }
    const rawAssets = valueFrom(record, "assets", "latest release");
    if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
        return fail("latest release has no assets.");
    }
    const assets = rawAssets.map((asset, index) =>
        releaseAssetFrom(asset, index, topology, tag),
    );
    const names = new Set(assets.map((asset) => asset.name));
    if (names.size !== assets.length) {
        return fail("latest release contains duplicate asset names.");
    }
    const missing = REQUIRED_RELEASE_ASSETS.filter(
        (asset) => !names.has(asset),
    );
    if (missing.length > 0) {
        return fail(`latest release is missing assets: ${missing.join(", ")}.`);
    }
    await Promise.all(
        assets.map((asset) =>
            assertDownloadable(
                asset.browserDownloadUrl,
                `release asset ${asset.name}`,
            ),
        ),
    );
    const checksums = assets.find((asset) => asset.name === "SHA256SUMS");
    const bundle = assets.find(
        (asset) => asset.name === "SHA256SUMS.sigstore.json",
    );
    if (checksums === undefined || bundle === undefined) {
        return fail("latest release has no checksum or Sigstore asset.");
    }
    verifyChecksumManifest(
        await fetchPublicText(checksums.browserDownloadUrl, "SHA256SUMS"),
        match[0],
    );
    const bundleRecord = recordFrom(
        JSON.parse(
            await fetchPublicText(bundle.browserDownloadUrl, "Sigstore bundle"),
        ) as unknown,
        "Sigstore bundle",
    );
    recordFrom(
        valueFrom(bundleRecord, "verificationMaterial", "Sigstore bundle"),
        "Sigstore verification material",
    );
    return { assets, tag, version: match[0].slice(1) };
};

const normalizeFormulaUrl = (url: string, version: string): string =>
    url.replaceAll("#{version}", version);

const verifyFormula = async (
    topology: DistributionTopology,
    release: LatestRelease,
): Promise<void> => {
    const formula = await fetchPublicText(
        topology.formulaUrl,
        "Homebrew formula",
    );
    const version = extract(
        formula,
        /^\s*version\s+"([^"]+)"/m,
        "formula version",
    );
    if (version !== release.version) {
        return fail(
            `Homebrew formula is version ${version}, expected ${release.version}.`,
        );
    }
    if (!formula.includes(`homepage "${topology.repositoryUrl}"`)) {
        return fail("Homebrew formula has a non-canonical homepage.");
    }
    if (!formula.includes('license "MIT"'))
        return fail("Homebrew formula has no MIT license.");
    const urls = [...formula.matchAll(/^\s*url\s+"([^"]+)"/gm)].map((match) =>
        normalizeFormulaUrl(match[1] as string, release.version),
    );
    const expectedUrls = REQUIRED_BINARY_ASSETS.map(
        (asset) =>
            `${topology.repositoryUrl}/releases/download/${release.tag}/${asset}`,
    );
    const actual = [...new Set(urls)].sort();
    const expected = [...expectedUrls].sort();
    if (
        actual.length !== expected.length ||
        actual.some((url, index) => url !== expected[index])
    ) {
        return fail(
            "Homebrew formula URLs do not cover the four canonical release assets.",
        );
    }
    await Promise.all(
        urls.map((url) => assertDownloadable(url, `Homebrew asset ${url}`)),
    );
};

const verifyLicense = async (
    topology: DistributionTopology,
    root: string,
): Promise<void> => {
    const localLicense = await readRequiredFile(
        join(root, "LICENSE"),
        "LICENSE",
    );
    if (!localLicense.startsWith("MIT License\n"))
        return fail("LICENSE is not the MIT license text.");
    if (packageJson.license !== "MIT")
        return fail("package.json does not declare MIT.");
    const dockerfile = await readRequiredFile(
        join(root, "Dockerfile"),
        "Dockerfile",
    );
    if (!dockerfile.includes('org.opencontainers.image.licenses="MIT"')) {
        return fail("Dockerfile does not declare the MIT OCI license label.");
    }
    const licenseUrl = `${topology.repositoryUrl}/blob/${topology.branch}/LICENSE`;
    const metadata = recordFrom(
        await fetchPublicJson(
            `https://api.github.com/repos/${topology.slug}/license`,
            "GitHub license metadata",
        ),
        "GitHub license metadata",
    );
    const license = recordFrom(
        valueFrom(metadata, "license", "GitHub license metadata"),
        "GitHub license metadata",
    );
    if (license.spdx_id !== "MIT")
        return fail("GitHub does not report the MIT license.");
    const rawLicenseUrl = rawLicenseUrlFor(topology);
    if (metadata.download_url !== rawLicenseUrl) {
        return fail(
            "GitHub license metadata has a non-canonical download URL.",
        );
    }
    if (metadata.html_url !== licenseUrl)
        return fail("GitHub license metadata has a non-canonical page URL.");
    const remoteLicense = await fetchPublicText(
        rawLicenseUrl,
        "public LICENSE",
    );
    if (!remoteLicense.startsWith("MIT License\n"))
        return fail("public LICENSE is not the MIT license text.");
};

const registryRequest = async (
    url: string,
    accept: string,
    token?: string,
): Promise<Response> => {
    const headers = new Headers({ Accept: accept, "User-Agent": userAgent });
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    try {
        return await fetch(url, { headers, redirect: "follow" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`OCI registry request failed: ${message}`);
    }
};

const challengeParameters = (challenge: string): Map<string, string> => {
    const parameters = new Map<string, string>();
    const match = challenge.match(/^Bearer\s+(.+)$/i);
    if (match === null) return parameters;
    const body = match[1];
    if (body === undefined) return parameters;
    for (const parameter of body.matchAll(
        /([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g,
    )) {
        const key = parameter[1];
        const value = parameter[2];
        if (key !== undefined && value !== undefined)
            parameters.set(key, value);
    }
    return parameters;
};

const registryToken = async (response: Response): Promise<string> => {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const parameters = challengeParameters(challenge);
    const realm = parameters.get("realm");
    const service = parameters.get("service");
    const scope = parameters.get("scope");
    if (realm === undefined || service === undefined || scope === undefined) {
        return fail(
            "OCI registry did not provide an anonymous Bearer challenge.",
        );
    }
    const tokenUrl = new URL(realm);
    tokenUrl.searchParams.set("service", service);
    tokenUrl.searchParams.set("scope", scope);
    const tokenResponse = await requestPublic(
        tokenUrl.toString(),
        { headers: { Accept: "application/json" } },
        "OCI anonymous token endpoint",
    );
    const tokenRecord = recordFrom(
        await jsonFromResponse(tokenResponse, "OCI anonymous token endpoint"),
        "OCI anonymous token endpoint",
    );
    const token = tokenRecord.token ?? tokenRecord.access_token;
    if (typeof token !== "string" || token.length === 0) {
        return fail("OCI anonymous token endpoint returned no token.");
    }
    return token;
};

const registryJson = async (
    url: string,
    accept: string,
    label: string,
): Promise<unknown> => {
    const first = await registryRequest(url, accept);
    if (first.ok) return jsonFromResponse(first, label);
    if (first.status !== 401)
        return fail(`${label} returned HTTP ${first.status}.`);
    await first.body?.cancel();
    const token = await registryToken(first);
    const authorized = await registryRequest(url, accept, token);
    if (!authorized.ok)
        return fail(
            `${label} returned HTTP ${authorized.status} after anonymous token exchange.`,
        );
    return jsonFromResponse(authorized, label);
};

const descriptorFrom = (value: unknown, label: string): RegistryDescriptor => {
    const record = recordFrom(value, label);
    const digest = stringFrom(record, "digest", label);
    const platformValue = record.platform;
    if (platformValue === undefined) return { digest };
    return { digest, platform: recordFrom(platformValue, `${label} platform`) };
};

const verifyImageConfig = (manifest: JsonRecord, label: string): string => {
    const config = recordFrom(
        valueFrom(manifest, "config", label),
        `${label} config descriptor`,
    );
    const digest = stringFrom(config, "digest", `${label} config descriptor`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
        return fail(`${label} has an invalid config digest.`);
    return digest;
};

const inspectImageManifest = async (
    manifest: JsonRecord,
    expectedVersion: string,
    topology: DistributionTopology,
    baseUrl: string,
    label: string,
): Promise<void> => {
    const configDigest = verifyImageConfig(manifest, label);
    const config = recordFrom(
        await registryJson(
            `${baseUrl}/blobs/${configDigest}`,
            "application/json",
            `${label} config blob`,
        ),
        `${label} config blob`,
    );
    const imageConfig = recordFrom(
        valueFrom(config, "config", `${label} config blob`),
        `${label} image config`,
    );
    const labels = recordFrom(
        valueFrom(imageConfig, "Labels", `${label} image config`),
        `${label} image labels`,
    );
    if (labels["org.opencontainers.image.licenses"] !== "MIT") {
        return fail(`${label} does not report the MIT OCI license label.`);
    }
    if (labels["org.opencontainers.image.source"] !== topology.repositoryUrl) {
        return fail(`${label} does not report the canonical OCI source.`);
    }
    if (labels["org.opencontainers.image.version"] !== expectedVersion) {
        return fail(
            `${label} reports version '${String(labels["org.opencontainers.image.version"])}', expected '${expectedVersion}'.`,
        );
    }
};

const verifyImageTag = async (
    topology: DistributionTopology,
    tag: string,
    expectedVersion: string,
): Promise<void> => {
    const baseUrl = `https://ghcr.io/v2/${topology.image}`;
    const manifest = recordFrom(
        await registryJson(
            `${baseUrl}/manifests/${tag}`,
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
            `OCI manifest ${tag}`,
        ),
        `OCI manifest ${tag}`,
    );
    const rawDescriptors = manifest.manifests;
    if (!Array.isArray(rawDescriptors) || rawDescriptors.length === 0) {
        await inspectImageManifest(
            manifest,
            expectedVersion,
            topology,
            baseUrl,
            `OCI image ${tag}`,
        );
        return;
    }
    const descriptors = rawDescriptors.map((descriptor, index) =>
        descriptorFrom(
            descriptor,
            `OCI manifest ${tag} descriptor ${index + 1}`,
        ),
    );
    const requiredPlatforms = [
        ["linux", "amd64"],
        ["linux", "arm64"],
    ] as const;
    for (const [os, architecture] of requiredPlatforms) {
        const descriptor = descriptors.find(
            (candidate) =>
                candidate.platform?.os === os &&
                candidate.platform.architecture === architecture,
        );
        if (descriptor === undefined) {
            return fail(
                `OCI image ${tag} has no ${os}/${architecture} manifest.`,
            );
        }
        const child = recordFrom(
            await registryJson(
                `${baseUrl}/manifests/${descriptor.digest}`,
                "application/vnd.oci.image.manifest.v1+json",
                `OCI ${tag} ${os}/${architecture} manifest`,
            ),
            `OCI ${tag} ${os}/${architecture} manifest`,
        );
        await inspectImageManifest(
            child,
            expectedVersion,
            topology,
            baseUrl,
            `OCI image ${tag} ${os}/${architecture}`,
        );
    }
};

const environmentWithoutGithubCredentials = (): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (name === "GH_TOKEN" || name === "GITHUB_TOKEN") continue;
        if (value !== undefined) environment[name] = value;
    }
    return environment;
};

const outputFrom = (value: Uint8Array | null | undefined): string =>
    value === null || value === undefined
        ? ""
        : new TextDecoder().decode(value);

const verifyInstaller = async (
    topology: DistributionTopology,
    release: LatestRelease,
): Promise<void> => {
    const installer = await fetchPublicText(
        topology.rawInstallerUrl,
        "raw installer",
    );
    if (!installer.startsWith("#!/usr/bin/env sh"))
        return fail("raw installer has no shell entrypoint.");
    if (
        !installer.includes(
            `api.github.com/repos/${topology.slug}/releases/latest`,
        )
    ) {
        return fail("raw installer does not use the canonical release API.");
    }
    const root = await mkdtemp(join(tmpdir(), "ralphie-public-distribution-"));
    try {
        const home = join(root, "home");
        const destination = join(root, "bin");
        const installerPath = join(root, "install.sh");
        await mkdir(home, { recursive: true });
        await writeFile(installerPath, installer, { mode: 0o755 });
        await chmod(installerPath, 0o755);
        const environment = environmentWithoutGithubCredentials();
        environment.HOME = home;
        environment.RALPHIE_VERSION = release.version;
        const result = Bun.spawnSync(["/bin/sh", installerPath, destination], {
            cwd: root,
            env: environment,
            stderr: "pipe",
            stdout: "pipe",
        });
        const stdout = outputFrom(result.stdout);
        const stderr = outputFrom(result.stderr);
        if (result.exitCode !== 0) {
            return fail(
                `temporary installer failed with exit code ${result.exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            );
        }
        const executable = join(destination, "ralphie");
        try {
            await access(executable);
        } catch {
            return fail(
                "temporary installer did not create the ralphie executable.",
            );
        }
        const versionResult = Bun.spawnSync([executable, "--version"], {
            cwd: root,
            env: environment,
            stderr: "pipe",
            stdout: "pipe",
        });
        const reportedVersion = outputFrom(versionResult.stdout).trim();
        if (
            versionResult.exitCode !== 0 ||
            reportedVersion !== release.version
        ) {
            return fail(
                `temporary installer produced version '${reportedVersion}', expected '${release.version}'.`,
            );
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
};

const parseOptions = (args: ReadonlyArray<string>): VerifyOptions => {
    let help = false;
    let skipMetadata = false;
    for (const argument of args) {
        if (argument === "--help" || argument === "-h") {
            help = true;
        } else if (argument === "--skip-metadata") {
            skipMetadata = true;
        } else {
            return fail(`unknown option '${argument}'.`);
        }
    }
    return { help, skipMetadata };
};

const usage = `Usage: bun run verify:public-distribution [--skip-metadata]

Checks the canonical public repository, latest release, every release asset,
installer, Homebrew formula, OCI image, and MIT license without GitHub
credentials. --skip-metadata is only for local development while the remote
repository description/homepage/topics are being configured.`;

const main = async (): Promise<void> => {
    const options = parseOptions(Bun.argv.slice(2));
    if (options.help) {
        console.log(usage);
        return;
    }
    assertCredentialsUnset();
    const topology = parseTopology(
        await readRequiredFile(
            join(repositoryRoot, "docs/public-distribution.md"),
            "public distribution topology",
        ),
    );
    if (!options.skipMetadata) await verifyRepositoryMetadata(topology);
    await verifyReadme(topology, repositoryRoot);
    const release = await verifyLatestRelease(topology);
    await verifyInstaller(topology, release);
    await verifyFormula(topology, release);
    await verifyLicense(topology, repositoryRoot);
    await verifyImageTag(topology, release.version, release.version);
    await verifyImageTag(topology, "latest", release.version);
    console.log(
        `Anonymous public distribution verification passed for ${topology.slug} ${release.tag}.`,
    );
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}