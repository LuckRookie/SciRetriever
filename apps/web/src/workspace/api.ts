import {
  parseWorkbenchView,
  parseProcessorBatchRequest,
  type WorkbenchView,
} from "@sciretriever/contracts";
import { record, type JsonRecord } from "../wire.js";
import { configureDataTransport } from "../knowledge.js";
export interface Workspace {
  catalog: string | null;
  artifacts: string | null;
  capabilities: Readonly<Record<string, boolean>>;
}
/** A tab grant is transient and never stored in UI preferences or URLs copied by users. */
export class WorkbenchApi {
  clientId = "";
  csrf = "";
  view: WorkbenchView | null = null;
  workspace: Workspace = { catalog: null, artifacts: null, capabilities: {} };
  private stream: EventSource | null = null;
  private released = false;
  readonly listeners = new Set<(view: WorkbenchView) => void>();
  async connect(): Promise<void> {
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Init": "1" },
      body: "{}",
    });
    const grant = await this.json(response);
    if (typeof grant.client_id !== "string" || typeof grant.csrf !== "string")
      throw new Error("工作台会话无效");
    this.clientId = grant.client_id;
    this.csrf = grant.csrf;
    this.released = false;
    this.accept(grant.view);
    const w = record(
        (await this.read("/api/workspace")).workspace,
        "workspace",
      ),
      caps = record(w.capabilities, "capabilities");
    this.workspace = {
      catalog: typeof w.catalog_path === "string" ? w.catalog_path : null,
      artifacts: typeof w.artifact_root === "string" ? w.artifact_root : null,
      capabilities: Object.fromEntries(
        Object.entries(caps).map(([key, value]) => [key, value === true]),
      ),
    };
    configureDataTransport({ fetch: this.fetch, durableTasks: true });
    this.stream = new EventSource(this.url("/api/events"));
    this.stream.addEventListener("view", (event) => {
      try {
        this.accept(JSON.parse((event as MessageEvent<string>).data));
      } catch {
        void this.refreshView().catch(() => {});
      }
    });
    this.stream.onmessage = (event) => {
      try {
        const value = record(JSON.parse(event.data), "event");
        if (value.view) this.accept(value.view);
        else if (value.session_id) this.accept(value);
      } catch {
        /* A non-view event does not mutate the visible session. */
      }
    };
    window.addEventListener("pagehide", () => this.close(), { once: true });
    window.addEventListener("pageshow", (event) => {
      // A page restored from bfcache must obtain a fresh grant after pagehide.
      if (event.persisted && this.released) location.reload();
    });
  }
  url(path: string): string {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) throw new Error("跨来源请求被拒绝");
    url.searchParams.set("client_id", this.clientId);
    return url.toString();
  }
  readonly fetch = (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("X-Workbench-Csrf", this.csrf);
    return fetch(this.url(path), { ...init, headers });
  };
  async json(response: Response): Promise<JsonRecord> {
    const value = record(await response.json(), "response");
    if (!response.ok)
      throw new Error(
        typeof value.reason === "string"
          ? value.reason
          : typeof value.code === "string"
            ? value.code
            : `请求失败（${response.status}）`,
      );
    return value;
  }
  read(path: string): Promise<JsonRecord> {
    return this.fetch(path).then((response) => this.json(response));
  }
  request(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }).then((response) => this.json(response));
  }
  async query(
    name: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const value = await this.request(
      `/api/v1/query/${name}`,
      { protocol_version: 1, request },
      signal,
    );
    if (value.protocol_version !== 1) throw new Error("查询协议版本不匹配");
    return value;
  }
  async refreshView(): Promise<void> {
    const value = await this.read("/api/view");
    this.accept(value);
  }
  async processors(
    operation: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const value = await this.request(
      "/api/v1/query/processors",
      { protocol_version: 1, operation, request },
      signal,
    );
    if (value.protocol_version !== 1) throw new Error("处理器协议版本不匹配");
    return value;
  }
  async submitProcessor(
    request: unknown,
    start: boolean,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const response = await this.fetch("/api/v1/maintenance/processor-submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({
        protocol_version: 1,
        request: parseProcessorBatchRequest(request),
        start,
      }),
      ...(signal ? { signal } : {}),
    });
    const value = await this.json(response);
    if (value.protocol_version !== 1) throw new Error("处理器协议版本不匹配");
    return value;
  }
  accept(value: unknown): void {
    this.view = parseWorkbenchView(value);
    for (const listener of this.listeners) listener(this.view);
  }
  close(): void {
    this.stream?.close();
    this.stream = null;
    if (this.released || !this.clientId || !this.csrf) return;
    this.released = true;
    void this.fetch("/api/clients/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      keepalive: true,
    }).catch(() => {
      // Unloading can fail offline; the server's bounded TTL remains the fallback.
      console.warn(
        "Workbench disconnect was not delivered; the grant will expire.",
      );
    });
  }
}
