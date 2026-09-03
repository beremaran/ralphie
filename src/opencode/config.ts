export const OPENCODE_URL_ENV = "OPENCODE_URL";
export const OPENCODE_TOKEN_ENV = "OPENCODE_TOKEN";

export type OpenCodeModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type OpenCodeProviderConfig = {
    readonly workspace: string;
    readonly baseUrl?: string;
    readonly token?: string;
    readonly model?: OpenCodeModel;
};

export type OpenCodeEndpoint = {
    readonly baseUrl: string;
    readonly headers?: Record<string, string>;
};

export const resolveOpenCodeEndpointConfig = (
    config: OpenCodeProviderConfig,
): {
    readonly baseUrl?: string;
    readonly token?: string;
} => ({
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.token === undefined ? {} : { token: config.token }),
});