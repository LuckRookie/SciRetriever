import type { DocumentStructure } from "@sciretriever/contracts";
import type { FileFingerprint } from "../storage/files/reader.js";

export interface DocumentVerificationProof {
  readonly declarations: string;
  readonly fingerprints: ReadonlyMap<string, FileFingerprint>;
  readonly markdown: Uint8Array;
  readonly structure: DocumentStructure;
  readonly weight: number;
}
export interface DocumentVerificationCacheLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}
interface PendingVerification {
  readonly declarations: string;
  readonly controller: AbortController;
  readonly promise: Promise<DocumentVerificationProof>;
  users: number;
}

/** Process-local proofs, owned by one document reader and FileStore. */
export class DocumentVerificationCache {
  private readonly entries = new Map<string, DocumentVerificationProof>();
  private readonly pending = new Map<string, PendingVerification>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(limits: DocumentVerificationCacheLimits = {}) {
    this.maxEntries = limits.maxEntries ?? 16;
    this.maxBytes = limits.maxBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 0
    )
      throw new Error("document verification cache limits invalid");
  }
  get(
    key: string,
    declarations: string,
  ): DocumentVerificationProof | undefined {
    const proof = this.entries.get(key);
    if (proof?.declarations === declarations) return proof;
    this.delete(key);
    return undefined;
  }
  delete(key: string): void {
    const proof = this.entries.get(key);
    if (proof) this.bytes -= proof.weight;
    this.entries.delete(key);
  }
  discardVersion(id: string, keep?: string): void {
    for (const key of this.entries.keys())
      if (key.startsWith(`${id}:`) && key !== keep) this.delete(key);
  }
  touch(key: string, proof: DocumentVerificationProof): void {
    if (this.entries.get(key) !== proof) return;
    this.entries.delete(key);
    this.entries.set(key, proof);
  }
  private remember(key: string, proof: DocumentVerificationProof): void {
    this.delete(key);
    if (!this.maxEntries || proof.weight > this.maxBytes) return;
    this.entries.set(key, proof);
    this.bytes += proof.weight;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)
      this.delete(this.entries.keys().next().value!);
  }

  async verify(
    key: string,
    declarations: string,
    work: (signal: AbortSignal) => Promise<DocumentVerificationProof>,
    signal?: AbortSignal,
  ): Promise<DocumentVerificationProof> {
    if (signal?.aborted) throw new Error("document read cancelled");
    let pending = this.pending.get(key);
    if (
      !pending ||
      pending.declarations !== declarations ||
      pending.controller.signal.aborted
    ) {
      const controller = new AbortController();
      pending = {
        declarations,
        controller,
        users: 0,
        promise: Promise.resolve()
          .then(() => work(controller.signal))
          .then((proof) => {
            controller.signal.throwIfAborted();
            if (this.pending.get(key)?.controller === controller)
              this.remember(key, proof);
            return proof;
          })
          .finally(() => {
            if (this.pending.get(key)?.controller === controller)
              this.pending.delete(key);
          }),
      };
      this.pending.set(key, pending);
    }
    pending.users++;
    let cancel: (() => void) | undefined;
    try {
      if (!signal) return await pending.promise;
      return await new Promise<DocumentVerificationProof>((resolve, reject) => {
        cancel = () => reject(new Error("document read cancelled"));
        signal.addEventListener("abort", cancel, { once: true });
        pending.promise.then(resolve, reject);
        if (signal.aborted) cancel();
      });
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
      pending.users--;
      if (!pending.users && signal?.aborted) {
        pending.controller.abort();
        // The final cancelled caller still owns cleanup: reader shutdown must
        // not close SQLite/FileStore while a detached verification is settling.
        await Promise.allSettled([pending.promise]);
      }
    }
  }
}
