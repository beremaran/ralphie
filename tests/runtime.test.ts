import { describe, expect, test } from "bun:test";

import { makeProgressRecorder } from "../src/progress/progress.ts";
import { makeLiveRuntime } from "../src/runtime.ts";

describe("runtime factory", () => {
    test("instantiates the read-only pipeline snapshot service", () => {
        const runtime = makeLiveRuntime({
            pi: {
                start: async () => {
                    throw new Error(
                        "Pi must not start while assembling runtime",
                    );
                },
            },
            progress: makeProgressRecorder([]),
        });

        expect(runtime.pipelineSnapshot).toBeDefined();
        expect(runtime.pipelineSnapshot.collect).toBeFunction();
        expect(runtime.pipelineSnapshot.read).toBe(
            runtime.pipelineSnapshot.collect,
        );
        expect(runtime.pipelineObservation).toBeDefined();
        expect(runtime.pipelineObservation.observe).toBeFunction();
    });
});