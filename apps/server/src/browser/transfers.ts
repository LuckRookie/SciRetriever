import { randomUUID } from "node:crypto";
import type { Page, Request, Response } from "playwright";
import {
  parseCandidateCapture,
  type CandidateCapture,
} from "@sciretriever/contracts";

export interface BrowserTransferInput {
  readonly signal: AbortSignal;
  readonly transfer_id: string;
  readonly capture: CandidateCapture;
  readonly chunks: AsyncIterable<Uint8Array>;
}
export interface BrowserTransferCallbacks {
  captureContext(
    pageId: string,
    generation: number,
    sourceUrl: string,
  ): CandidateCapture | null;
  receive(input: BrowserTransferInput): Promise<void>;
  started?(transferId: string, capture: CandidateCapture): void;
  failed(transferId: string, capture: CandidateCapture): void;
  /** Authorize a popup's first download when its request predates frame creation. */
  admitDownload?(url: string, pageId: string): Promise<CandidateCapture | null>;
}
interface Binding {
  preflight: boolean;
  readonly transferId: string;
  readonly capture: CandidateCapture;
  readonly key: string;
}

/** Admission binds bytes to the article before any asynchronous response/download event. */
export class BrowserTransferDispatcher {
  private readonly requests = new WeakMap<Request, Binding>();
  private readonly downloads = new Map<string, Binding[]>();
  private readonly pending = new Set<Promise<void>>();
  private readonly expirations = new Map<
    Binding,
    ReturnType<typeof setTimeout>
  >();
  private failures = 0;
  failureCount(): number {
    return this.failures;
  }
  constructor(private readonly callbacks: BrowserTransferCallbacks) {}
  admitted(request: Request, pageId: string, generation: number): void {
    if (!["document", "fetch", "xhr", "other"].includes(request.resourceType()))
      return;
    const key = `${pageId}\n${request.url()}`;
    const prepared = this.downloads
      .get(key)
      ?.find((binding) => binding.preflight);
    if (prepared) {
      prepared.preflight = false;
      this.requests.set(request, prepared);
      return;
    }
    const binding = this.bind(request.url(), pageId, generation, false);
    if (binding) this.requests.set(request, binding);
  }
  prepareDownload(
    url: string,
    pageId: string,
    generation: number,
    sourceUrl = url,
  ): void {
    this.bind(url, pageId, generation, true, sourceUrl);
  }
  private bind(
    requestedUrl: string,
    pageId: string,
    generation: number,
    preflight: boolean,
    sourceUrl = requestedUrl,
  ): Binding | null {
    if (this.expirations.size >= 256)
      throw new Error("browser transfer admission limit");
    const requested = new URL(requestedUrl);
    const source = new URL(sourceUrl);
    requested.search = "";
    requested.hash = "";
    source.search = "";
    source.hash = "";
    if (
      !["http:", "https:"].includes(source.protocol) ||
      source.username ||
      source.password
    )
      throw new Error("browser transfer source unavailable");
    const capture = this.callbacks.captureContext(
      pageId,
      generation,
      source.toString(),
    );
    if (!capture) return null;
    const parsed = parseCandidateCapture(capture);
    if (
      parsed.page_id !== pageId ||
      parsed.document_generation !== generation ||
      parsed.source_url !== source.toString()
    )
      throw new Error("browser transfer binding failed");
    const binding = {
      transferId: randomUUID(),
      capture: parsed,
      key: `${pageId}\n${requestedUrl}`,
      preflight,
    };
    const expiry = setTimeout(() => this.remove(binding), 30000);
    expiry.unref();
    this.expirations.set(binding, expiry);
    const queue = this.downloads.get(binding.key) ?? [];
    queue.push(binding);
    this.downloads.set(binding.key, queue);
    return binding;
  }

  track(page: Page, pageId: string): void {
    page.on("response", (response) => this.response(response));
    page.on("download", (download) => {
      const key = `${pageId}\n${download.url()}`;
      const binding = this.downloads.get(key)?.[0];
      if (!binding) {
        void this.recoverDownload(download, pageId);
        return;
      }
      this.remove(binding);
      this.runDownload(binding, download);
    });
    page.on("requestfailed", (request) => {
      const binding = this.requests.get(request);
      if (binding && request.failure()?.errorText !== "net::ERR_ABORTED")
        this.remove(binding);
    });
  }
  private async recoverDownload(
    download: import("playwright").Download,
    pageId: string,
  ): Promise<void> {
    try {
      const capture = await this.callbacks.admitDownload?.(
        download.url(),
        pageId,
      );
      if (!capture) throw new Error("download admission unavailable");
      const binding: Binding = {
        preflight: false,
        transferId: randomUUID(),
        capture: parseCandidateCapture(capture),
        key: `${pageId}\n${download.url()}`,
      };
      this.runDownload(binding, download);
    } catch {
      this.failures++;
      await download.cancel().catch(() => undefined);
    }
  }
  private runDownload(
    binding: Binding,
    download: import("playwright").Download,
  ): void {
    this.run(binding, async (signal) => {
      const stream = await download.createReadStream();
      if (!stream) throw new Error("download stream unavailable");
      if (signal.aborted) {
        stream.destroy();
        throw new Error("transfer cancelled");
      }
      const cancel = () => stream.destroy();
      signal.addEventListener("abort", cancel, { once: true });
      async function* chunks(): AsyncIterable<Uint8Array> {
        for await (const chunk of stream!) {
          if (!(chunk instanceof Uint8Array))
            throw new Error("invalid download bytes");
          yield chunk;
        }
      }
      try {
        await this.callbacks.receive({
          signal,
          transfer_id: binding.transferId,
          capture: binding.capture,
          chunks: chunks(),
        });
      } finally {
        signal.removeEventListener("abort", cancel);
        stream.destroy();
      }
    });
  }
  private response(response: Response): void {
    const binding = this.requests.get(response.request());
    if (!binding) return;
    const headers = response.headers();
    const type = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      headers["content-disposition"]?.toLowerCase().includes("attachment") ||
      type === "application/octet-stream"
    )
      return;
    this.remove(binding);
    if (type !== "application/pdf" || response.status() !== 200) {
      // A partial/ranged response is never a complete candidate. Surface a
      // stable failure instead of allowing its bytes to enter the spool.
      if (type === "application/pdf" && response.status() === 206) {
        this.failures++;
        this.callbacks.failed(binding.transferId, binding.capture);
      }
      return;
    }
    this.run(binding, async (signal) => {
      const bytes = await response.body();
      if (signal.aborted) throw new Error("transfer cancelled");
      async function* chunks(): AsyncIterable<Uint8Array> {
        yield bytes;
      }
      await this.callbacks.receive({
        signal,
        transfer_id: binding.transferId,
        capture: binding.capture,
        chunks: chunks(),
      });
    });
  }
  private remove(binding: Binding): void {
    clearTimeout(this.expirations.get(binding));
    this.expirations.delete(binding);
    const queue =
      this.downloads.get(binding.key)?.filter((item) => item !== binding) ?? [];
    if (queue.length) this.downloads.set(binding.key, queue);
    else this.downloads.delete(binding.key);
  }
  private run(
    binding: Binding,
    operation: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    this.callbacks.started?.(binding.transferId, binding.capture);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("transfer deadline"));
      }, 30000);
    });
    const pending = Promise.race([operation(controller.signal), deadline])
      .catch(() => {
        this.failures++;
        this.callbacks.failed(binding.transferId, binding.capture);
      })
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(pending);
      });
    this.pending.add(pending);
  }
  dispose(): void {
    for (const timer of this.expirations.values()) clearTimeout(timer);
    this.expirations.clear();
    this.downloads.clear();
  }
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
