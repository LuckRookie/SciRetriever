import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Session worktrees under .claude/ are other checkouts, not this one.
    exclude: [...configDefaults.exclude, "sandbox/**", ".claude/**"],
    // Many files start Chromium or servers; on a shared machine every core busy
    // turns the default 5 s limits into timeouts, so leave half the cores free.
    maxWorkers: "50%",
    // One budget for every test and hook (Playwright pages in tests use the same
    // 20 s); tests that state a longer limit keep it.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
