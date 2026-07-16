import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep workspace scripts rooted at the monorepo even when npm changes cwd.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
