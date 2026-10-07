import { statfs } from "node:fs/promises";
import type {
  TemporaryFileBudget,
  TemporaryFileLease,
} from "../storage/files/budget.js";

export type BrowserDownloadResourceCode =
  | "browser-download-temporary-quota"
  | "browser-download-disk-reserve"
  | "browser-download-disk-unavailable"
  | "browser-download-resource-ownership";

export class BrowserDownloadResourceError extends Error {
  constructor(
    readonly code: BrowserDownloadResourceCode,
    cause?: unknown,
  ) {
    super("browser download resource limit", { cause });
    this.name = "BrowserDownloadResourceError";
  }
}

interface Allocation {
  readonly transfer: string;
  readonly directory: string;
  readonly kind: "native" | "staging" | "publication-preparation";
  reserved: number;
  written: number;
  released: boolean;
}

export interface BrowserDownloadResourceOptions {
  readonly temporary_bytes?: number;
  readonly disk_reserve_bytes?: number;
  /** Offline seam: available bytes on the filesystem containing this directory. */
  readonly available_bytes?: (directory: string) => Promise<number>;
}

async function availableBytes(directory: string): Promise<number> {
  const status = await statfs(directory, { bigint: true });
  const available = status.bavail * status.bsize;
  return Number(
    available > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : available,
  );
}

/** Shared Browser owner for native originals and every Storage temporary copy. */
export class BrowserDownloadResources {
  readonly temporary_bytes: number;
  readonly disk_reserve_bytes: number;
  private readonly available: (directory: string) => Promise<number>;
  private readonly allocations = new Set<Allocation>();
  private readonly natives = new Map<string, Allocation>();
  private tail: Promise<void> = Promise.resolve();
  private peak = 0;
  private peakWritten = 0;

  constructor(options: BrowserDownloadResourceOptions = {}) {
    this.temporary_bytes = options.temporary_bytes ?? 4 * 1024 ** 3;
    this.disk_reserve_bytes = options.disk_reserve_bytes ?? 1024 ** 3;
    for (const value of [this.temporary_bytes, this.disk_reserve_bytes])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError("invalid browser download resource budget");
    this.available = options.available_bytes ?? availableBytes;
  }

  forTransfer(transferId: string): TemporaryFileBudget {
    this.checkTransfer(transferId);
    return Object.freeze({
      open: (directory: string, kind: "staging" | "publication-preparation") =>
        this.lease(this.allocate(transferId, directory, kind)),
    });
  }

  /** CDP reports already-written bytes; a rejection requires real native cancellation. */
  updateNative(
    transferId: string,
    directory: string,
    receivedBytes: number,
  ): Promise<void> {
    this.checkTransfer(transferId);
    let allocation = this.natives.get(transferId);
    if (!allocation) {
      allocation = this.allocate(transferId, directory, "native");
      this.natives.set(transferId, allocation);
    } else if (allocation.directory !== directory) {
      return Promise.reject(
        new BrowserDownloadResourceError("browser-download-resource-ownership"),
      );
    }
    return this.change(allocation, receivedBytes, true);
  }

  /** Only after the owning native writer stopped and its original was retired. */
  releaseNative(transferId: string): void {
    const allocation = this.natives.get(transferId);
    if (!allocation) return;
    this.natives.delete(transferId);
    this.release(allocation);
  }

  snapshot(): {
    readonly temporary_bytes: number;
    readonly pending_write_bytes: number;
    readonly peak_temporary_bytes: number;
    readonly peak_written_bytes: number;
    readonly native_bytes: number;
    readonly staging_bytes: number;
    readonly preparation_bytes: number;
  } {
    let total = 0;
    let pending = 0;
    let native = 0;
    let staging = 0;
    let preparation = 0;
    for (const item of this.allocations) {
      total += item.reserved;
      pending += item.reserved - item.written;
      if (item.kind === "native") native += item.reserved;
      else if (item.kind === "staging") staging += item.reserved;
      else preparation += item.reserved;
    }
    return Object.freeze({
      temporary_bytes: total,
      pending_write_bytes: pending,
      peak_temporary_bytes: this.peak,
      peak_written_bytes: this.peakWritten,
      native_bytes: native,
      staging_bytes: staging,
      preparation_bytes: preparation,
    });
  }

  private checkTransfer(transferId: string): void {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(transferId))
      throw new BrowserDownloadResourceError(
        "browser-download-resource-ownership",
      );
  }

  private allocate(
    transfer: string,
    directory: string,
    kind: Allocation["kind"],
  ): Allocation {
    if (!directory.startsWith("/"))
      throw new BrowserDownloadResourceError(
        "browser-download-resource-ownership",
      );
    const allocation: Allocation = {
      transfer,
      directory,
      kind,
      reserved: 0,
      written: 0,
      released: false,
    };
    this.allocations.add(allocation);
    return allocation;
  }

  private lease(allocation: Allocation): TemporaryFileLease {
    return Object.freeze({
      reserve: (size: number) => this.change(allocation, size, false),
      written: (size: number) => {
        if (
          allocation.released ||
          !Number.isSafeInteger(size) ||
          size < allocation.written ||
          size > allocation.reserved
        )
          throw new BrowserDownloadResourceError(
            "browser-download-resource-ownership",
          );
        allocation.written = size;
        this.observeWritten();
      },
      release: () => this.release(allocation),
    });
  }

  private release(allocation: Allocation): void {
    if (allocation.released) return;
    allocation.released = true;
    this.allocations.delete(allocation);
  }

  private observeWritten(): void {
    let bytes = 0;
    for (const allocation of this.allocations) bytes += allocation.written;
    this.peakWritten = Math.max(this.peakWritten, bytes);
  }

  private change(
    allocation: Allocation,
    size: number,
    alreadyWritten: boolean,
  ): Promise<void> {
    const operation = this.tail.then(async () => {
      if (allocation.released || !Number.isSafeInteger(size) || size < 0)
        throw new BrowserDownloadResourceError(
          "browser-download-resource-ownership",
        );
      // Terminal native notifications can reset receivedBytes to zero.
      const next = Math.max(allocation.reserved, size);
      const addition = next - allocation.reserved;
      if (alreadyWritten) {
        allocation.reserved = next;
        allocation.written = next;
        this.observeWritten();
      }
      const snapshot = this.snapshot();
      const projected =
        snapshot.temporary_bytes + (alreadyWritten ? 0 : addition);
      this.peak = Math.max(this.peak, snapshot.temporary_bytes);
      if (projected > this.temporary_bytes)
        throw new BrowserDownloadResourceError(
          "browser-download-temporary-quota",
        );
      let available: number;
      try {
        available = await this.available(allocation.directory);
        if (!Number.isSafeInteger(available) || available < 0)
          throw new Error("invalid available disk bytes");
      } catch (cause) {
        throw new BrowserDownloadResourceError(
          "browser-download-disk-unavailable",
          cause,
        );
      }
      if (allocation.released)
        throw new BrowserDownloadResourceError(
          "browser-download-resource-ownership",
        );
      if (
        available -
          snapshot.pending_write_bytes -
          (alreadyWritten ? 0 : addition) <
        this.disk_reserve_bytes
      )
        throw new BrowserDownloadResourceError("browser-download-disk-reserve");
      allocation.reserved = next;
      this.peak = Math.max(this.peak, projected);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
