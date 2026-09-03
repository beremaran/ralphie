#!/usr/bin/env bun

/**
 * Verified create-only registry reconciliation seam used by the protected
 * `publish` job of `.github/workflows/release.yml` (steps "Promote platform
 * images with create-only reconciliation" and "Reconcile release-index
 * aliases from immutable digests") and runnable locally:
 *
 *   bun scripts/reconcile-container-registry.ts \
 *     --plan <ralphie-reconcile-plan.json> --stage platform|index
 *
 * Credentials are read from the environment (`GHCR_USERNAME` and
 * `GHCR_PASSWORD`); they are inputs and are never echoed. The registry is
 * contacted through the same Bearer-challenge OCI client used by the
 * create-only reconciler: every destination tag is inspected first and
 * reused only on an exact serialized-digest match, missing tags are created
 * through a server-enforced compare-and-swap that is probed and proved
 * against the real registry before any production write, and every write is
 * reread. Platform promotion runs before every index-tag alias, so any
 * authentication or push failure fails the job and prevents later alias
 * publication. The platform stage also writes the
 * `ralphie.publication-subjects.v1` document consumed by the attestation
 * steps.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
    reconcileContainerRegistry,
    type ContainerRegistryStage,
} from "../src/release/container-registry-reconcile.ts";
import { parseContainerReconcilePlan } from "../src/release/container-index.ts";
import { createOciRegistryHttpClient } from "../src/release/registry-http-client.ts";

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const requiredEnvironment = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(
            `Missing required registry credential environment variable '${name}'.`,
        );
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 4 && args.length !== 6) {
        throw new Error(
            "Usage: reconcile-container-registry.ts --plan <path> --stage platform|index [--registry-url <url>]",
        );
    }
    const planPath = resolve(optionValue(args, "--plan"));
    const stage = optionValue(args, "--stage");
    if (stage !== "platform" && stage !== "index") {
        throw new Error(`Unsupported reconcile stage '${stage}'.`);
    }
    const registryUrl = args.includes("--registry-url")
        ? optionValue(args, "--registry-url")
        : "https://ghcr.io";

    const username = requiredEnvironment("GHCR_USERNAME");
    const password = requiredEnvironment("GHCR_PASSWORD");

    let planText: string;
    try {
        planText = await readFile(planPath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read reconcile plan '${planPath}': ${message}`);
    }
    const plan = parseContainerReconcilePlan(planText);
    const planDir = dirname(planPath);

    const client = createOciRegistryHttpClient({
        baseUrl: registryUrl,
        username,
        password,
    });

    const publicationSubjectsPath =
        stage === "platform" ? "publication-subjects.json" : undefined;
    const result = await reconcileContainerRegistry({
        client,
        plan,
        planDir,
        stage: stage as ContainerRegistryStage,
        publicationSubjectsPath,
    });
    if (stage === "platform" && publicationSubjectsPath !== undefined) {
        console.log(
            `Reconciled ${result.stage} container platform tags for ${plan.image}: created ${result.created}, reused ${result.reused}; publication subjects written to ${publicationSubjectsPath}`,
        );
    } else {
        console.log(
            `Reconciled ${result.stage} container index tags for ${plan.image}: created ${result.created}, reused ${result.reused}`,
        );
    }
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}