import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_CITATION_RETRIES,
  type StableFailure,
} from "@sciretriever/contracts";
import type { CitationProviderState } from "./citation-checkpoint.js";

const RETRY_MINUTES = [1, 5, 15, 60, 60, 60] as const satisfies {
  readonly length: typeof MAX_CITATION_RETRIES;
};
const RATE_LIMITED = "metadata-provider-rate-limited";

export interface CitationClock {
  now(): number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export const citationClock: CitationClock = {
  now: Date.now,
  async wait(milliseconds, signal) {
    await delay(Math.min(milliseconds, 2_147_483_647), undefined, { signal });
  },
};

export function isCitationRateLimit(failure: StableFailure | null) {
  return failure?.code === RATE_LIMITED;
}

export function coolCitationSource(
  state: CitationProviderState,
  failure: StableFailure,
  retryAfter: number | undefined,
  now: number,
) {
  const previous = state.cooldown;
  const retries =
    (previous?.retries ?? 0) + (previous?.until !== undefined ? 1 : 0);
  const disabled = retries >= MAX_CITATION_RETRIES;
  const declared =
    retryAfter !== undefined &&
    Number.isSafeInteger(retryAfter) &&
    retryAfter >= 0
      ? retryAfter
      : undefined;
  const until = disabled
    ? null
    : Math.min(8.64e15, now + (declared ?? RETRY_MINUTES[retries]! * 60_000));
  state.cooldown = { retries, until, failure };
  if (disabled) {
    state.terminal = "FAILED";
    state.failure ??= failure;
  }
  return {
    status: disabled ? "disabled" : "cooling",
    retries,
    next_retry_at: until === null ? null : new Date(until).toISOString(),
    reason: failure,
  };
}
