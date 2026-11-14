import { startServer } from "./server.js";

const handle = startServer();

process.once("SIGINT", () => {
  void handle.close().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void handle.close().finally(() => process.exit(0));
});
