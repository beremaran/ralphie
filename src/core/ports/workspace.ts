/** Outbound port for workspace preparation and protected removal. */
export type WorkspaceService = {
    readonly prepare: (workspace: string) => Promise<void>;
    readonly remove: (workspace: string) => Promise<void>;
};