import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "sandbox/**"],
    // Many files start Chromium or servers; on a shared machine every core busy
    // turns the default 5 s limits into timeouts, so leave half the cores free.
    maxWorkers: "50%",
  },
});
