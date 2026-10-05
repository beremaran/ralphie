/** A configuration file that was found and parsed, but not yet validated. */
export type ConfigFile = {
    readonly path: string;
    readonly document: unknown;
};

/** Outbound port that locates, reads and parses the YAML configuration. */
export type ConfigSourceService = {
    /**
     * Load the configuration at `explicitPath`, or at the default location
     * when omitted. Fails with an actionable error when the file is missing
     * or is not valid YAML.
     */
    readonly load: (explicitPath?: string) => Promise<ConfigFile>;
};

/** Outbound port for the login of the authenticated GitHub user. */
export type GitHubLoginService = {
    readonly currentLogin: () => Promise<string>;
};