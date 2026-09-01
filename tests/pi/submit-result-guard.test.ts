import { describe, expect, test } from "bun:test";

import { makeSubmitResultGuard } from "../../src/pi/submit-result-guard.ts";

describe("submit_result circuit breaker", () => {
    test("allows attempts below the failure limit", () => {
        const guard = makeSubmitResultGuard(3);
        let aborts = 0;
        guard.onTrip(() => {
            aborts += 1;
        });

        for (let attempt = 0; attempt < 3; attempt += 1) {
            guard.beginAttempt({ disposition: "actionable" });
            guard.recordFailure("validation failed");
        }

        expect(guard.isTripped()).toBe(false);
        expect(aborts).toBe(0);
    });

    test("trips when a new attempt starts after the failure limit", () => {
        const guard = makeSubmitResultGuard(3);
        let aborts = 0;
        guard.onTrip(() => {
            aborts += 1;
        });

        for (let attempt = 0; attempt < 3; attempt += 1) {
            guard.beginAttempt({ disposition: "actionable" });
            guard.recordFailure("validation failed");
        }
        guard.beginAttempt({ disposition: "actionable" });

        expect(guard.isTripped()).toBe(true);
        expect(aborts).toBe(1);
        expect(guard.tripReason()).toContain(
            "submit_result failed 3 consecutive attempts",
        );
        expect(guard.tripReason()).toContain("last failure: validation failed");
        expect(guard.tripReason()).toContain("aborting the session");
    });

    test("reports dropped tool-call arguments as the likely cause", () => {
        const guard = makeSubmitResultGuard(1);

        guard.beginAttempt({});
        guard.beginAttempt({});

        expect(guard.tripReason()).toContain("empty arguments");
        expect(guard.tripReason()).toContain("dropped the tool-call arguments");
    });

    test("treats non-object arguments as empty", () => {
        const guard = makeSubmitResultGuard(1);

        guard.beginAttempt("garbage");
        guard.beginAttempt(undefined);

        expect(guard.tripReason()).toContain("empty arguments");
    });

    test("a successful attempt resets the consecutive failure count", () => {
        const guard = makeSubmitResultGuard(3);
        let aborts = 0;
        guard.onTrip(() => {
            aborts += 1;
        });

        for (let attempt = 0; attempt < 3; attempt += 1) {
            guard.beginAttempt({ disposition: "actionable" });
            guard.recordFailure("validation failed");
            guard.recordSuccess();
        }

        expect(guard.isTripped()).toBe(false);

        guard.beginAttempt({ disposition: "actionable" });
        guard.beginAttempt({ disposition: "actionable" });
        guard.beginAttempt({ disposition: "actionable" });
        expect(guard.isTripped()).toBe(false);
        guard.beginAttempt({ disposition: "actionable" });
        expect(guard.isTripped()).toBe(true);
        expect(aborts).toBe(1);
    });

    test("stops observing after tripping and aborts only once", () => {
        const guard = makeSubmitResultGuard(1);
        let aborts = 0;
        guard.onTrip(() => {
            aborts += 1;
        });

        guard.beginAttempt({ disposition: "actionable" });
        guard.recordFailure("first failure");
        guard.beginAttempt({ disposition: "actionable" });
        expect(guard.isTripped()).toBe(true);
        expect(guard.tripReason()).toContain("first failure");

        guard.beginAttempt({ disposition: "actionable" });
        guard.recordFailure("later failure");
        guard.beginAttempt({});

        expect(aborts).toBe(1);
        expect(guard.tripReason()).toContain("first failure");
        expect(guard.tripReason()).not.toContain("empty arguments");
    });
});