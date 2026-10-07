import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitForBrowserAgentCooldown,
  DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
} from "../src/browser/pacing.js";

describe("Browser Agent pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the fixed interval before allowing the next decision", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    let settled = false;
    const pending = waitForBrowserAgentCooldown(
      DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
      signal,
    ).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(
      DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS - 1,
    );
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
  });

  it("cancels the interval without leaving a timer behind", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForBrowserAgentCooldown(10_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
