import { createRequire } from "node:module";

// Repository builds read package.json; the Skill bundler embeds this value at build time.
export const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
