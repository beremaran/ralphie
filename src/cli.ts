import { createCLI } from "@bunli/core";

import { runCommand } from "./command.ts";

const cli = await createCLI({
  name: "ralphie",
  version: "0.1.0",
  description: "Run an Pi workflow against a GitHub repository",
});

cli.command(runCommand);

// Bunli is command-oriented. Prefixing the internal command preserves the
// public single-command interface: `ralphie <repo> [--branch <branch>]`.
await cli.run(["run", ...Bun.argv.slice(2)]);