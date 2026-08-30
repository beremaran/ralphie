import { describe, expect, test } from "bun:test";

import {
    DEFAULT_BREADCRUMB_THRESHOLD,
    canonicalBreadcrumbKey,
    makeBreadcrumbPolicy,
} from "../../src/progress/breadcrumb.ts";

describe("breadcrumb policy", () => {
    test("suppresses candidates before the first threshold", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 30 });

        const decision = policy.consider(29, "implementation");

        expect(DEFAULT_BREADCRUMB_THRESHOLD).toBe(30);
        expect(decision.emit).toBe(false);
        expect(decision.reason).toBe("below-threshold");
        expect(policy.getState()).toEqual({
            renderedOutputBaseline: 0,
            processedPeriodicCrossings: 0,
        });
    });

    test("emits at the exact first threshold transition", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 30 });

        const decision = policy.consider({
            visibleLinePosition: 30,
            key: "implementation",
        });

        expect(decision.emit).toBe(true);
        expect(decision.crossings).toEqual([1]);
        expect(policy.getState()).toEqual({
            renderedOutputBaseline: 30,
            processedPeriodicCrossings: 0,
            lastEmittedCanonicalKey: "implementation",
        });
    });

    test("processes every crossing in one large output event", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 30 });

        const decision = policy.consider(131, "implementation");

        expect(decision.emit).toBe(true);
        expect(decision.crossings).toEqual([1, 2, 3, 4]);
        expect(decision.crossingCount).toBe(4);
        expect(policy.consider(131, "next lifecycle").emit).toBe(false);
    });

    test("de-duplicates adjacent sanitized keys without changing cadence", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 10 });

        expect(policy.consider(10, "\u001b[32mBuild\u001b[0m").emit).toBe(true);
        const duplicate = policy.consider(20, "  Build\n").emit;
        expect(duplicate).toBe(false);
        expect(policy.getState().processedPeriodicCrossings).toBe(1);

        const unequal = policy.consider(30, "Test");
        expect(unequal.emit).toBe(true);
        expect(unequal.canonicalKey).toBe("Test");
    });

    test("a duplicate still consumes a large event's crossings", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 30 });

        expect(policy.consider(30, "same").emit).toBe(true);
        const duplicate = policy.consider(131, "same");
        expect(duplicate.emit).toBe(false);
        expect(duplicate.crossings).toEqual([1, 2, 3]);

        const noNewOutput = policy.consider(131, "different");
        expect(noNewOutput.emit).toBe(false);
        expect(noNewOutput.reason).toBe("below-threshold");
        expect(policy.consider(161, "different").emit).toBe(true);
    });

    test("canonicalizes keys at the de-duplication boundary", () => {
        expect(
            canonicalBreadcrumbKey(
                "\u001b[31m  context\ncompaction  \u001b[0m",
            ),
        ).toBe("context compaction");
    });
});