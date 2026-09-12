import {
  parseDurableCandidate,
  parseCandidateCapture,
  type CandidateCapture,
  sha256,
  type DurableCandidate,
} from "@sciretriever/contracts";
export type { DurableCandidate } from "@sciretriever/contracts";

export interface CandidateRepository {
  putCandidate(candidate: DurableCandidate): Promise<void>;
  getCandidate(transferId: string): Promise<DurableCandidate | null>;
}
import { FileStore } from "../storage/files/store.js";
import type { StagingFile } from "../storage/files/staging.js";
import type { PublishedFile } from "../storage/files/publication.js";

export type TransferState =
  | "capturing"
  | "durable-ready"
  | "failed"
  | "discarded";
export interface TransferStatus {
  readonly transfer_id: string;
  readonly state: TransferState;
  readonly received_bytes: number;
}

export class BrowserTransferError extends Error {
  readonly code = "browser-transfer" as const;
  constructor() {
    super("browser transfer operation failed");
    this.name = "BrowserTransferError";
  }
}
function invalid(): never {
  throw new BrowserTransferError();
}

interface Transfer {
  readonly capture: CandidateCapture | null;
  readonly id: string;
  readonly stage: StagingFile;
  readonly maxBytes: number;
  readonly sourceName: string;
  readonly sourceRecordId: string | null;
  received: number;
  state: TransferState;
  candidate?: DurableCandidate;
}

export class BrowserTransferCollector {
  private readonly files: FileStore;
  private readonly transfers = new Map<string, Transfer>();
  constructor(
    files: FileStore,
    private readonly repository?: CandidateRepository,
  ) {
    this.files = files;
  }

  async begin(
    transferId: string,
    maxBytes = 64 * 1024 * 1024,
    capture: CandidateCapture | null = null,
    sourceName = "browser",
    sourceRecordId: string | null = null,
  ): Promise<TransferStatus> {
    if (
      !/^[a-zA-Z0-9._:-]{1,128}$/u.test(transferId) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 512 * 1024 * 1024 ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(sourceName) ||
      (sourceRecordId !== null &&
        (!sourceRecordId ||
          sourceRecordId.length > 1024 ||
          /[\p{Cc}\p{Cf}]/u.test(sourceRecordId)))
    )
      invalid();
    if (await this.repository?.getCandidate(transferId)) invalid();
    const existing = this.transfers.get(transferId);
    if (existing) return this.status(existing);
    const stage = await this.files.stage({ maxBytes });
    const transfer: Transfer = {
      capture: capture === null ? null : parseCandidateCapture(capture),
      id: transferId,
      stage,
      maxBytes,
      sourceName,
      sourceRecordId,
      received: 0,
      state: "capturing",
    };
    this.transfers.set(transferId, transfer);
    return this.status(transfer);
  }

  async append(transferId: string, bytes: Uint8Array): Promise<TransferStatus> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) invalid();
    const transfer = this.transfers.get(transferId);
    if (
      !transfer ||
      transfer.state !== "capturing" ||
      transfer.received + bytes.byteLength > transfer.maxBytes
    )
      invalid();
    try {
      await transfer.stage.write(bytes);
      transfer.received += bytes.byteLength;
      return this.status(transfer);
    } catch {
      transfer.state = "failed";
      await transfer.stage.discard();
      throw new BrowserTransferError();
    }
  }

  async bytes(transferId: string): Promise<Uint8Array> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.state !== "capturing") invalid();
    return transfer.stage.read();
  }

  async candidateBytes(candidate: DurableCandidate): Promise<Uint8Array> {
    const parsed = parseDurableCandidate(candidate);
    const bytes = await this.files.read(parsed.reference, parsed.size_bytes);
    if (
      bytes.byteLength !== parsed.size_bytes ||
      (await sha256(bytes)) !== parsed.sha256
    )
      invalid();
    return bytes;
  }

  withPublication<T>(operation: () => Promise<T>): Promise<T> {
    return this.files.withWrite(operation);
  }
  complete(transferId: string): Promise<DurableCandidate> {
    return this.files.withWrite(() => this.completeAdmitted(transferId));
  }
  private async completeAdmitted(
    transferId: string,
  ): Promise<DurableCandidate> {
    const transfer = this.transfers.get(transferId);
    if (
      !transfer ||
      (transfer.state !== "capturing" && transfer.state !== "durable-ready")
    )
      invalid();
    if (transfer.candidate) {
      if (this.repository) {
        const saved = await this.repository.getCandidate(transferId);
        if (
          !saved ||
          JSON.stringify(saved) !== JSON.stringify(transfer.candidate)
        )
          invalid();
      }
      return transfer.candidate;
    }
    if (transfer.received === 0) {
      transfer.state = "failed";
      await transfer.stage.discard();
      invalid();
    }
    try {
      const description = await transfer.stage.describe();
      const durable = await this.files.publish(
        transfer.stage,
        `.candidates/${description.sha256}.bin`,
      );
      const candidate = parseDurableCandidate({
        capture: transfer.capture,
        source_name: transfer.sourceName,
        source_record_id: transfer.sourceRecordId,
        transfer_id: transfer.id,
        state: "durable-ready",
        reference: durable.reference,
        size_bytes: description.size,
        sha256: description.sha256,
      });
      await this.repository?.putCandidate(candidate);
      transfer.candidate = candidate;
      transfer.state = "durable-ready";
      return candidate;
    } catch (error) {
      transfer.state = "failed";
      await transfer.stage.discard();
      if (error instanceof Error) throw new BrowserTransferError();
      throw new BrowserTransferError();
    }
  }

  async discard(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.state === "discarded") return;
    if (transfer.state === "durable-ready") invalid();
    await transfer.stage.discard();
    transfer.state = "discarded";
  }

  async publish(
    candidate: DurableCandidate,
    target: string,
  ): Promise<PublishedFile> {
    const parsed = parseDurableCandidate(candidate);
    const saved = await this.repository?.getCandidate(parsed.transfer_id);
    if (
      this.repository &&
      (!saved || JSON.stringify(saved) !== JSON.stringify(parsed))
    )
      invalid();
    const bytes = await this.files.read(parsed.reference, parsed.size_bytes);
    if (
      bytes.byteLength !== parsed.size_bytes ||
      (await sha256(bytes)) !== parsed.sha256
    )
      invalid();
    const stage = await this.files.stage({ maxBytes: parsed.size_bytes });
    try {
      await stage.write(bytes);
      return await this.files.publish(stage, target);
    } catch (error) {
      await stage.discard();
      throw error;
    }
  }

  async verifyPublished(
    candidate: DurableCandidate,
    reference: string,
  ): Promise<void> {
    const parsed = parseDurableCandidate(candidate);
    const bytes = await this.files.read(reference, parsed.size_bytes);
    if (
      bytes.byteLength !== parsed.size_bytes ||
      (await sha256(bytes)) !== parsed.sha256
    )
      invalid();
  }

  async recover(transferId: string): Promise<DurableCandidate | null> {
    const candidate = (await this.repository?.getCandidate(transferId)) ?? null;
    if (!candidate) return null;
    const bytes = await this.files.read(
      candidate.reference,
      candidate.size_bytes,
    );
    if (
      bytes.byteLength !== candidate.size_bytes ||
      (await sha256(bytes)) !== candidate.sha256
    )
      invalid();
    return candidate;
  }

  /** Called only after the matching durable records have been atomically retired. */
  forgetRetired(transferIds: readonly string[]): void {
    for (const id of transferIds) {
      const transfer = this.transfers.get(id);
      if (transfer?.state === "durable-ready") this.transfers.delete(id);
    }
  }
  status(transfer: Transfer): TransferStatus {
    return Object.freeze({
      transfer_id: transfer.id,
      state: transfer.state,
      received_bytes: transfer.received,
    });
  }
  get(transferId: string): TransferStatus | undefined {
    const transfer = this.transfers.get(transferId);
    return transfer ? this.status(transfer) : undefined;
  }
}
