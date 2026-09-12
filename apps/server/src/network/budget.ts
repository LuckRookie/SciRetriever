export class NetworkBudgetError extends Error {
  readonly code = "network-budget" as const;
  constructor() {
    super("network budget operation failed");
    this.name = "NetworkBudgetError";
  }
}

export interface BudgetLimits {
  readonly maxConcurrency: number;
  readonly maxHostConcurrency?: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly maxRetries: number;
  readonly maxRetryAfterMs?: number;
}

export interface BudgetAcquireOptions {
  signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly usage?: BudgetUsage;
}

export interface BudgetUsage {
  readonly limits: BudgetLimits;
  consumeResponse(bytes: number): void;
  consumeRedirect(): void;
  consumeRetry(): void;
}

export interface BudgetPermit {
  readonly scope: string;
  readonly host: string;
  readonly limits: BudgetLimits;
  consumeResponse(bytes: number): void;
  consumeRedirect(): void;
  consumeRetry(): void;
  release(): void;
}

export interface BudgetClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: BudgetClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

interface Waiter {
  readonly scope: string;
  readonly host: string;
  readonly limits: BudgetLimits;
  readonly usage: BudgetUsage;
  readonly resolve: (permit: BudgetPermit) => void;
  readonly reject: (error: NetworkBudgetError) => void;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  abort: (() => void) | undefined;
  active: boolean;
}

interface State {
  active: number;
  maxConcurrency: number;
  retryAfter: Map<string, number>;
  queue: Waiter[];
}

function invalid(): never {
  throw new NetworkBudgetError();
}
function checkName(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 253 ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  )
    invalid();
}
function checkLimits(limits: BudgetLimits): BudgetLimits {
  if (typeof limits !== "object" || limits === null) invalid();
  const positiveValues = [limits.maxConcurrency, limits.maxResponseBytes];
  if (
    positiveValues.some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    !Number.isSafeInteger(limits.maxRedirects) ||
    limits.maxRedirects < 0 ||
    !Number.isSafeInteger(limits.maxRetries) ||
    limits.maxRetries < 0
  )
    invalid();
  if (
    limits.maxHostConcurrency !== undefined &&
    (!Number.isSafeInteger(limits.maxHostConcurrency) ||
      limits.maxHostConcurrency <= 0)
  )
    invalid();
  if (
    limits.maxRetryAfterMs !== undefined &&
    (!Number.isSafeInteger(limits.maxRetryAfterMs) ||
      limits.maxRetryAfterMs < 0)
  )
    invalid();
  return Object.freeze({ ...limits });
}
function checkNonnegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

export function createBudgetUsage(limits: BudgetLimits): BudgetUsage {
  const checked = checkLimits(limits);
  let responseBytes = 0;
  let redirects = 0;
  let retries = 0;
  return {
    limits: checked,
    consumeResponse: (bytes) => {
      checkNonnegativeInteger(bytes);
      responseBytes += bytes;
      if (responseBytes > checked.maxResponseBytes) invalid();
    },
    consumeRedirect: () => {
      if (++redirects > checked.maxRedirects) invalid();
    },
    consumeRetry: () => {
      if (++retries > checked.maxRetries) invalid();
    },
  };
}

export class NetworkBudgetCoordinator {
  private readonly states = new Map<string, State>();
  private readonly hostActive = new Map<string, number>();
  private readonly hostLimits = new Map<string, number>();
  private readonly clock: BudgetClock;

  constructor(clock: BudgetClock = systemClock) {
    this.clock = clock;
  }

  acquire(
    scope: string,
    host: string,
    limits: BudgetLimits,
    options: BudgetAcquireOptions = {},
  ): Promise<BudgetPermit> {
    checkName(scope);
    checkName(host);
    const checked = checkLimits(limits);
    if (typeof options !== "object" || options === null) invalid();
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    )
      invalid();
    if (
      options.signal !== undefined &&
      !(options.signal instanceof AbortSignal)
    )
      invalid();
    const state: State = this.states.get(scope) ?? {
      active: 0,
      maxConcurrency: checked.maxConcurrency,
      retryAfter: new Map(),
      queue: [],
    };
    state.maxConcurrency = Math.min(
      state.maxConcurrency,
      checked.maxConcurrency,
    );
    const hostLimit = checked.maxHostConcurrency ?? checked.maxConcurrency;
    this.hostLimits.set(
      host,
      Math.min(this.hostLimits.get(host) ?? hostLimit, hostLimit),
    );
    this.states.set(scope, state);
    return new Promise<BudgetPermit>((resolve, reject) => {
      const waiter: Waiter = {
        scope,
        host,
        limits: checked,
        resolve,
        reject,
        usage: options.usage ?? createBudgetUsage(checked),
        abort: undefined,
        active: true,
      };
      if (options.signal !== undefined) waiter.signal = options.signal;
      waiter.abort = () => this.cancelWaiter(state, waiter);
      if (waiter.signal?.aborted) {
        waiter.active = false;
        reject(new NetworkBudgetError());
        return;
      }
      waiter.signal?.addEventListener("abort", waiter.abort, { once: true });
      if (options.timeoutMs !== undefined)
        waiter.timeout = this.clock.setTimeout(
          () => this.cancelWaiter(state, waiter),
          options.timeoutMs,
        );
      state.queue.push(waiter);
      this.pump(scope, state);
    });
  }

  applyRetryAfter(
    scope: string,
    host: string,
    seconds: number,
    limits: BudgetLimits,
  ): void {
    checkName(scope);
    checkName(host);
    const checked = checkLimits(limits);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
      invalid();
    const bounded = Math.min(
      seconds * 1000,
      checked.maxRetryAfterMs ?? 120_000,
    );
    const state: State = this.states.get(scope) ?? {
      active: 0,
      maxConcurrency: checked.maxConcurrency,
      retryAfter: new Map(),
      queue: [],
    };
    state.retryAfter.set(
      host,
      Math.max(state.retryAfter.get(host) ?? 0, this.clock.now() + bounded),
    );
    this.states.set(scope, state);
    const wake = (): void => {
      const remaining = (state.retryAfter.get(host) ?? 0) - this.clock.now();
      if (remaining > 0) {
        this.clock.setTimeout(wake, Math.max(1, Math.ceil(remaining)));
        return;
      }
      this.pump(scope, state);
    };
    this.clock.setTimeout(wake, Math.max(1, Math.ceil(bounded)));
  }

  /** Parse a response Retry-After value without allowing an unbounded delay. */
  retryAfterMilliseconds(
    value: string,
    limits: BudgetLimits,
    now = this.clock.now(),
  ): number {
    const checked = checkLimits(limits);
    if (typeof value !== "string" || /[\r\n]/u.test(value)) invalid();
    const trimmed = value.trim();
    let milliseconds: number;
    if (/^\d+$/u.test(trimmed)) {
      const seconds = Number(trimmed);
      if (!Number.isSafeInteger(seconds)) invalid();
      milliseconds = seconds * 1000;
    } else if (
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
        trimmed,
      )
    ) {
      const timestamp = Date.parse(trimmed);
      if (!Number.isFinite(timestamp)) invalid();
      milliseconds = timestamp - now;
      if (milliseconds < 0) milliseconds = 0;
    } else invalid();
    if (!Number.isSafeInteger(milliseconds)) invalid();
    return Math.min(milliseconds, checked.maxRetryAfterMs ?? 120_000);
  }

  private canGrant(state: State, waiter: Waiter): boolean {
    if (state.active >= state.maxConcurrency) return false;
    if (
      (this.hostActive.get(waiter.host) ?? 0) >=
      this.hostLimits.get(waiter.host)!
    )
      return false;
    return (state.retryAfter.get(waiter.host) ?? 0) <= this.clock.now();
  }

  private pump(scope: string, state: State): void {
    for (const waiter of [...state.queue]) {
      if (!waiter.active) continue;
      if (!this.canGrant(state, waiter)) continue;
      state.queue.splice(state.queue.indexOf(waiter), 1);
      waiter.active = false;
      if (waiter.timeout !== undefined) this.clock.clearTimeout(waiter.timeout);
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      state.active += 1;
      this.hostActive.set(
        waiter.host,
        (this.hostActive.get(waiter.host) ?? 0) + 1,
      );
      waiter.resolve(this.createPermit(scope, state, waiter));
    }
  }

  private cancelWaiter(state: State, waiter: Waiter): void {
    if (!waiter.active) return;
    waiter.active = false;
    const index = state.queue.indexOf(waiter);
    if (index >= 0) state.queue.splice(index, 1);
    if (waiter.timeout !== undefined) this.clock.clearTimeout(waiter.timeout);
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    waiter.reject(new NetworkBudgetError());
  }

  private createPermit(
    scope: string,
    state: State,
    waiter: Waiter,
  ): BudgetPermit {
    let released = false;
    return {
      scope,
      host: waiter.host,
      limits: waiter.limits,
      consumeResponse: waiter.usage.consumeResponse,
      consumeRedirect: waiter.usage.consumeRedirect,
      consumeRetry: waiter.usage.consumeRetry,
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        const count = (this.hostActive.get(waiter.host) ?? 1) - 1;
        if (count === 0) this.hostActive.delete(waiter.host);
        else this.hostActive.set(waiter.host, count);
        for (const [queuedScope, queuedState] of this.states) {
          this.pump(queuedScope, queuedState);
        }
      },
    };
  }
}
