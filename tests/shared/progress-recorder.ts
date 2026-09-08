import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/progress/progress.ts";

export const makeTestProgressRecorder = (
    events: ProgressUpdate[],
): ProgressReporterService => ({
    emit: async (event) => {
        events.push(event);
    },
    stopPersisting: async () => {},
});