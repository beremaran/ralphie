import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/ports/progress.ts";

export const makeTestProgressRecorder = (
    events: ProgressUpdate[],
): ProgressReporterService => ({
    emit: async (event) => {
        events.push(event);
    },
});