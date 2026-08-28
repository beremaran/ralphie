import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../../src/github/issues.ts";
import { assertProtectedDecisionsAuthorized } from "../../src/issues/scope-policy.ts";

const issue = (body: string): GitHubIssue => ({
    number: 75,
    title: "Package the CLI",
    url: "issue/75",
    body,
    labels: [],
});

const licenseDiff = `diff --git a/LICENSE b/LICENSE
new file mode 100644
+++ b/LICENSE
@@
+MIT License
diff --git a/package.json b/package.json
@@
+  "license": "MIT"`;

describe("protected issue decisions", () => {
    test("rejects an unapproved license selection", () => {
        expect(() =>
            assertProtectedDecisionsAuthorized(
                issue("Create a publishable package."),
                licenseDiff,
            ),
        ).toThrow("without explicit authorization");
    });

    test("accepts the exact license explicitly selected by the issue", () => {
        expect(() =>
            assertProtectedDecisionsAuthorized(
                issue("Use the MIT license for the package."),
                licenseDiff,
            ),
        ).not.toThrow();
    });
});