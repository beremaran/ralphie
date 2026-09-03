#!/usr/bin/env bun

/**
 * Deterministic semver-aware GHCR tag-plan seam used by the protected
 * `push-container` job of `.github/workflows/release.yml` (step "Derive
 * container tag plan") and runnable locally:
 *
 *   bun scripts/derive-container-tags.ts \
 *     --version <version> --source-ref <sha> [--output <path>]
 *
 * It consumes the already validated release version and source commit and
 * emits the exact `ralphie.container-tag-plan.v1` plan consumed by the
 * platform promotion and manifest-alias steps: the OCI-safe version tag base
 * (leading `v` removed, build metadata normalized out), the per-architecture
 * platform tags, and the exact ordered, deduplicated release-index tag list.
 * The minor alias comes from the parsed numeric major/minor fields, `latest`
 * is present only for SemVer without a prerelease identifier, and
 * `sha-<source_ref>` is always present. Malformed SemVer, an invalid source
 * ref, or any derived tag that would not be a valid OCI tag name fails closed
 * with a non-zero exit and no plan is written. A raw value such as
 * `1.2.3+build.7` is never part of an emitted tag; the full validated version
 * is retained in `version` for candidate/image metadata.
 */

import { writeFile } from "node:fs/promises";

import {
    CONTAINER_TAG_PLAN_SCHEMA,
    planContainerTags,
    type ContainerTagPlan,
} from "../src/release/container-tags.ts";

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 4 && args.length !== 6) {
        throw new Error(
            "Usage: derive-container-tags.ts --version <version> --source-ref <sha> [--output <path>]",
        );
    }
    const plan: ContainerTagPlan = planContainerTags({
        sourceRef: optionValue(args, "--source-ref"),
        version: optionValue(args, "--version"),
    });
    const document = {
        schema: CONTAINER_TAG_PLAN_SCHEMA,
        version: plan.version,
        source_ref: plan.sourceRef,
        version_tag: plan.versionTag,
        minor_tag: plan.minorTag,
        latest: plan.latest,
        source_tag: plan.sourceTag,
        platform_tag_base: plan.platformTagBase,
        platform_tags: [...plan.platformTags],
        index_tags: [...plan.indexTags],
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    const output = args.includes("--output")
        ? optionValue(args, "--output")
        : undefined;
    if (output === undefined) {
        console.log(text);
        return;
    }
    await writeFile(output, text);
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}