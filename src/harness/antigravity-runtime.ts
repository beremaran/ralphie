import { access, constants, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize } from "node:path";

import {
    CommandAbortedError,
    CommandRunnerLive,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import type { HarnessCapabilities, HarnessStatus } from "./contracts.ts";

export const ANTIGRAVITY_HARNESS_KIND = "google-antigravity" as const;
export const ANTIGRAVITY_DEFAULT_EXECUTABLE = "antigravity";
export const ANTIGRAVITY_MINIMUM_VERSION = "1.0.0";
export const ANTIGRAVITY_MAXIMUM_VERSION = "2.0.0";
export const ANTIGRAVITY_DEFAULT_PROTOCOL_VERSION = "1";
export const ANTIGRAVITY_VERSION_ARGUMENTS = ["--version"] as const;
export const ANTIGRAVITY_PROTOCOL_ARGUMENTS = ["--protocol-version"] as const;
export const ANTIGRAVITY_CAPABILITIES_ARGUMENTS = ["--capabilities"] as const;
export const ANTIGRAVITY_DISCOVERY_TIMEOUT_MS = 10_000;

export type AntigravityRuntimeConfig = {
    /** An executable or command name selected by the operator. */
    readonly executable?: string;
    /** A managed installation root. No other root is selected implicitly. */
    readonly installationRoot?: string;
    /** Override the names considered when no executable is configured. */
    readonly executableNames?: ReadonlyArray<string>;
    /** Optional lower inclusive runtime version bound. */
    readonly minimumVersion?: string;
    /** Optional upper exclusive runtime version bound. */
    readonly maximumVersion?: string;
    /** ACP version required by the session adapter. */
    readonly requiredProtocolVersion?: string;
    /** ACP capability names that must be advertised by the runtime. */
    readonly requiredFeatures?: ReadonlyArray<string>;
    readonly versionArguments?: ReadonlyArray<string>;
    readonly protocolArguments?: ReadonlyArray<string>;
    readonly capabilitiesArguments?: ReadonlyArray<string>;
};

export type AntigravityFileSystem = {
    readonly isExecutable: (path: string) => Promise<boolean>;
    readonly realpath?: (path: string) => Promise<string>;
};

export type AntigravityRuntime = {
    readonly executable: string;
    readonly version: string;
    readonly protocolVersion: string;
    readonly features: ReadonlyArray<string>;
    readonly capabilities: HarnessCapabilities;
};

export type AntigravityDiscoveryStatus =
    | "available"
    | "missing"
    | "ambiguous"
    | "incompatible";

export type AntigravityDiscoveryResult = {
    readonly status: AntigravityDiscoveryStatus;
    readonly runtime?: AntigravityRuntime;
    readonly candidates: ReadonlyArray<string>;
    readonly message: string;
    readonly setupHint: string;
};

export type AntigravityDiscoveryInput = {
    readonly config?: AntigravityRuntimeConfig;
    readonly commandRunner?: CommandRunnerService;
    readonly fileSystem?: AntigravityFileSystem;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
};

export type AntigravityRuntimeDiscovery = {
    readonly discover: (
        input?: Omit<AntigravityDiscoveryInput, "commandRunner" | "fileSystem">,
    ) => Promise<AntigravityDiscoveryResult>;
    readonly probe: (
        input?: Omit<AntigravityDiscoveryInput, "commandRunner" | "fileSystem">,
    ) => Promise<HarnessStatus>;
};

const liveFileSystem: AntigravityFileSystem = {
    isExecutable: async (path) => {
        try {
            await access(path, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    },
    realpath: async (path) => await realpath(path),
};

const setupHint =
    "Install Antigravity, then set ANTIGRAVITY_EXECUTABLE or configure its installation root.";

const protocolSetupHint =
    "Install an Antigravity release with ACP protocol 1 support, then retry discovery.";

const result = (
    status: AntigravityDiscoveryStatus,
    message: string,
    candidates: ReadonlyArray<string> = [],
    hint = setupHint,
): AntigravityDiscoveryResult => ({
    status,
    candidates,
    message,
    setupHint: hint,
});

const versionParts = (
    value: string,
): readonly [number, number, number] | undefined => {
    const match = value.match(
        /(?:^|[^\d])v?(\d+)\.(\d+)(?:\.(\d+))?(?:$|[^\d])/i,
    );
    if (match === null) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

export const parseAntigravityVersion = (output: string): string | undefined => {
    const match = output.match(
        /(?:^|[^\d])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^\d])/i,
    );
    return match?.[1];
};

const compareVersions = (left: string, right: string): number => {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    if (leftParts === undefined || rightParts === undefined) return Number.NaN;
    const major = leftParts[0] - rightParts[0];
    if (major !== 0) return major;
    const minor = leftParts[1] - rightParts[1];
    return minor !== 0 ? minor : leftParts[2] - rightParts[2];
};

const versionSupported = (
    version: string,
    config: AntigravityRuntimeConfig,
): boolean => {
    const minimum = compareVersions(
        version,
        config.minimumVersion ?? ANTIGRAVITY_MINIMUM_VERSION,
    );
    const maximum = compareVersions(
        version,
        config.maximumVersion ?? ANTIGRAVITY_MAXIMUM_VERSION,
    );
    return (
        !Number.isNaN(minimum) &&
        !Number.isNaN(maximum) &&
        minimum >= 0 &&
        maximum < 0
    );
};

const jsonObjectEnd = (output: string, start: number): number | undefined => {
    for (let end = start; end < output.length; end += 1) {
        const character = output[end];
        if (character !== "}") continue;
        try {
            JSON.parse(output.slice(start, end + 1));
            return end;
        } catch {
            // The object is not complete yet.
        }
    }
    return undefined;
};

const jsonValues = (output: string): readonly unknown[] => {
    const values: unknown[] = [];
    try {
        return [JSON.parse(output.trim()) as unknown];
    } catch {
        // The runtime may prefix or suffix JSON with human-readable text.
    }

    for (let start = 0; start < output.length; start += 1) {
        if (output[start] !== "{") continue;
        const end = jsonObjectEnd(output, start);
        if (end === undefined) continue;
        try {
            values.push(JSON.parse(output.slice(start, end + 1)) as unknown);
        } catch {
            // Ignore non-JSON brace-delimited text and keep scanning.
        }
    }
    return values;
};

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" || typeof value === "number"
        ? String(value)
        : undefined;

const protocolVersionFrom = (output: string): string | undefined => {
    for (const value of jsonValues(output)) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const protocol =
            record.protocolVersion ??
            record.protocol_version ??
            record.protocol;
        const parsed = stringValue(protocol);
        if (parsed !== undefined) return parsed;
    }
    const labelled = output.match(
        /(?:acp\s*)?(?:protocol(?:\s+version)?|protocolVersion)\s*[:=v]?\s*(\d+(?:\.\d+)?)/i,
    );
    if (labelled?.[1] !== undefined) return labelled[1];
    const acp = output.match(/\bacp\s*[/:-]\s*v?(\d+(?:\.\d+)?)\b/i);
    return acp?.[1];
};

const bareProtocolVersionFrom = (output: string): string | undefined =>
    output.trim().match(/^v?(\d+(?:\.\d+)?)$/i)?.[1];

const featureNames = (value: unknown, prefix = ""): string[] => {
    if (Array.isArray(value)) {
        return value.flatMap((child) =>
            typeof child === "string"
                ? [prefix ? `${prefix}.${child}` : child]
                : featureNames(child, prefix),
        );
    }
    if (typeof value !== "object" || value === null) return [];
    const features: string[] = [];
    for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
    )) {
        const name = prefix ? `${prefix}.${key}` : key;
        if (child === true) features.push(name);
        else if (typeof child === "object")
            features.push(...featureNames(child, name));
    }
    return features;
};

const addJsonFeatures = (features: Set<string>, output: string): void => {
    for (const value of jsonValues(output)) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const capabilities = record.capabilities ?? record.features;
        if (capabilities === undefined) continue;
        for (const feature of featureNames(capabilities)) features.add(feature);
    }
};

const addLabelledFeatures = (features: Set<string>, output: string): void => {
    const labelled = output.match(
        /(?:^|[\r\n])[ \t]*(?:features|capabilities)[ \t]*[:=][ \t]*([^\n]+)/i,
    )?.[1];
    for (const feature of labelled?.split(/[\s,]+/) ?? []) {
        const normalized = feature.trim();
        if (normalized) features.add(normalized);
    }
};

const featuresFrom = (output: string): readonly string[] => {
    const features = new Set<string>();
    addJsonFeatures(features, output);
    addLabelledFeatures(features, output);
    return [...features].sort();
};

const capabilitiesFrom = (
    features: ReadonlyArray<string>,
): HarnessCapabilities => {
    const known = [
        "resume",
        "structured-output",
        "model-catalog",
        "variants",
        "events",
        "permissions",
    ] as const;
    return Object.fromEntries(
        known.map((capability) => [
            capability,
            features.includes(capability) ||
                features.includes(`capabilities.${capability}`),
        ]),
    ) as HarnessCapabilities;
};

const commandCandidates = (
    config: AntigravityRuntimeConfig,
    environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
    const configured =
        config.executable ??
        environment.ANTIGRAVITY_EXECUTABLE ??
        environment.ANTIGRAVITY_RUNTIME;
    if (configured !== undefined) {
        if (isAbsolute(configured) || configured.includes("/")) {
            return [configured];
        }
        return (environment.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((directory) => join(directory, configured));
    }

    const names = config.executableNames ?? [ANTIGRAVITY_DEFAULT_EXECUTABLE];
    const installationRoot =
        config.installationRoot ?? environment.ANTIGRAVITY_INSTALLATION_ROOT;
    if (installationRoot !== undefined) {
        return names.flatMap((name) => [
            join(installationRoot, name),
            join(installationRoot, "bin", name),
        ]);
    }

    const path = environment.PATH ?? "";
    return path
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => names.map((name) => join(directory, name)));
};

const canonicalCandidate = async (
    candidate: string,
    fileSystem: AntigravityFileSystem,
): Promise<string | undefined> => {
    const normalized = isAbsolute(candidate) ? normalize(candidate) : candidate;
    if (!(await fileSystem.isExecutable(normalized))) return undefined;
    try {
        return (await fileSystem.realpath?.(normalized)) ?? normalized;
    } catch {
        return normalized;
    }
};

const locate = async (
    config: AntigravityRuntimeConfig,
    environment: Readonly<Record<string, string | undefined>>,
    fileSystem: AntigravityFileSystem,
): Promise<readonly string[]> => {
    const located = await Promise.all(
        commandCandidates(config, environment).map((candidate) =>
            canonicalCandidate(candidate, fileSystem),
        ),
    );
    return [
        ...new Set(
            located.filter(
                (candidate): candidate is string => candidate !== undefined,
            ),
        ),
    ];
};

const mergeProbeOutput = (stdout: string, stderr: string): string =>
    [stdout, stderr].filter(Boolean).join("\n");

const probeOutput = async (
    runner: CommandRunnerService,
    executable: string,
    args: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
): Promise<{ readonly ok: boolean; readonly output: string }> => {
    try {
        const response = await runner.run(executable, args, {
            signal,
            timeoutMs: ANTIGRAVITY_DISCOVERY_TIMEOUT_MS,
        });
        return {
            ok: response.exitCode === 0,
            output: mergeProbeOutput(response.stdout, response.stderr),
        };
    } catch (cause) {
        if (cause instanceof CommandAbortedError) throw cause;
        return { ok: false, output: "" };
    }
};

type AntigravityProbe =
    | { readonly runtime: AntigravityRuntime }
    | { readonly message: string; readonly setupHint: string };

type AntigravityCapabilitiesProbe =
    | {
          readonly features: ReadonlyArray<string>;
          readonly missingFeatures: ReadonlyArray<string>;
      }
    | { readonly message: string; readonly setupHint: string };

const probeCapabilities = async (input: {
    readonly executable: string;
    readonly config: AntigravityRuntimeConfig;
    readonly runner: CommandRunnerService;
    readonly signal?: AbortSignal;
}): Promise<AntigravityCapabilitiesProbe> => {
    const capabilitiesProbe = await probeOutput(
        input.runner,
        input.executable,
        input.config.capabilitiesArguments ??
            ANTIGRAVITY_CAPABILITIES_ARGUMENTS,
        input.signal,
    );
    if (!capabilitiesProbe.ok) {
        return {
            message:
                "The configured Antigravity runtime did not report its ACP capabilities.",
            setupHint:
                "Install an Antigravity release that supports the capabilities probe, then retry discovery.",
        };
    }
    const features = featuresFrom(capabilitiesProbe.output);
    if (features.length === 0) {
        return {
            message:
                "The configured Antigravity runtime did not report parseable ACP capabilities.",
            setupHint:
                "Install an Antigravity release that reports its ACP capabilities, then retry discovery.",
        };
    }
    return {
        features,
        missingFeatures: (input.config.requiredFeatures ?? []).filter(
            (feature) => !features.includes(feature),
        ),
    };
};

const probeRuntime = async (input: {
    readonly executable: string;
    readonly config: AntigravityRuntimeConfig;
    readonly runner: CommandRunnerService;
    readonly signal?: AbortSignal;
}): Promise<AntigravityProbe> => {
    const { config, executable, runner, signal } = input;
    const versionProbe = await probeOutput(
        runner,
        executable,
        config.versionArguments ?? ANTIGRAVITY_VERSION_ARGUMENTS,
        signal,
    );
    const version = parseAntigravityVersion(versionProbe.output);
    if (!versionProbe.ok || version === undefined) {
        return {
            message:
                "The configured Antigravity runtime did not report a readable version.",
            setupHint:
                "Install a supported Antigravity release and verify that its executable can run --version.",
        };
    }
    if (!versionSupported(version, config)) {
        return {
            message: `The configured Antigravity runtime version ${version} is outside the supported range.`,
            setupHint:
                "Install a supported Antigravity release or adjust the configured version policy.",
        };
    }

    const protocolOutput = await probeOutput(
        runner,
        executable,
        config.protocolArguments ?? ANTIGRAVITY_PROTOCOL_ARGUMENTS,
        signal,
    );
    const protocolVersion =
        protocolVersionFrom(protocolOutput.output) ??
        bareProtocolVersionFrom(protocolOutput.output);
    const requiredProtocol =
        config.requiredProtocolVersion ?? ANTIGRAVITY_DEFAULT_PROTOCOL_VERSION;
    if (!protocolOutput.ok || protocolVersion !== requiredProtocol) {
        return {
            message: `The configured Antigravity runtime does not support ACP protocol ${requiredProtocol}.`,
            setupHint: protocolSetupHint,
        };
    }

    const capabilities = await probeCapabilities({
        executable,
        config,
        runner,
        signal,
    });
    if ("message" in capabilities) return capabilities;
    if (capabilities.missingFeatures.length > 0) {
        return {
            message: `The configured Antigravity runtime is missing required ACP features: ${capabilities.missingFeatures.join(", ")}.`,
            setupHint:
                "Install an Antigravity release that advertises the required ACP features.",
        };
    }

    return {
        runtime: {
            executable,
            version,
            protocolVersion,
            features: capabilities.features,
            capabilities: capabilitiesFrom(capabilities.features),
        },
    };
};

const discoverWith = async (
    input: AntigravityDiscoveryInput,
): Promise<AntigravityDiscoveryResult> => {
    const config = input.config ?? {};
    const environment = input.environment ?? process.env;
    const fileSystem = input.fileSystem ?? liveFileSystem;
    const candidates = await locate(config, environment, fileSystem);

    if (candidates.length === 0) {
        return result("missing", "No Antigravity runtime was found.");
    }
    if (candidates.length > 1) {
        return result(
            "ambiguous",
            "More than one Antigravity runtime was found; configure one executable or installation root.",
            candidates,
        );
    }

    const executable = candidates[0] as string;
    const runner = input.commandRunner ?? CommandRunnerLive;
    const probed = await probeRuntime({
        executable,
        config,
        runner,
        signal: input.signal,
    });
    if ("message" in probed) {
        return result(
            "incompatible",
            probed.message,
            candidates,
            probed.setupHint,
        );
    }
    return {
        status: "available",
        candidates,
        message: "Antigravity runtime is available and compatible.",
        setupHint: "",
        runtime: probed.runtime,
    };
};

/** Fail closed before a workflow can create an agent session. */
export const requireAntigravityRuntime = async (
    discovery: AntigravityRuntimeDiscovery | undefined,
    signal?: AbortSignal,
): Promise<AntigravityRuntime | undefined> => {
    if (discovery === undefined) return undefined;
    signal?.throwIfAborted();
    const discovered = await discovery.discover({ signal });
    if (discovered.status !== "available" || discovered.runtime === undefined) {
        const hint =
            discovered.setupHint === "" ? "" : ` ${discovered.setupHint}`;
        throw new RalphieError({
            message: `Antigravity runtime discovery failed: ${discovered.message}${hint}`,
        });
    }
    return discovered.runtime;
};

export const makeAntigravityRuntimeDiscovery = (
    dependencies: {
        readonly commandRunner?: CommandRunnerService;
        readonly fileSystem?: AntigravityFileSystem;
        readonly environment?: Readonly<Record<string, string | undefined>>;
    } = {},
): AntigravityRuntimeDiscovery => {
    const discover = async (
        input: Omit<
            AntigravityDiscoveryInput,
            "commandRunner" | "fileSystem"
        > = {},
    ): Promise<AntigravityDiscoveryResult> =>
        await discoverWith({
            ...input,
            ...(dependencies.commandRunner === undefined
                ? {}
                : { commandRunner: dependencies.commandRunner }),
            ...(dependencies.fileSystem === undefined
                ? {}
                : { fileSystem: dependencies.fileSystem }),
            ...(dependencies.environment === undefined
                ? {}
                : { environment: dependencies.environment }),
        });

    return {
        discover,
        probe: async (input = {}) => {
            const discovered = await discover(input);
            return {
                kind: ANTIGRAVITY_HARNESS_KIND,
                available: discovered.status === "available",
                authenticated: false,
                ...(discovered.runtime === undefined
                    ? { message: discovered.message }
                    : {
                          version: discovered.runtime.version,
                          message: discovered.message,
                      }),
            };
        },
    };
};

export const discoverAntigravityRuntime = async (
    input: AntigravityDiscoveryInput = {},
): Promise<AntigravityDiscoveryResult> => await discoverWith(input);

export const probeAntigravityRuntime = async (
    input: AntigravityDiscoveryInput = {},
): Promise<HarnessStatus> =>
    await makeAntigravityRuntimeDiscovery({
        ...(input.commandRunner === undefined
            ? {}
            : { commandRunner: input.commandRunner }),
        ...(input.fileSystem === undefined
            ? {}
            : { fileSystem: input.fileSystem }),
        ...(input.environment === undefined
            ? {}
            : { environment: input.environment }),
    }).probe({ config: input.config, signal: input.signal });