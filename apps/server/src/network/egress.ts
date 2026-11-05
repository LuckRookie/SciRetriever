import type { NetworkEgress } from "@sciretriever/contracts";
import { AsyncLocalStorage } from "node:async_hooks";

/** Process-local only. Authentication capabilities must never be serialized. */
export interface OutboundEgress {
  readonly mode: NetworkEgress;
  readonly proxy?: {
    readonly origin: string;
    readonly authorization?: () => Promise<string | null>;
  };
}
const observers = new AsyncLocalStorage<(value: NetworkEgress) => void>();
export function observeNetworkEgress<T>(
  notify: (value: NetworkEgress) => void,
  work: () => Promise<T>,
): Promise<T> {
  return observers.run(notify, work);
}
export function networkEgressSelected(value: NetworkEgress): void {
  observers.getStore()?.(value);
}

export class ProxyUnavailableError extends Error {
  readonly code = "proxy-unavailable" as const;
  constructor() {
    super("outbound proxy is unavailable");
    this.name = "ProxyUnavailableError";
  }
}
export function isProxyUnavailable(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length && visited.size < 32) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) continue;
    visited.add(current);
    if (
      current instanceof ProxyUnavailableError ||
      (current as Error & { code?: unknown }).code === "proxy-unavailable"
    )
      return true;
    pending.push(current.cause);
    if (current instanceof AggregateError)
      pending.push(...current.errors.slice(0, 32));
  }
  return false;
}
