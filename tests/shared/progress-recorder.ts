import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/progress/ports.ts";

export const makeTestProgressRecorder = (
    events: ProgressUpdate[],
): ProgressReporterService => ({
    emit: async (event) => {
        events.push(event);
    },
});