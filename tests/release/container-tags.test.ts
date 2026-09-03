import { describe, expect, test } from "bun:test";

import {
    ContainerTagPlanError,
    parseContainerVersion,
    planContainerTags,
} from "../../src/release/container-tags.ts";

const SOURCE_REF = "c".repeat(40);

const INDEX_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

const expectTagsValid = (tags: ReadonlyArray<string>): void => {
    for (const tag of tags) {
        expect(tag).toMatch(INDEX_TAG_PATTERN);
        expect(tag).not.toContain("+");
    }
};

const expectPlan = (
    version: string,
    sourceRef: string,
    expectedIndexTags: ReadonlyArray<string>,
): void => {
    const plan = planContainerTags({ version, sourceRef });
    expect(plan.indexTags).toEqual(expectedIndexTags);
    expectTagsValid(plan.indexTags);
    expectTagsValid(plan.platformTags);
    expect(plan.platformTags.length).toBe(2);
    expect(plan.platformTags[0]).toBe(`${plan.platformTagBase}-amd64`);
    expect(plan.platformTags[1]).toBe(`${plan.platformTagBase}-arm64`);
    expect(plan.versionTag).toBe(plan.platformTagBase);
    expect(plan.sourceTag).toBe(`sha-${sourceRef}`);
    expect(new Set(plan.indexTags).size).toBe(plan.indexTags.length);
};

describe("container tag plan", () => {
    test("stable release 1.2.3 yields version, minor, latest, and sha tags in order", () => {
        expectPlan("1.2.3", SOURCE_REF, [
            "1.2.3",
            "1.2",
            "latest",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("a leading v is removed without changing the plan", () => {
        expectPlan("v1.2.3", SOURCE_REF, [
            "1.2.3",
            "1.2",
            "latest",
            `sha-${SOURCE_REF}`,
        ]);
        const plain = planContainerTags({
            version: "1.2.3",
            sourceRef: SOURCE_REF,
        });
        const prefixed = planContainerTags({
            version: "v1.2.3",
            sourceRef: SOURCE_REF,
        });
        expect(prefixed).toEqual(plain);
    });

    test("prerelease 1.2.3-rc.1 retains the suffix and never emits latest", () => {
        expectPlan("1.2.3-rc.1", SOURCE_REF, [
            "1.2.3-rc.1",
            "1.2",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("multi-identifier prerelease is retained verbatim", () => {
        expectPlan("v1.2.3-alpha.1.2", SOURCE_REF, [
            "1.2.3-alpha.1.2",
            "1.2",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("zero-only prerelease 1.2.3-0 is a prerelease and excludes latest", () => {
        expectPlan("1.2.3-0", SOURCE_REF, [
            "1.2.3-0",
            "1.2",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("build metadata is normalized out of every tag but retained in the version", () => {
        const plan = planContainerTags({
            version: "1.2.3+build.7",
            sourceRef: SOURCE_REF,
        });
        expect(plan.version).toBe("1.2.3+build.7");
        expect(plan.build).toBe("+build.7");
        expect(plan.prerelease).toBeNull();
        expect(plan.versionTag).toBe("1.2.3");
        expectPlan("1.2.3+build.7", SOURCE_REF, [
            "1.2.3",
            "1.2",
            "latest",
            `sha-${SOURCE_REF}`,
        ]);
        for (const tag of [...plan.indexTags, ...plan.platformTags]) {
            expect(tag).not.toContain("+");
        }
    });

    test("build metadata on a prerelease is normalized out of every tag", () => {
        const plan = planContainerTags({
            version: "1.2.3-rc.1+build.7",
            sourceRef: SOURCE_REF,
        });
        expect(plan.version).toBe("1.2.3-rc.1+build.7");
        expect(plan.versionTag).toBe("1.2.3-rc.1");
        expectPlan("1.2.3-rc.1+build.7", SOURCE_REF, [
            "1.2.3-rc.1",
            "1.2",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("numeric prerelease identifiers cannot have leading zeroes", () => {
        expect(() =>
            planContainerTags({
                version: "1.2.3-rc.01",
                sourceRef: SOURCE_REF,
            }),
        ).toThrow(ContainerTagPlanError);
    });

    test("platform tag base is the OCI-safe version and platform tags carry the arch", () => {
        const plan = planContainerTags({
            version: "v1.2.3-rc.1+build.7",
            sourceRef: SOURCE_REF,
        });
        expect(plan.platformTagBase).toBe("1.2.3-rc.1");
        expect(plan.platformTags).toEqual([
            "1.2.3-rc.1-amd64",
            "1.2.3-rc.1-arm64",
        ]);
    });

    test("a custom platform arch list controls the platform tag order", () => {
        const plan = planContainerTags({
            version: "1.2.3",
            sourceRef: SOURCE_REF,
            platformArchs: ["arm64", "amd64"],
        });
        expect(plan.platformTags).toEqual(["1.2.3-arm64", "1.2.3-amd64"]);
        expect(plan.indexTags).toEqual([
            "1.2.3",
            "1.2",
            "latest",
            `sha-${SOURCE_REF}`,
        ]);
    });

    test("the plan records parsed numeric fields and source ref", () => {
        const plan = planContainerTags({
            version: "v2.11.0-rc.7+build.9",
            sourceRef: SOURCE_REF,
        });
        expect(plan.major).toBe(2);
        expect(plan.minor).toBe(11);
        expect(plan.patch).toBe(0);
        expect(plan.minorTag).toBe("2.11");
        expect(plan.latest).toBe(false);
        expect(plan.sourceRef).toBe(SOURCE_REF);
    });

    test("malformed SemVer fails closed", () => {
        const malformed = [
            "",
            "v",
            "1.2",
            "1.2.3.4",
            "abc",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.2.3-",
            "1.2.3-rc..1",
            "1.2.3-rc1.01",
            "1.2.3+",
            "1.2.3+.",
            "1.2.3+build..1",
            "1.2.3 \n",
            "1.2.3\n",
            "1.2.3-alpha.1 ",
            "1.2.3+build 7",
        ];
        for (const version of malformed) {
            expect(() =>
                planContainerTags({ version, sourceRef: SOURCE_REF }),
            ).toThrow(ContainerTagPlanError);
            expect(() => parseContainerVersion(version)).toThrow(
                ContainerTagPlanError,
            );
        }
    });

    test("a malformed source ref fails closed", () => {
        const malformed = [
            "",
            "abc",
            "c".repeat(39),
            "C".repeat(40),
            `${"c".repeat(40)}\n`,
            "g".repeat(40),
        ];
        for (const sourceRef of malformed) {
            expect(() =>
                planContainerTags({ version: "1.2.3", sourceRef }),
            ).toThrow(ContainerTagPlanError);
        }
    });

    test("no alias outside the documented list is ever emitted", () => {
        const versions = [
            "1.2.3",
            "v1.2.3",
            "0.1.0",
            "1.2.3-rc.1",
            "v1.2.3-alpha.1.2",
            "1.2.3+build.7",
            "1.2.3-rc.1+build.7",
            "9.380.16-beta.12+exp.sha.5114f85",
        ];
        for (const version of versions) {
            const plan = planContainerTags({ version, sourceRef: SOURCE_REF });
            const expected = [
                plan.versionTag,
                plan.minorTag,
                ...(plan.latest ? ["latest"] : []),
                plan.sourceTag,
            ];
            expect([...plan.indexTags].sort()).toEqual([...expected].sort());
            expect(plan.indexTags[0]).toBe(plan.versionTag);
            expect(plan.indexTags[1]).toBe(plan.minorTag);
            expect(plan.indexTags[plan.indexTags.length - 1]).toBe(
                plan.sourceTag,
            );
        }
    });
});