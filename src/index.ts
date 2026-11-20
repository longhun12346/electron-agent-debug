#!/usr/bin/env node

import { describeTools, runBatchFromStdin } from "./batch.js";
import { startServer } from "./server.js";

if (process.argv.length === 3 && process.argv[2] === "--run") {
  void runBatchFromStdin();
} else if (process.argv[2] === "--tools") {
  const listing = describeTools(process.argv.slice(3));
  process.stdout.write(`${JSON.stringify(listing)}\n`);
  process.exitCode = listing.ok ? 0 : 1;
} else {
  const handle = startServer();

  process.once("SIGINT", () => {
    void handle.close().finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void handle.close().finally(() => process.exit(0));
  });
}
