/**
 * Humanized pacing for automatic Browser Agent actions.
 *
 * The page-level WaitForChange is issued by the owning flow because it must be
 * bound to the current document generation. This module owns only the fixed,
 * cancellable inter-action delay shared by the standalone and collaborative
 * Agent loops.
 */
export const DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS = 5_000;
export const DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS = 5_000;
export const DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS = 15_000;
/**
 * A publisher PDF click can hand off to Chromium's download manager or an inline
 * viewer without changing the article DOM. Keep the Agent on that page long
 * enough for the transfer dispatcher to observe either hand-off.
 */
export const DEFAULT_BROWSER_AGENT_PDF_WAIT_FOR_CHANGE_MS = 30_000;

export function validateBrowserAgentCooldown(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000)
    throw new TypeError("invalid Browser Agent cooldown");
}

/** Resolves false when the caller signal cancels before the delay elapses. */
export function waitForBrowserAgentCooldown(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  validateBrowserAgentCooldown(delayMs);
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
