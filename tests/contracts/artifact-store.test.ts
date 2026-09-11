import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    makeDurableIssueArtifactStore,
    makeIssueArtifactStore,
} from "../../src/issues/app/artifacts.ts";
import { nodeIssueArtifactFileSystem } from "../../src/issues/adapters/artifact-file-system.ts";
import { makeRunLayout } from "../../src/run/adapters/layout.ts";
import { countingIds } from "../shared/test-values.ts";
import { issueArtifactStoreContract } from "./artifact-store.contract.ts";

issueArtifactStoreContract({
    name: "in-memory",
    make: async () => ({
        store: await makeIssueArtifactStore(42),
        cleanup: async () => {},
    }),
});

issueArtifactStoreContract({
    name: "durable",
    make: async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        const store = await makeDurableIssueArtifactStore(
            42,
            { repository: "owner/repo" },
            {
                fileSystem: nodeIssueArtifactFileSystem,
                layout: makeRunLayout(workspace, "contract-run"),
                ids: countingIds("temp"),
            },
        );
        return {
            store,
            cleanup: async () => {
                await rm(workspace, { recursive: true, force: true });
            },
        };
    },
});