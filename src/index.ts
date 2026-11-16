#!/usr/bin/env node

import { runBatchFromStdin } from "./batch.js";
import { startServer } from "./server.js";

if (process.argv.length === 3 && process.argv[2] === "--run") {
  void runBatchFromStdin();
} else {
  const handle = startServer();

  process.once("SIGINT", () => {
    void handle.close().finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void handle.close().finally(() => process.exit(0));
  });
}
