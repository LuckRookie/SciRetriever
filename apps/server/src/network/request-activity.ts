import { AsyncLocalStorage } from "node:async_hooks";

// Carries no destination, headers or response data. Concurrent requests remain isolated.
const observers = new AsyncLocalStorage<() => void>();
export function observeNetworkRequests<T>(
  notify: () => void,
  action: () => Promise<T>,
): Promise<T> {
  return observers.run(notify, action);
}
/** Called only when an admitted HTTP request is dispatched, or by an offline transport seam. */
export function networkRequestDispatched(): void {
  observers.getStore()?.();
}

const responseObservers = new AsyncLocalStorage<(bytes: number) => void>();
export function observeNetworkBytes<T>(
  notify: (bytes: number) => void,
  action: () => Promise<T>,
): Promise<T> {
  return responseObservers.run(notify, action);
}
/** Byte count only, including redirects/error bodies; no response bytes leave Network. */
export function networkResponseBytes(bytes: number): void {
  responseObservers.getStore()?.(bytes);
}
