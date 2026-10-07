import { getDomain } from "tldts";

// Verified platform aliases, not page selectors or publisher-name guesses.
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "sciencedirect.com": "elsevier.com",
  "sciencedirectassets.com": "elsevier.com",
});
const TRANSIT_DOMAINS = new Set([
  "doi.org",
  "crossref.org",
  "auth0.com",
  "cloudflare.com",
  "challenges.cloudflare.com",
]);

/** A landing/navigation hostname supplies platform evidence; metadata text does not. */
export function browserPlatform(url: string | null): string | null {
  if (url === null) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const domain = getDomain(hostname, { allowPrivateDomains: true });
  if (!domain || TRANSIT_DOMAINS.has(domain)) return null;
  return ALIASES[domain] ?? domain;
}

export interface BrowserAccessPolicy {
  readonly minimum_start_interval: number | null;
  readonly maximum_starts_per_window: number | null;
  readonly window_seconds: number | null;
  readonly cooldown_after_completion: number | null;
  readonly rate_limit_cooldown: number | null;
  readonly failure_cooldown: number | null;
  readonly runtime_failure_threshold: number | null;
}
export type BrowserAccessEnd =
  | { readonly kind: "completed" | "cancelled" | "failure" | "runtime-failure" }
  | { readonly kind: "rate-limited"; readonly retry_after_ms?: number };

export interface BrowserPlatformLease {
  readonly platform: string;
  /** Marks the actual first admitted article request; repeated subrequests are free. */
  start(): Promise<void>;
  release(outcome: BrowserAccessEnd): void;
}

interface Waiter {
  readonly session: string;
  readonly platform: string;
  readonly signal: AbortSignal;
  readonly resolve: (lease: BrowserPlatformLease) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
}

export class BrowserPlatformQuarantinedError extends Error {
  readonly code = "browser-session-cleanup-failed" as const;
  constructor() {
    super("The Browser platform has unconfirmed network cleanup.");
  }
}

/** Process-local article admission. One lease covers subrequests and its main download. */
export class BrowserPlatformScheduler {
  private readonly occupied = new Map<string, string>();
  private readonly quarantined = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private readonly starts: number[] = [];
  private readonly startQueue: {
    platform: string;
    dispatch: () => void;
    cancel: () => void;
  }[] = [];
  private nextStart = 0;
  private aggregateCooldown = 0;
  private aggregateRateCooldown = 0;
  private runtimeFailures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly policy: Partial<BrowserAccessPolicy>;
  private readonly changed: () => void;

  constructor(
    options: {
      readonly policy?: Partial<BrowserAccessPolicy>;
      readonly now?: () => number;
      readonly cooldown_ms?: number;
      readonly changed?: () => void;
    } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.cooldownMs = options.cooldown_ms ?? 30_000;
    this.policy = Object.freeze({ ...options.policy });
    this.changed = options.changed ?? (() => undefined);
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 0)
      throw new TypeError("invalid Browser platform cooldown");
  }

  /** Allows the session broker to avoid retaining pages for an ineligible platform. */
  ready(platform: string): boolean {
    return (
      !this.closed &&
      !this.occupied.has(platform) &&
      this.readyAt(platform) <= this.now()
    );
  }

  delayMs(platform: string): number {
    return this.occupied.has(platform)
      ? Infinity
      : Math.max(0, this.readyAt(platform) - this.now());
  }

  unavailable(): boolean {
    return (
      this.closed ||
      Boolean(
        this.policy.runtime_failure_threshold &&
          this.runtimeFailures >= this.policy.runtime_failure_threshold,
      )
    );
  }

  acquire(
    session: string,
    platform: string,
    signal: AbortSignal,
  ): Promise<BrowserPlatformLease> {
    if (this.quarantined.has(platform))
      return Promise.reject(new BrowserPlatformQuarantinedError());
    if (this.closed || signal.aborted)
      return Promise.reject(
        new DOMException("Browser platform admission cancelled", "AbortError"),
      );
    if (
      [...this.occupied.values()].includes(session) ||
      this.waiters.some((w) => w.session === session)
    )
      return Promise.reject(
        new Error("Browser session already owns or awaits a platform"),
      );
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        session,
        platform,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(
            new DOMException(
              "Browser platform admission cancelled",
              "AbortError",
            ),
          );
          this.pump();
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
      else this.pump();
    });
  }

  /** Refuse waiters without releasing an owner whose network stop is unproven. */
  quarantine(platform: string): void {
    this.quarantined.add(platform);
    for (const waiter of [...this.waiters]) {
      if (waiter.platform !== platform) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new BrowserPlatformQuarantinedError());
    }
    this.pump();
  }

  /** Shared rate-limit evidence can arrive before an article releases its lease. */
  rateLimited(platform: string, retryAfterMs?: number): void {
    const delay = Math.max(
      60_000,
      (this.policy.rate_limit_cooldown ?? 0) * 1000,
      retryAfterMs ?? 0,
    );
    if (!Number.isFinite(delay) || delay < 0)
      throw new TypeError("invalid Browser retry delay");
    const until = this.now() + delay;
    this.cooldowns.set(
      platform,
      Math.max(this.cooldowns.get(platform) ?? 0, until),
    );
    if (
      this.policy.rate_limit_cooldown !== undefined &&
      this.policy.rate_limit_cooldown !== null
    ) {
      this.aggregateCooldown = Math.max(this.aggregateCooldown, until);
      this.aggregateRateCooldown = Math.max(this.aggregateRateCooldown, until);
    }
    this.pump();
  }

  /** Local file validation can fail after the network lease has already ended. */
  failed(runtime = false): void {
    if (runtime) this.runtimeFailures++;
    this.aggregateCooldown = Math.max(
      this.aggregateCooldown,
      this.now() + (this.policy.failure_cooldown ?? 0) * 1000,
    );
    this.pump();
  }

  snapshot(): {
    readonly active: number;
    readonly queued: number;
    readonly recent_starts: number;
    readonly runtime_failures: number;
  } {
    this.trimStarts();
    return {
      active: this.occupied.size,
      queued: this.waiters.length,
      recent_starts: this.starts.length,
      runtime_failures: this.runtimeFailures,
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const pending of this.startQueue.splice(0)) pending.cancel();
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(
        new DOMException("Browser platform scheduler closed", "AbortError"),
      );
    }
  }

  private trimStarts(): void {
    const windowMs = (this.policy.window_seconds ?? 0) * 1000;
    while (this.starts.length && this.starts[0]! + windowMs <= this.now())
      this.starts.shift();
  }

  private readyAt(platform: string): number {
    if (this.quarantined.has(platform)) return Infinity;
    this.trimStarts();
    if (
      this.policy.runtime_failure_threshold &&
      this.runtimeFailures >= this.policy.runtime_failure_threshold
    )
      return Infinity;
    const maximum = this.policy.maximum_starts_per_window;
    const windowEnd =
      maximum && this.starts.length >= maximum
        ? this.starts[this.starts.length - maximum]! +
          (this.policy.window_seconds ?? 0) * 1000
        : 0;
    return Math.max(
      this.cooldowns.get(platform) ?? 0,
      this.nextStart,
      this.aggregateCooldown,
      windowEnd,
    );
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let next = Infinity;
    for (const pending of [...this.startQueue]) {
      const at = this.readyAt(pending.platform);
      if (at > this.now()) {
        next = Math.min(next, at);
        continue;
      }
      this.startQueue.splice(this.startQueue.indexOf(pending), 1);
      const startedAt = this.now();
      this.starts.push(startedAt);
      this.nextStart =
        startedAt + (this.policy.minimum_start_interval ?? 0) * 1000;
      pending.dispatch();
    }
    for (const waiter of [...this.waiters]) {
      if (this.occupied.has(waiter.platform)) continue;
      const at = this.readyAt(waiter.platform);
      if (at > this.now()) {
        next = Math.min(next, at);
        continue;
      }
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.occupied.set(waiter.platform, waiter.session);
      let started = false;
      let released = false;
      let startPromise: Promise<void> | undefined;
      let cancelStart: (() => void) | undefined;
      waiter.resolve({
        platform: waiter.platform,
        start: () => {
          if (released || this.closed || waiter.signal.aborted)
            return Promise.reject(
              new DOMException(
                "Browser platform lease is inactive",
                "AbortError",
              ),
            );
          // A previously admitted article does not get to bypass a later 429.
          // The owning driver suspends and reacquires after the shared delay.
          if (
            started &&
            Math.max(
              this.cooldowns.get(waiter.platform) ?? 0,
              this.aggregateRateCooldown,
            ) > this.now()
          )
            return Promise.reject(new Error("browser-platform-rate-limited"));
          if (startPromise) return startPromise;
          startPromise = new Promise<void>((resolve, reject) => {
            const cleanup = () =>
              waiter.signal.removeEventListener("abort", cancel);
            const cancel = () => {
              const index = this.startQueue.indexOf(pending);
              if (index >= 0) this.startQueue.splice(index, 1);
              cleanup();
              reject(
                new DOMException(
                  "Browser platform start cancelled",
                  "AbortError",
                ),
              );
            };
            const pending = {
              platform: waiter.platform,
              dispatch: () => {
                started = true;
                cleanup();
                resolve();
              },
              cancel,
            };
            cancelStart = cancel;
            this.startQueue.push(pending);
            waiter.signal.addEventListener("abort", cancel, { once: true });
          });
          this.pump();
          return startPromise;
        },
        release: (outcome) => {
          if (released) return;
          released = true;
          if (!started) cancelStart?.();
          this.occupied.delete(waiter.platform);
          const at = this.now();
          if (started) {
            this.cooldowns.set(
              waiter.platform,
              Math.max(
                this.cooldowns.get(waiter.platform) ?? 0,
                at + this.cooldownMs,
              ),
            );
            if (outcome.kind === "rate-limited")
              this.rateLimited(waiter.platform, outcome.retry_after_ms);
            if (outcome.kind === "runtime-failure") this.runtimeFailures++;
            if (outcome.kind === "completed") this.runtimeFailures = 0;
            const cooldown =
              outcome.kind === "failure" || outcome.kind === "runtime-failure"
                ? this.policy.failure_cooldown
                : this.policy.cooldown_after_completion;
            this.aggregateCooldown = Math.max(
              this.aggregateCooldown,
              at + (cooldown ?? 0) * 1000,
            );
          }
          this.pump();
        },
      });
    }
    if (Number.isFinite(next))
      this.timer = setTimeout(
        () => this.pump(),
        Math.max(1, Math.ceil(next - this.now())),
      );
    this.changed();
  }
}
