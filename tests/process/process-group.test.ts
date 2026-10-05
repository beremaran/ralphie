import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";

const aliveAfterTimeout = async (processGroup: boolean): Promise<boolean> => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-pgroup-"));
    const marker = join(directory, "pid");
    await CommandRunnerLive.run(
        "/bin/sh",
        ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${marker}; wait`],
        { timeoutMs: 400, processGroup },
    ).catch(() => undefined);
    const pid = Number((await Bun.file(marker).text()).trim());
    await Bun.sleep(100);
    let alive = true;
    try {
        process.kill(pid, 0);
    } catch {
        alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
    return alive;
};

describe("CommandRunnerLive process groups", () => {
    test("a timeout kills descendants when the command leads a process group", async () => {
        expect(await aliveAfterTimeout(true)).toBe(false);
    });

    test("without a process group only the child is killed", async () => {
        expect(await aliveAfterTimeout(false)).toBe(true);
    });
});