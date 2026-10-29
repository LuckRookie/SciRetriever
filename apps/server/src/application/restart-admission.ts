import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import {
  acquireRestartLock,
  WriteAdmissionError,
} from "../storage/write-admission.js";

type Lease = { release(): Promise<void> };
type Kind = "foreground" | "probes" | "browser_transfers";
interface Scope {
  active: boolean;
  identities: readonly string[];
}
const scope = new AsyncLocalStorage<Scope>();
const counts = new Map<string, Record<Kind, number>>();
const permits = new WeakSet<object>();
const frozenHomes = new Set<string>();
/** Incoming transport work must never inherit an internal startup/execution permit. */
export function withoutRestartAdmission<T>(work: () => T): T {
  return scope.exit(work);
}
export interface RestartBootstrapPermit {
  readonly parent_pid: number;
}
/** Internal IPC handoff only. A wire object is never itself a bootstrap capability. */
export function issueRestartBootstrapPermit(
  parentPid: number,
): RestartBootstrapPermit {
  if (!process.connected || process.ppid !== parentPid)
    throw new RestartAdmissionError("restart-bootstrap-invalid");
  const permit = Object.freeze({ parent_pid: parentPid });
  permits.add(permit);
  return permit;
}
export class RestartAdmissionError extends Error {
  constructor(
    readonly code:
      | "configuration-apply-busy"
      | "restart-bootstrap-invalid"
      | "restart-admission-expired",
  ) {
    super("runtime admission failed");
  }
}
export class RestartAdmission {
  readonly identities: readonly string[];
  constructor(
    readonly home: string,
    readonly catalog?: string | readonly string[],
  ) {
    this.identities = Object.freeze(
      [
        ...new Set([
          join(resolve(home), ".sciretriever", "runtime"),
          ...(catalog
            ? (Array.isArray(catalog) ? catalog : [catalog]).map((p) =>
                resolve(p),
              )
            : []),
        ]),
      ].sort(),
    );
  }
  freeze(value: boolean): void {
    if (value) frozenHomes.add(resolve(this.home));
    else frozenHomes.delete(resolve(this.home));
  }
  blockers(): Record<Kind, number> {
    return {
      ...(counts.get(resolve(this.home)) ?? {
        foreground: 0,
        probes: 0,
        browser_transfers: 0,
      }),
    };
  }
  async newWork<T>(
    work: () => Promise<T>,
    kind: Kind = "foreground",
  ): Promise<T> {
    const current = scope.getStore();
    if (
      current?.active &&
      this.identities.every((id) => current.identities.includes(id))
    )
      return work();
    // Long-lived HTTP/queue callbacks may inherit startup's expired ALS context.
    // They must acquire fresh permits; an expired scope never grants admission.
    if (frozenHomes.has(resolve(this.home)))
      throw new RestartAdmissionError("configuration-apply-busy");
    const intent = await this.acquire("intent", "shared");
    let activity: Lease | undefined;
    try {
      if (frozenHomes.has(resolve(this.home)))
        throw new RestartAdmissionError("configuration-apply-busy");
      activity = await this.acquire("activity", "shared");
    } finally {
      await intent.release();
    }
    return this.owned(activity, work, kind);
  }
  /** Only actual task/probe owners call this after durable registration or while intent is held. */
  async continuation<T>(
    work: () => Promise<T>,
    kind: Kind = "foreground",
  ): Promise<T> {
    const activity = await this.acquire("activity", "shared");
    return this.owned(activity, work, kind);
  }
  async background<T>(
    work: () => Promise<T>,
    kind: Kind = "probes",
  ): Promise<{ promise: Promise<T> }> {
    const activity = await this.acquire("activity", "shared");
    const promise = this.owned(activity, work, kind);
    void promise.catch(() => undefined);
    return { promise };
  }
  async bootstrap<T>(
    work: () => Promise<T>,
    permit?: RestartBootstrapPermit,
  ): Promise<T> {
    if (permit) {
      if (
        !permits.delete(permit) ||
        process.ppid !== permit.parent_pid ||
        !process.connected
      )
        throw new RestartAdmissionError("restart-bootstrap-invalid");
      const value = { active: true, identities: this.identities };
      try {
        return await scope.run(value, work);
      } finally {
        value.active = false;
      }
    }
    return this.newWork(work);
  }
  private async owned<T>(
    lease: Lease,
    work: () => Promise<T>,
    kind: Kind,
  ): Promise<T> {
    const key = resolve(this.home),
      c = counts.get(key) ?? { foreground: 0, probes: 0, browser_transfers: 0 };
    counts.set(key, c);
    c[kind]++;
    const value = { active: true, identities: this.identities };
    try {
      return await scope.run(value, work);
    } finally {
      value.active = false;
      c[kind]--;
      await lease.release();
    }
  }
  async acquire(
    phase: "intent" | "activity",
    mode: "shared" | "exclusive",
  ): Promise<Lease> {
    const leases: Lease[] = [];
    try {
      for (const id of this.identities)
        leases.push(await acquireRestartLock(id, phase, mode));
    } catch (error) {
      await Promise.all(leases.reverse().map((l) => l.release()));
      if (
        error instanceof WriteAdmissionError &&
        error.code === "write-admission-conflict"
      )
        throw new RestartAdmissionError("configuration-apply-busy");
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await Promise.all(leases.reverse().map((l) => l.release()));
      },
    };
  }
}
/**
 * Copies plain request data (objects and arrays) at call time, so a caller
 * that changes its object while the call waits for admission cannot change
 * the request. Functions, signals and class instances pass through as they are.
 */
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, snapshot(item)]),
  );
}
/** Preserve each service's concrete receiver; internal calls share the admitted outer operation. */
export function guardRuntimeMethods<T extends object>(
  target: T,
  methods: readonly (keyof T)[],
  admission: RestartAdmission,
  continuation?: (method: keyof T, args: readonly unknown[]) => boolean,
): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object) as unknown;
      if (typeof value !== "function") return value;
      const invoke = (...args: unknown[]) =>
        Reflect.apply(value, object, args) as unknown;
      return methods.includes(key as keyof T)
        ? (...given: unknown[]) => {
            const args = given.map(snapshot);
            return continuation?.(key as keyof T, args)
              ? admission.continuation(async () => invoke(...args))
              : admission.newWork(async () => invoke(...args));
          }
        : invoke;
    },
  });
}
