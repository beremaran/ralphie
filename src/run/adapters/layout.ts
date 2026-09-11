import { join } from "node:path";

import type { RunLayout } from "../ports.ts";
import { resolveWorkspacePath } from "../../shared/workspace-path.ts";

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

/** Resolve the filesystem layout for one run; the only place that knows it. */
export const makeRunLayout = (workspace: string, runId: string): RunLayout => {
    const workspaceRoot = resolveWorkspacePath(workspace);
    const runRoot = join(workspaceRoot, ".ralphie", "runs", safeRunId(runId));
    const issueRoot = join(runRoot, "issues");
    return {
        workspaceRoot,
        runRoot,
        statePath: join(runRoot, "state.json"),
        eventLogPath: join(runRoot, "events.jsonl"),
        issueArtifactsDirectory: (issueNumber) =>
            join(issueRoot, String(issueNumber)),
        issueArtifactsPath: (issueNumber) =>
            join(issueRoot, String(issueNumber), "artifacts.json"),
        diagnosticsDirectory: (issueNumber) =>
            join(issueRoot, String(issueNumber)),
        diagnosticsPath: (issueNumber, name) =>
            join(issueRoot, String(issueNumber), name),
    };
};