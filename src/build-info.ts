import packageJson from "../package.json";

/** Commit marker used when no release metadata is supplied to the build. */
export const LOCAL_BUILD_COMMIT_SHA = "local" as const;

export type BuildInfo = {
    readonly version: string;
    readonly commitSha: string;
};

// The build entry point replaces this identifier with a JSON BuildInfo object.
// Keeping the fallback here makes source execution and local builds useful
// without reading mutable runtime environment from a compiled binary.
declare const RALPHIE_BUILD_INFO: BuildInfo | undefined;

const injectedBuildInfo: BuildInfo | undefined =
    typeof RALPHIE_BUILD_INFO === "undefined" ? undefined : RALPHIE_BUILD_INFO;

export const BUILD_INFO: BuildInfo = Object.freeze(
    injectedBuildInfo ?? {
        version: packageJson.version,
        commitSha: LOCAL_BUILD_COMMIT_SHA,
    },
);

export const getBuildInfo = (): BuildInfo => BUILD_INFO;