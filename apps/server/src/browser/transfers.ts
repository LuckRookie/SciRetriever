import { randomUUID } from "node:crypto";
import {
  parseCandidateCapture,
  type CandidateCapture,
} from "@sciretriever/contracts";
import type {
  BrowserNativeDownload,
  BrowserNativeProgress,
  BrowserOwnedRequest,
  BrowserPdfResponse,
} from "./cdp-owner.js";
import type { BrowserDownloadResources } from "./resources.js";
import { createLogger, type Logger } from "../logging/index.js";

export interface BrowserTransferInput {
  readonly signal: AbortSignal;
  readonly transfer_id: string;
  readonly capture: CandidateCapture;
  readonly chunks: AsyncIterable<Uint8Array>;
}
export interface BrowserTransferCallbacks {
  readonly resources?: () => BrowserDownloadResources;
  captureContext(
    pageId: string,
    generation: number,
    sourceUrl: string,
    sessionId?: string,
  ): CandidateCapture | null;
  receive(input: BrowserTransferInput): Promise<void>;
  started?(transferId: string, capture: CandidateCapture): void;
  progress?(
    transferId: string,
    capture: CandidateCapture,
    progress: {
      readonly received_bytes: number;
      readonly total_bytes: number | null;
    },
  ): void;
  /** Raw network is terminal; Intake may still be validating the durable bytes. */
  completed?(transferId: string, capture: CandidateCapture): void;
  failed(transferId: string, capture: CandidateCapture, code?: string): void;
  admitDownload?(url: string, pageId: string): Promise<CandidateCapture | null>;
}
interface ActiveTransfer {
  readonly id: string;
  readonly capture: CandidateCapture;
  readonly controller: AbortController;
  readonly cancel: () => Promise<void>;
  readonly done: Promise<void>;
  readonly refresh: (bytes: number, total: number | null) => void;
  readonly stop: (code: string) => void;
}
interface NativeTransfer {
  readonly transfer: ActiveTransfer;
  readonly resources: BrowserDownloadResources | undefined;
  readonly directory: string;
  budget: Promise<void>;
}

function errorCode(error: unknown): string | null {
  const visited = new Set<unknown>();
  let fallback: string | null = null;
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^(?:browser|pdf|storage|file)-[a-z0-9-]{1,100}$/u.test(current.code)
    ) {
      if (
        ![
          "browser-transfer",
          "pdf-acceptance",
          "file-staging",
          "file-publication",
        ].includes(current.code)
      )
        return current.code;
      fallback ??= current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return fallback;
}

/** Session-owned transfers; no global current page, URL match or buffered response. */
export class BrowserTransferDispatcher {
  private readonly requests = new Map<string, CandidateCapture>();
  private readonly prepared = new Map<string, CandidateCapture>();
  private readonly active = new Map<string, ActiveTransfer>();
  private readonly native = new Map<string, NativeTransfer>();
  private readonly pending = new Map<Promise<void>, string>();
  private failures = 0;
  constructor(
    private readonly callbacks: BrowserTransferCallbacks,
    private readonly limits: {
      readonly stall_ms?: number;
      readonly lifetime_ms?: number;
    } = {},
    private readonly logger: Logger = createLogger("browser-transfer"),
  ) {}
  failureCount(): number {
    return this.failures;
  }

  admitted(identity: BrowserOwnedRequest, url: string): void {
    if (!["document", "fetch", "xhr", "other"].includes(identity.resource_type))
      return;
    const capture = this.capture(
      identity.page_id,
      identity.document_generation,
      url,
      identity.session_id,
    );
    if (!capture) return;
    if (
      this.requests.size >= 1024 ||
      [...this.requests.values()].filter(
        (item) => item.session_id === capture.session_id,
      ).length >= 256
    )
      throw new Error("browser transfer admission limit");
    this.requests.set(identity.request_id, capture);
  }
  ended(identity: BrowserOwnedRequest): void {
    this.requests.delete(identity.request_id);
  }
  rejectedResponse(identity: BrowserOwnedRequest, code: string): void {
    const capture = this.requests.get(identity.request_id);
    this.requests.delete(identity.request_id);
    if (!capture) return;
    const id = randomUUID();
    this.callbacks.started?.(id, capture);
    this.failures++;
    this.callbacks.failed(id, capture, code);
  }
  prepareDownload(
    url: string,
    pageId: string,
    generation: number,
    sourceUrl = url,
    sessionId?: string,
  ): void {
    if (this.prepared.size >= 128)
      throw new Error("browser prepared download limit");
    const capture = this.capture(pageId, generation, sourceUrl, sessionId);
    if (capture) this.prepared.set(`${pageId}\n${url}`, capture);
  }
  private capture(
    pageId: string,
    generation: number,
    sourceUrl: string,
    sessionId?: string,
  ): CandidateCapture | null {
    let source: URL;
    try {
      source = new URL(sourceUrl);
    } catch {
      return null;
    }
    if (
      !["http:", "https:"].includes(source.protocol) ||
      source.username ||
      source.password
    )
      return null;
    source.search = "";
    source.hash = "";
    const capture = this.callbacks.captureContext(
      pageId,
      generation,
      source.toString(),
      sessionId,
    );
    if (!capture) return null;
    const parsed = parseCandidateCapture(capture);
    if (
      parsed.page_id !== pageId ||
      parsed.document_generation !== generation ||
      parsed.source_url !== source.toString()
    )
      throw new Error("browser transfer binding failed");
    return parsed;
  }
  async pdfResponse(
    identity: BrowserOwnedRequest,
    _url: string,
    response: BrowserPdfResponse,
  ): Promise<void> {
    const capture = this.requests.get(identity.request_id);
    this.requests.delete(identity.request_id);
    if (!capture || this.active.has(capture.session_id)) {
      await response.cancel();
      return;
    }
    const transfer = this.run(
      capture,
      "response-stream",
      response.cancel,
      async (signal, progress, completed) => {
        let received = 0;
        async function* chunks(): AsyncIterable<Uint8Array> {
          for await (const chunk of response.chunks(signal)) {
            received += chunk.byteLength;
            progress(received, response.content_length);
            yield chunk;
          }
          completed();
        }
        await this.callbacks.receive({
          signal,
          transfer_id: transfer.id,
          capture,
          chunks: chunks(),
        });
      },
    );
    await transfer.done;
  }
  nativeDownload(
    download: BrowserNativeDownload,
    retire: () => Promise<void>,
    directory: string,
  ): void {
    const key = `${download.page.page_id}\n${download.url}`;
    const capture =
      this.prepared.get(key) ??
      this.capture(
        download.page.page_id,
        download.page.document_generation,
        download.url,
        download.page.session_id,
      );
    this.prepared.delete(key);
    if (!capture || this.active.has(capture.session_id)) {
      const rejected = download
        .cancel()
        .then(retire)
        .catch(() => {
          this.failures++;
        });
      this.pending.set(
        rejected,
        capture?.session_id ?? download.page.session_id,
      );
      void rejected.finally(() => {
        this.pending.delete(rejected);
      });
      return;
    }
    const resources = this.callbacks.resources?.();
    const transfer = this.run(
      capture,
      "native-download",
      download.cancel,
      async (signal, _progress, completed) => {
        try {
          await download.completed;
          await binding.budget;
          if (signal.aborted)
            throw new Error("Browser native transfer cancelled");
          completed();
          await this.callbacks.receive({
            signal,
            transfer_id: transfer.id,
            capture,
            chunks: download.chunks(signal),
          });
        } finally {
          try {
            await download.cancel();
          } finally {
            await retire();
            await retirement;
          }
        }
      },
    );
    const binding: NativeTransfer = {
      transfer,
      resources,
      directory,
      budget: Promise.resolve(),
    };
    this.native.set(download.guid, binding);
    this.accountNative(binding, 0);
    const retirement: Promise<void> = download.retired.then(async () => {
      // The terminal CDP event can add bytes while cancellation is settling.
      // Drain that accounting before releasing the real retired original.
      await binding.budget.catch(() => undefined);
      resources?.releaseNative(transfer.id);
      this.native.delete(download.guid);
    });
  }
  nativeProgress(progress: BrowserNativeProgress): void {
    const binding = this.native.get(progress.guid);
    if (binding) {
      binding.transfer.refresh(progress.received_bytes, progress.total_bytes);
      this.accountNative(binding, progress.received_bytes);
    }
  }
  private accountNative(binding: NativeTransfer, bytes: number): void {
    if (!binding.resources) return;
    const account = () =>
      binding.resources!.updateNative(
        binding.transfer.id,
        binding.directory,
        bytes,
      );
    binding.budget = binding.budget.then(account, (failure: unknown) => {
      // A rejected quota/disk check must not poison later real-byte accounting.
      // Keep the first refusal even if a later disk check passes or fails again.
      const retainFailure = (): never => {
        throw failure;
      };
      return account().then(retainFailure, retainFailure);
    });
    // Quota rejection stops the real writer promptly; cleanup retains its lease
    // until the adapter confirms retirement, including a late cancel terminal.
    void binding.budget.catch((error: unknown) => {
      binding.transfer.stop(
        errorCode(error) ?? "browser-download-resource-ownership",
      );
    });
  }
  private run(
    capture: CandidateCapture,
    mode: "response-stream" | "native-download",
    cancel: () => Promise<void>,
    operation: (
      signal: AbortSignal,
      progress: (bytes: number, total: number | null) => void,
      completed: () => void,
    ) => Promise<void>,
  ): ActiveTransfer {
    const id = randomUUID();
    const controller = new AbortController();
    let bytes = 0;
    const startedAt = performance.now();
    let firstByte = false;
    let lastProgressAt = startedAt;
    const timing = (phase: string, total: number | null = null) => {
      this.logger.info("Browser transfer timing", {
        article_id: capture.article_id,
        session_id: capture.session_id,
        transfer_id: id,
        transfer_mode: mode,
        phase,
        elapsed_ms: Math.round(performance.now() - startedAt),
        bytes,
        total_bytes: total,
      });
    };
    let networkEnded = false;
    let failureCode = "browser-transfer-failed";
    let stall: ReturnType<typeof setTimeout>;
    let cancellation: Promise<void> | undefined;
    const cancelOnce = () => (cancellation ??= cancel());
    const stop = (code: string) => {
      if (controller.signal.aborted) return;
      failureCode = code;
      controller.abort();
      void cancelOnce().catch(() => undefined);
    };
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(
        () => stop("browser-transfer-stalled"),
        this.limits.stall_ms ?? 120000,
      );
    };
    const refresh = (received: number, total: number | null) => {
      if (received > bytes) {
        bytes = received;
        if (!networkEnded) armStall();
        if (!firstByte) {
          firstByte = true;
          lastProgressAt = performance.now();
          timing("first-byte", total);
        } else if (performance.now() - lastProgressAt >= 10_000) {
          lastProgressAt = performance.now();
          timing("progress", total);
        }
      }
      this.callbacks.progress?.(id, capture, {
        received_bytes: bytes,
        total_bytes: total,
      });
    };
    const completed = () => {
      if (networkEnded) return;
      networkEnded = true;
      clearTimeout(stall);
      clearTimeout(lifetime);
      timing("network-completed");
      this.callbacks.completed?.(id, capture);
    };
    armStall();
    const lifetime = setTimeout(
      () => stop("browser-transfer-deadline"),
      this.limits.lifetime_ms ?? 1200000,
    );
    this.callbacks.started?.(id, capture);
    timing("started");
    const done = Promise.resolve()
      .then(() => operation(controller.signal, refresh, completed))
      .then(() => timing("completed"))
      .catch((error: unknown) => {
        timing(controller.signal.aborted ? "cancelled" : "failed");
        this.failures++;
        this.callbacks.failed(
          id,
          capture,
          failureCode === "browser-transfer-failed"
            ? (errorCode(error) ?? failureCode)
            : failureCode,
        );
      })
      .finally(() => {
        timing("settled");
        clearTimeout(stall);
        clearTimeout(lifetime);
        this.active.delete(capture.session_id);
        this.pending.delete(done);
      });
    const transfer: ActiveTransfer = {
      id,
      capture,
      controller,
      cancel: cancelOnce,
      done,
      refresh,
      stop,
    };
    this.active.set(capture.session_id, transfer);
    this.pending.set(done, capture.session_id);
    return transfer;
  }
  async cancelSession(sessionId: string): Promise<void> {
    const transfer = this.active.get(sessionId);
    if (transfer) {
      transfer.controller.abort();
      await transfer.cancel();
    }
    await this.settle(sessionId);
    for (const [key, capture] of this.requests)
      if (capture.session_id === sessionId) this.requests.delete(key);
    for (const [key, capture] of this.prepared)
      if (capture.session_id === sessionId) this.prepared.delete(key);
  }
  async settle(sessionId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.pending]
        .filter(([, owner]) => sessionId === undefined || owner === sessionId)
        .map(([promise]) => promise);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }
  dispose(): void {
    this.requests.clear();
    this.prepared.clear();
  }
}
