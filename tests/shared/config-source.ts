import type {
    ConfigFile,
    ConfigSourceService,
    GitHubLoginService,
} from "../../src/config/ports.ts";

/** An in-memory configuration source serving one already-parsed document. */
export const fakeConfigSource = (
    document: unknown = {},
    path = "/fake/ralphie/config.yaml",
): ConfigSourceService & { readonly requested: Array<string | undefined> } => {
    const requested: Array<string | undefined> = [];
    return {
        requested,
        load: async (explicitPath): Promise<ConfigFile> => {
            requested.push(explicitPath);
            return { path: explicitPath ?? path, document };
        },
    };
};

export const fakeGitHubLogin = (login = "gh-user"): GitHubLoginService => ({
    currentLogin: async () => login,
});