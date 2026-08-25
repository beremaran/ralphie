import { defineConfig } from "@bunli/core";

export default defineConfig({
  name: "ralphie",
  version: "0.1.0",
  description: "Run an Pi workflow against a GitHub repository",
  commands: {
    entry: "./src/cli.ts",
  },
  build: {
    entry: "./src/cli.ts",
    outdir: "./dist",
    targets: ["native"],
  },
});
