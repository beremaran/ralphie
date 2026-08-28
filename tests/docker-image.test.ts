import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

setDefaultTimeout(120_000);

const dockerAvailable = (): boolean => {
    try {
        return (
            Bun.spawnSync(
                ["docker", "info", "--format", "{{.ServerVersion}}"],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                },
            ).exitCode === 0
        );
    } catch {
        return false;
    }
};

const runDocker = (
    args: ReadonlyArray<string>,
    allowFailure = false,
): string => {
    const result = Bun.spawnSync(["docker", ...args], {
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0 && !allowFailure) {
        throw new Error(
            `docker ${args.join(" ")} failed:\n${result.stderr.toString()}`,
        );
    }
    return stdout;
};

type DockerConfig = {
    readonly User?: string;
    readonly WorkingDir?: string;
    readonly Env?: ReadonlyArray<string>;
};

const inspectConfig = (image: string): DockerConfig =>
    JSON.parse(
        runDocker(["image", "inspect", image, "--format", "{{json .Config}}"]),
    ) as DockerConfig;

const runtimeSmokeCommand = [
    "set -eu",
    'test "$(id -u)" = 65532',
    'test "$(id -g)" = 65532',
    'test "$HOME" = /home/nonroot',
    'test "$(pwd)" = /home/nonroot',
    "command -v bash >/dev/null",
    "command -v git >/dev/null",
    "command -v gh >/dev/null",
    "command -v ssh >/dev/null",
    "command -v rg >/dev/null",
    "command -v fdfind >/dev/null",
    "git --version >/dev/null",
    "gh --version >/dev/null",
    "test -s /etc/ssl/certs/ca-certificates.crt",
    'state_dir="$HOME/.ralphie"',
    'test ! -e "$state_dir"',
    'mkdir -p "$state_dir"',
    'printf "smoke\\n" > "$state_dir/probe"',
    'test -s "$state_dir/probe"',
].join("\n");

describe("Docker image runtime contract", () => {
    test.skipIf(!dockerAvailable())(
        "runs as nonroot with its complete runtime contract",
        () => {
            const image = `ralphie-test:${process.pid}-${Date.now()}`;
            try {
                runDocker(["build", "--tag", image, repositoryRoot]);

                const config = inspectConfig(image);
                expect(config.User).toBe("65532:65532");
                expect(config.WorkingDir).toBe("/home/nonroot");
                expect(config.Env).toContain("HOME=/home/nonroot");

                runDocker(["run", "--rm", image, "--version"]);
                runDocker([
                    "run",
                    "--rm",
                    "--entrypoint",
                    "/bin/bash",
                    image,
                    "-c",
                    runtimeSmokeCommand,
                ]);
            } finally {
                runDocker(["image", "rm", "--force", image], true);
            }
        },
    );
});