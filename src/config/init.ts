import {
    HARNESS_NAMES,
    type HarnessName,
    type HarnessProbe,
} from "../harness/ports.ts";
import { RalphieError } from "../shared/error.ts";
import type { ConfigDocumentWriter } from "./ports.ts";

/** Harnesses with no sandbox or approval system, so editing needs `yolo`. */
const YOLO_ONLY: ReadonlyArray<string> = ["pi", "opencode"];

const harnessSection = (harness: string): ReadonlyArray<string> =>
    YOLO_ONLY.includes(harness)
        ? [
              "harnesses:",
              `  ${harness}:`,
              `    # ${harness} has no sandbox, so editing roles must run as yolo.`,
              "    approval: yolo",
              "    # model:",
              "    # effort:",
          ]
        : [
              "# harnesses:",
              `#   ${harness}:`,
              "#     model:",
              "#     effort:",
              "#     approval: safe  # or yolo, which skips the harness sandbox",
          ];

/** The commented starter file for the harnesses found on PATH. */
export const renderInitConfig = (detected: ReadonlyArray<string>): string => {
    const [primary, secondary] = detected;
    if (primary === undefined) {
        throw new RalphieError({
            message: `No supported harness found on PATH (looked for ${HARNESS_NAMES.join(", ")}). Install one, then run ralphie init again.`,
        });
    }
    return [
        "# Ralphie configuration, written by `ralphie init`.",
        "# Every key is documented in docs/configuration.md.",
        `# Harnesses found on PATH: ${detected.join(", ")}.`,
        "",
        "# Which harness runs each role. `default` covers every role; name a role",
        "# (implementer, reviewer, ...) to give it another harness.",
        "roles:",
        `  default: ${primary}`,
        ...(secondary === undefined ? [] : [`  # reviewer: ${secondary}`]),
        "",
        "# Per-harness model, effort and approval. Without a model the harness",
        "# uses its own default.",
        ...harnessSection(primary),
        "",
        "# Settings for one repository, for example:",
        "# repos:",
        '#   "owner/repo":',
        "#     branch: main",
        "#     verify: [bun test]",
        "",
    ].join("\n");
};

export type InitResult = {
    readonly path: string;
    readonly detected: ReadonlyArray<HarnessName>;
};

export type InitDependencies = {
    readonly probe: Pick<HarnessProbe, "installed">;
    readonly writer: ConfigDocumentWriter;
};

/** Detect installed harnesses and write the starter config, never overwriting. */
export const initializeConfig = async (
    { probe, writer }: InitDependencies,
    path: string,
): Promise<InitResult> => {
    const probed = await Promise.all(
        HARNESS_NAMES.map(
            async (name) => [name, await probe.installed(name)] as const,
        ),
    );
    const detected = probed.flatMap(([name, result]) =>
        result.ok ? [name] : [],
    );
    const created = await writer.createIfAbsent(
        path,
        renderInitConfig(detected),
    );
    if (!created) {
        throw new RalphieError({
            message: `Configuration file ${path} already exists; ralphie init never overwrites it.`,
        });
    }
    return { path, detected };
};