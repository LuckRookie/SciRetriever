import { acquireCatalogWriteLock } from "../write-admission.js";

/** A separate OS-held lease; never holds the business write lock across model/network work. */
export function acquireExecutionRuntime(catalog: string) {
  return acquireCatalogWriteLock(`${catalog}.execution-runtime`);
}

/** One SQLite connection's runs share a lease; another connection/process must acquire its own. */
export class ExecutionRuntimeOwner {
  private users = 0;
  private lease: Promise<{ release(): Promise<void> }> | undefined;
  private releasing: Promise<void> = Promise.resolve();

  constructor(
    private readonly acquire: () => Promise<{ release(): Promise<void> }>,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const lease = (this.lease ??= this.releasing.then(this.acquire));
    this.users++;
    try {
      await lease;
      return await operation();
    } finally {
      this.users--;
      if (this.users === 0) {
        this.lease = undefined;
        // Admission must wait until the preceding OS lease has fully released.
        this.releasing = lease.then(
          (held) => held.release(),
          () => undefined,
        );
        await this.releasing;
      }
    }
  }
}
