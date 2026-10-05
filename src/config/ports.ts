/** A configuration file as read from disk, or the fact that none exists. */
export type ConfigDocument =
    | { readonly found: false }
    | { readonly found: true; readonly content: unknown };

/**
 * Outbound port for reading YAML configuration. Parsing stays behind the port
 * so the loader never depends on a YAML implementation or the filesystem.
 */
export type ConfigDocumentReader = {
    /** Parse the YAML file at `path`; `found: false` when no file exists. */
    readonly read: (path: string) => Promise<ConfigDocument>;
    /** Parse one YAML value, such as the right-hand side of `--set`. */
    readonly parseValue: (text: string) => unknown;
};
