import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createOciRegistryHttpClient } from "../../src/release/registry-http-client.ts";
import {
    DOCKER_MANIFEST_LIST_MEDIA_TYPE,
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
    manifestDigest,
    OCI_IMAGE_INDEX_MEDIA_TYPE,
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    probeCreateOnlyPublishing,
    reconcileManifestTag,
    RegistryCapabilityProbeError,
    RegistryConflictError,
    RegistryMalformedResponseError,
    RegistryRequestError,
    RegistryWriteGuardError,
    WRITABLE_MANIFEST_MEDIA_TYPES,
    type RegistryClient,
} from "../../src/release/registry-reconcile.ts";
import {
    REGISTRY_FIXTURE_PASSWORD,
    REGISTRY_FIXTURE_USERNAME,
    startRegistryFixture,
    type RegistryFixture,
} from "../../src/release/registry-fixture.ts";

const REPOSITORY = "beremaran/ralphie";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A valid-shaped OCI image manifest whose referenced blobs are not pushed. */
const ociImageManifest = (annotation: string): Uint8Array =>
    text(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            config: {
                mediaType: OCI_CONFIG,
                size: 2,
                digest: `sha256:${"1".repeat(64)}`,
            },
            layers: [
                {
                    mediaType: OCI_LAYER,
                    size: 3,
                    digest: `sha256:${"2".repeat(64)}`,
                },
            ],
            annotations: { "org.opencontainers.image.title": annotation },
        }),
    );

const ociIndexManifest = (
    children: ReadonlyArray<ReadonlyArray<number>>,
): Uint8Array =>
    text(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
            manifests: children.map((byteLengths, index) => ({
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                size: byteLengths.length,
                digest: `sha256:${String(index + 3).repeat(64)}`,
                platform: {
                    architecture: index === 0 ? "amd64" : "arm64",
                    os: "linux",
                },
            })),
            annotations: {},
        }),
    );

const clientFor = (fixture: RegistryFixture): RegistryClient =>
    createOciRegistryHttpClient({
        baseUrl: fixture.baseUrl,
        username: REGISTRY_FIXTURE_USERNAME,
        password: REGISTRY_FIXTURE_PASSWORD,
    });

const manifestCalls = (
    fixture: RegistryFixture,
): ReadonlyArray<{ readonly method: string; readonly path: string }> =>
    fixture
        .observations()
        .filter((observation) =>
            observation.path.startsWith(`/v2/${REPOSITORY}/manifests/`),
        )
        .map((observation) => ({
            method: observation.method,
            path: observation.path,
        }));

const verifyProbe = async (fixture: RegistryFixture, nonce: string) => {
    const probe = await probeCreateOnlyPublishing(clientFor(fixture), {
        repository: REPOSITORY,
        nonce,
    });
    expect(probe.verified).toBe(true);
    expect(probe.repository).toBe(REPOSITORY);
    return probe;
};

describe("reconcileManifestTag", () => {
    let fixture: RegistryFixture;
    let client: RegistryClient;

    beforeEach(async () => {
        fixture = await startRegistryFixture();
        client = clientFor(fixture);
    });

    afterEach(async () => {
        await fixture.close();
    });

    test("inspects a missing (404) tag first, then conditional-put and verified reread", async () => {
        const probe = await verifyProbe(fixture, "one");
        fixture.takeObservations();
        const intended = ociImageManifest("intended");
        const digest = manifestDigest(intended);

        const result = await reconcileManifestTag(client, {
            repository: REPOSITORY,
            reference: "0.1.2-amd64",
            manifestBytes: intended,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            expectedDigest: digest,
            verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
        });

        expect(result).toEqual({ kind: "created" });
        const calls = manifestCalls(fixture);
        expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
        expect(calls[1]?.path).toContain("/manifests/0.1.2-amd64");
        const put = fixture
            .observations()
            .find(
                (observation) =>
                    observation.method === "PUT" &&
                    observation.path.includes("/manifests/0.1.2-amd64"),
            );
        expect(put?.ifNoneMatch).toBe("*");
        expect(put?.contentType).toBe(OCI_IMAGE_MANIFEST_MEDIA_TYPE);
        expect(fixture.tag(REPOSITORY, "0.1.2-amd64")?.digest).toBe(digest);
    });

    test("reuses an existing tag whose exact serialized digest matches without writing", async () => {
        const probe = await verifyProbe(fixture, "two");
        fixture.takeObservations();
        const intended = ociImageManifest("reused");
        const digest = manifestDigest(intended);
        fixture.setTag(
            REPOSITORY,
            "0.1.2",
            intended,
            OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        );

        const result = await reconcileManifestTag(client, {
            repository: REPOSITORY,
            reference: "0.1.2",
            manifestBytes: intended,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            expectedDigest: digest,
            verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
        });

        expect(result).toEqual({ kind: "reused" });
        expect(
            manifestCalls(fixture).filter((call) => call.method === "PUT"),
        ).toHaveLength(0);
    });

    test("rejects a tag whose digest differs without writing", async () => {
        const probe = await verifyProbe(fixture, "three");
        fixture.takeObservations();
        const intended = ociImageManifest("intended");
        const expectedDigest = manifestDigest(intended);
        fixture.setTag(
            REPOSITORY,
            "0.2.0",
            ociImageManifest("something-else"),
            OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        );

        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.2.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest,
                verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
            }),
        ).rejects.toThrow(RegistryConflictError);
        expect(
            manifestCalls(fixture).filter((call) => call.method === "PUT"),
        ).toHaveLength(0);
    });

    test("rejects an index with the same two child digests but different bytes", async () => {
        const probe = await verifyProbe(fixture, "four");
        fixture.takeObservations();
        const childrenA = ociIndexManifest([
            [111, 222, 333],
            [444, 555],
        ]);
        const childrenB = ociIndexManifest([
            [444, 555],
            [111, 222, 333],
        ]);
        expect(manifestDigest(childrenA)).not.toBe(manifestDigest(childrenB));
        // The existing tag holds the differently-ordered index; the intended
        // promotion is the exact serialized index digest of bytes A.
        fixture.setTag(
            REPOSITORY,
            "0.3.0",
            childrenB,
            OCI_IMAGE_INDEX_MEDIA_TYPE,
        );

        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.3.0",
                manifestBytes: childrenA,
                mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
                expectedDigest: manifestDigest(childrenA),
                verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
            }),
        ).rejects.toThrow(RegistryConflictError);
        expect(
            manifestCalls(fixture).filter((call) => call.method === "PUT"),
        ).toHaveLength(0);
    });

    test("accepts a create race answered with 412 after rereading the exact intended digest", async () => {
        const probe = await verifyProbe(fixture, "five");
        fixture.takeObservations();
        const intended = ociImageManifest("racer-intended");
        const digest = manifestDigest(intended);
        // A competing writer creates the tag between inspection and write.
        fixture.onceBeforePut(() =>
            fixture.setTag(
                REPOSITORY,
                "0.4.0",
                intended,
                OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            ),
        );

        const result = await reconcileManifestTag(client, {
            repository: REPOSITORY,
            reference: "0.4.0",
            manifestBytes: intended,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            expectedDigest: digest,
            verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
        });

        expect(result).toEqual({ kind: "created" });
        expect(fixture.tag(REPOSITORY, "0.4.0")?.digest).toBe(digest);
        const calls = manifestCalls(fixture);
        expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
    });

    test("accepts a create race answered with 409 when the reread matches the intended digest", async () => {
        fixture = await startRegistryFixture({
            conflictOnExistingCreate: true,
        });
        client = clientFor(fixture);
        const probe = await verifyProbe(fixture, "six");
        fixture.takeObservations();
        const intended = ociImageManifest("racer-409");
        const digest = manifestDigest(intended);
        fixture.onceBeforePut(() =>
            fixture.setTag(
                REPOSITORY,
                "0.4.1",
                intended,
                OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            ),
        );

        const result = await reconcileManifestTag(client, {
            repository: REPOSITORY,
            reference: "0.4.1",
            manifestBytes: intended,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            expectedDigest: digest,
            verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
        });

        expect(result).toEqual({ kind: "created" });
        expect(fixture.tag(REPOSITORY, "0.4.1")?.digest).toBe(digest);
    });

    test("fails a create race whose reread shows a different digest", async () => {
        const probe = await verifyProbe(fixture, "seven");
        fixture.takeObservations();
        const intended = ociImageManifest("intended");
        const digest = manifestDigest(intended);
        fixture.onceBeforePut(() =>
            fixture.setTag(
                REPOSITORY,
                "0.5.0",
                ociImageManifest("racer-different"),
                OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            ),
        );

        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.5.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: digest,
                verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
            }),
        ).rejects.toThrow(RegistryConflictError);
        expect(fixture.tag(REPOSITORY, "0.5.0")?.digest).not.toBe(digest);
    });

    test("fails when a writer replaces the tag between the conditional put and the reread", async () => {
        const probe = await verifyProbe(fixture, "eight");
        fixture.takeObservations();
        const intended = ociImageManifest("intended");
        const digest = manifestDigest(intended);
        // The initial inspection reads 404; the verification reread observes
        // the tag hijacked by a racing writer.
        fixture
            .onceBeforeRead(() => undefined)
            .onceBeforeRead(() =>
                fixture.setTag(
                    REPOSITORY,
                    "0.5.1",
                    ociImageManifest("hijacked"),
                    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                ),
            );

        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.5.1",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: digest,
                verifiedCreateOnlyMediaTypes: new Set(probe.verifiedMediaTypes),
            }),
        ).rejects.toThrow(RegistryConflictError);
    });

    test("refuses to create when the media type was not probe-verified", async () => {
        const intended = ociImageManifest("guarded");
        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.6.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: manifestDigest(intended),
                verifiedCreateOnlyMediaTypes: new Set(),
            }),
        ).rejects.toThrow(RegistryWriteGuardError);
        expect(
            manifestCalls(fixture).filter((call) => call.method === "PUT"),
        ).toHaveLength(0);
    });

    test("propagates registry request failures during inspection", async () => {
        fixture = await startRegistryFixture({ denyAuthorizedRequests: true });
        client = clientFor(fixture);
        const intended = ociImageManifest("intended");
        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.7.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: manifestDigest(intended),
                verifiedCreateOnlyMediaTypes: new Set(
                    WRITABLE_MANIFEST_MEDIA_TYPES,
                ),
            }),
        ).rejects.toThrow(RegistryRequestError);
    });

    test("propagates unexpected statuses from the create write", async () => {
        fixture = await startRegistryFixture({ forcedManifestPutStatus: 500 });
        client = clientFor(fixture);
        const intended = ociImageManifest("intended");
        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.8.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: manifestDigest(intended),
                verifiedCreateOnlyMediaTypes: new Set(
                    WRITABLE_MANIFEST_MEDIA_TYPES,
                ),
            }),
        ).rejects.toThrow(RegistryRequestError);
    });

    test("fails closed on malformed digest responses", async () => {
        fixture = await startRegistryFixture({ misstateDigest: true });
        client = clientFor(fixture);
        const intended = ociImageManifest("intended");
        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.9.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: manifestDigest(intended),
                verifiedCreateOnlyMediaTypes: new Set(
                    WRITABLE_MANIFEST_MEDIA_TYPES,
                ),
            }),
        ).rejects.toThrow(RegistryMalformedResponseError);
    });

    test("requires the expected digest to match the supplied bytes", async () => {
        const intended = ociImageManifest("intended");
        await expect(
            reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: "0.10.0",
                manifestBytes: intended,
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                expectedDigest: manifestDigest(ociImageManifest("other")),
                verifiedCreateOnlyMediaTypes: new Set(
                    WRITABLE_MANIFEST_MEDIA_TYPES,
                ),
            }),
        ).rejects.toThrow(/digest to/);
        expect(
            manifestCalls(fixture).filter((call) => call.method === "PUT"),
        ).toHaveLength(0);
    });
});

describe("probeCreateOnlyPublishing", () => {
    let fixture: RegistryFixture;

    beforeEach(async () => {
        fixture = await startRegistryFixture();
    });

    afterEach(async () => {
        await fixture.close();
    });

    test("verifies all four writable media types and cleans up probe tags", async () => {
        const probe = await verifyProbe(fixture, "probe-all");

        expect(probe.verifiedMediaTypes).toEqual([
            OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
            OCI_IMAGE_INDEX_MEDIA_TYPE,
            DOCKER_MANIFEST_LIST_MEDIA_TYPE,
        ]);
        const verified = probe.entries.filter(
            (entry) => entry.outcome === "verified",
        );
        expect(verified).toHaveLength(4);
        for (const entry of verified) {
            expect(entry.competingWriteStatus).toBe(412);
            expect(entry.unchangedDigest).toBe(entry.primaryDigest);
            expect(entry.competingDigest).not.toBe(entry.primaryDigest);
            expect(entry.probeTag).toContain("probe-all");
        }
        // Every probe tag is deleted after verification.
        for (const entry of verified) {
            expect(fixture.tag(REPOSITORY, entry.probeTag)).toBeUndefined();
        }
    });

    test("treats 409 as a valid create-only rejection", async () => {
        fixture = await startRegistryFixture({
            conflictOnExistingCreate: true,
        });
        const probe = await verifyProbe(fixture, "probe-409");
        for (const entry of probe.entries) {
            expect(entry.outcome).toBe("verified");
            if (entry.outcome === "verified") {
                expect(entry.competingWriteStatus).toBe(409);
                expect(entry.unchangedDigest).toBe(entry.primaryDigest);
            }
        }
    });

    test("publishes referenced blobs and child manifests before writing tags", async () => {
        fixture = await startRegistryFixture({
            validateReferencedContent: true,
        });
        const probe = await verifyProbe(fixture, "probe-content");
        expect(
            probe.entries.some(
                (entry) =>
                    entry.outcome === "verified" &&
                    entry.mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE,
            ),
        ).toBe(true);
    });

    test("fails closed when the registry accepts the competing write", async () => {
        fixture = await startRegistryFixture({
            ignoreConditionalHeaders: true,
        });
        await expect(
            probeCreateOnlyPublishing(clientFor(fixture), {
                repository: REPOSITORY,
                nonce: "probe-ignored",
            }),
        ).rejects.toThrow(RegistryCapabilityProbeError);
        const failed = fixture
            .takeObservations()
            .filter((observation) => observation.method === "PUT")
            .filter((observation) =>
                observation.path.includes(
                    "/manifests/ralphie-create-only-probe",
                ),
            );
        // The competing write reached the registry twice per media type
        // (child content pushes plus the probe tag and its competitor).
        expect(failed.length).toBeGreaterThanOrEqual(4);
    });

    test("fails closed when the registry lacks a supported conditional write", async () => {
        fixture = await startRegistryFixture({ rejectConditionalWrites: true });
        await expect(
            probeCreateOnlyPublishing(clientFor(fixture), {
                repository: REPOSITORY,
                nonce: "probe-no-cas",
            }),
        ).rejects.toThrow(RegistryCapabilityProbeError);
    });

    test("fails closed when blob uploads fail", async () => {
        fixture = await startRegistryFixture({ failBlobUploads: true });
        await expect(
            probeCreateOnlyPublishing(clientFor(fixture), {
                repository: REPOSITORY,
                nonce: "probe-blob-fail",
            }),
        ).rejects.toThrow(RegistryCapabilityProbeError);
    });

    test("fails a probe whose original digest changes after the competing write", async () => {
        const hijackTag = "ralphie-create-only-probe-tampered-oci-image";
        // Probe sequence per media type: create PUT, verification GET, then
        // the competing PUT followed by the preservation GET. The second read
        // hook rewrites the probe tag so the preservation reread sees a
        // different digest.
        fixture
            .onceBeforeRead(() => undefined)
            .onceBeforeRead(() =>
                fixture.setTag(
                    REPOSITORY,
                    hijackTag,
                    ociImageManifest("hijacked"),
                    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                ),
            );

        await expect(
            probeCreateOnlyPublishing(clientFor(fixture), {
                repository: REPOSITORY,
                mediaTypes: [OCI_IMAGE_MANIFEST_MEDIA_TYPE],
                nonce: "tampered",
            }),
        ).rejects.toThrow(RegistryCapabilityProbeError);
    });

    test("uses disposable, uniquely named probe tags per media type", async () => {
        const first = await verifyProbe(fixture, "run-a");
        const second = await verifyProbe(fixture, "run-b");

        const firstTags = first.entries.map((entry) => entry.probeTag);
        const secondTags = second.entries.map((entry) => entry.probeTag);
        expect(firstTags).toHaveLength(4);
        expect(secondTags).toHaveLength(4);
        for (const tag of [...firstTags, ...secondTags]) {
            expect(tag).toMatch(
                /^ralphie-create-only-probe-(run-a|run-b)-(oci-image|docker-schema2|oci-index|docker-list)$/,
            );
        }
        expect(new Set([...firstTags, ...secondTags]).size).toBe(8);
    });
});

describe("registry http client", () => {
    let fixture: RegistryFixture;

    beforeEach(async () => {
        fixture = await startRegistryFixture();
    });

    afterEach(async () => {
        await fixture.close();
    });

    test("treats missing tags as inspectable 404s and recomputes digests from bytes", async () => {
        const client = clientFor(fixture);
        const inspection = await client.inspectManifestReference(
            REPOSITORY,
            "0.1.0",
        );
        expect(inspection.kind).toBe("missing");

        fixture.setTag(
            REPOSITORY,
            "0.1.0",
            ociImageManifest("present"),
            OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        );
        const present = await client.inspectManifestReference(
            REPOSITORY,
            "0.1.0",
        );
        expect(present.kind).toBe("present");
        if (present.kind === "present") {
            expect(present.digest).toBe(manifestDigest(present.bytes));
            expect(present.digest).toBe(
                manifestDigest(ociImageManifest("present")),
            );
        }
    });

    test("propagates authentication failures during token issuance", async () => {
        const client = createOciRegistryHttpClient({
            baseUrl: fixture.baseUrl,
            username: "ralphie-fixture",
            password: "wrong-password",
        });
        await expect(
            client.inspectManifestReference(REPOSITORY, "0.1.0"),
        ).rejects.toThrow(RegistryRequestError);
    });

    test("propagates blob upload failures and honors existing blobs", async () => {
        const bytes = text("layer-bytes");
        const digest = manifestDigest(bytes);
        fixture.setBlob(REPOSITORY, digest, bytes);
        const client = clientFor(fixture);
        const pushed = await client.pushBlob(REPOSITORY, bytes);
        expect(pushed).toEqual({ size: bytes.byteLength, digest });

        const failingFixture = await startRegistryFixture({
            failBlobUploads: true,
        });
        const failingClient = clientFor(failingFixture);
        await expect(
            failingClient.pushBlob(REPOSITORY, text("new-bytes")),
        ).rejects.toThrow(RegistryRequestError);
        await failingFixture.close();
    });
});