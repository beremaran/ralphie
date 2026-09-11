import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/core/ports/progress.ts";

export const makeTestProgressRecorder = (
    events: ProgressUpdate[],
): ProgressReporterService => ({
    emit: async (event) => {
        events.push(event);
    },
});