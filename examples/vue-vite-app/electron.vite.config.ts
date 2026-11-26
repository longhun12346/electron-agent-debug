import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "electron-vite";

// APP_ESM=true builds the main process as ES modules (index.mjs), the way a project with "type": "module" gets it.
const esm = process.env.APP_ESM === "true";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The search index runs in a utility process, so it is a second entry next to the main process.
        input: { index: resolve("src/main/index.ts"), indexer: resolve("src/main/indexer.ts") },
        output: esm ? { format: "es", entryFileNames: "[name].mjs" } : {},
      },
    },
  },
  preload: {},
  renderer: {
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    plugins: [vue()],
  },
});
