import {
  parseProcessorBatchRequest,
  parseWorkbenchView,
  type WorkbenchView,
} from "@sciretriever/contracts";
import { record, type JsonRecord } from "./wire.js";

export type EntryKind = "workspace" | "query" | "maintenance";
export interface Workspace {
  catalog: string | null;
  artifacts: string | null;
  capabilities: Readonly<Record<string, boolean>>;
  readiness: string;
  schemaVersion?: number | null;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly kind: "retryable" | "login" | "business",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** One transient grant per mounted workspace. Independent readers use their own protocol. */
export class ApiClient {
  clientId = "";
  csrf = "";
  actor = "";
  view: WorkbenchView | null = null;
  workspace: Workspace = {
    catalog: null,
    artifacts: null,
    capabilities: {},
    readiness: "unavailable",
  };
  private stream: EventSource | null = null;
  readonly materialListeners = new Set<() => void>();
  readonly agentListeners = new Set<() => void>();
  private materialRevision: string | null = null;
  private released = false;
  private loginRedirected = false;
  readonly listeners = new Set<(view: WorkbenchView) => void>();
  readonly connectionListeners = new Set<(connected: boolean) => void>();
  constructor(readonly kind: EntryKind = "workspace") {}

  async connect(signal: AbortSignal): Promise<Workspace> {
    if (this.kind !== "workspace") {
      const status = await this.read("/api/v1/query/status", signal);
      const readinessRecord = record(status.readiness, "query readiness"),
        readiness = readinessRecord.status;
      if (
        status.protocol_version !== 1 ||
        !["ready", "not-initialized", "unavailable"].includes(String(readiness))
      )
        throw new ApiError(
          "文献库状态回执无效。",
          "invalid-readiness",
          "business",
        );
      if (this.kind === "maintenance") {
        const session = await this.read("/api/v1/maintenance/session", signal);
        if (typeof session.csrf !== "string") throw new Error("维护会话无效");
        this.csrf = session.csrf;
        this.actor = String(session.actor ?? "");
      }
      this.workspace = {
        catalog: null,
        artifacts: null,
        capabilities: {
          query: readiness === "ready",
          maintenance: this.kind === "maintenance",
        },
        readiness: String(readiness),
        schemaVersion:
          typeof readinessRecord.schema_version === "number"
            ? readinessRecord.schema_version
            : null,
      };
      return this.workspace;
    }
    const auth = await fetch("/auth/status", { signal });
    if (auth.ok) {
      const identity = record(await auth.json(), "authentication");
      if (identity.authenticated !== true) this.login();
      this.actor = typeof identity.actor === "string" ? identity.actor : "";
    }
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Init": "1" },
      body: "{}",
      signal,
    });
    const grant = await this.json(response);
    if (typeof grant.client_id !== "string" || typeof grant.csrf !== "string")
      throw new Error("工作台会话无效");
    this.clientId = grant.client_id;
    this.csrf = grant.csrf;
    this.released = false;
    try {
      signal.throwIfAborted();
      this.accept(grant.view);
      const workspace = record(
        (await this.read("/api/workspace", signal)).workspace,
        "workspace",
      );
      const capabilities = record(workspace.capabilities, "capabilities");
      this.workspace = {
        catalog:
          typeof workspace.catalog_path === "string"
            ? workspace.catalog_path
            : null,
        artifacts:
          typeof workspace.artifact_root === "string"
            ? workspace.artifact_root
            : null,
        capabilities: Object.fromEntries(
          Object.entries(capabilities).map(([key, value]) => [
            key,
            value === true,
          ]),
        ),
        readiness: "ready",
      };
      signal.throwIfAborted();
      this.stream = new EventSource(this.url("/api/events"));
      this.stream.addEventListener("agents", () => {
        for (const listener of this.agentListeners) listener();
      });
      this.stream.addEventListener("view", (event) => {
        if (this.released) return;
        try {
          this.accept(JSON.parse((event as MessageEvent<string>).data));
        } catch {
          // A malformed push never replaces the last validated view.
          void this.refreshView().catch(() => this.connection(false));
        }
      });
      this.stream.addEventListener("materials", (event) => {
        if (this.released) return;
        try {
          const value: unknown = JSON.parse(
            (event as MessageEvent<string>).data,
          );
          if (
            !value ||
            typeof value !== "object" ||
            !("revision" in value) ||
            typeof value.revision !== "string"
          )
            return;
          const changed =
            this.materialRevision !== null &&
            this.materialRevision !== value.revision;
          this.materialRevision = value.revision;
          if (changed)
            for (const listener of this.materialListeners) listener();
        } catch {
          void this.refreshView().catch(() => this.connection(false));
        }
      });
      this.stream.onopen = () => this.connection(true);
      this.stream.onerror = () => this.connection(false);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
      return this.workspace;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private readonly onPageHide = () => this.close();
  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && this.released) location.reload();
  };
  private connection(connected: boolean) {
    for (const listener of this.connectionListeners) listener(connected);
  }
  url(path: string): string {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) throw new Error("跨来源请求被拒绝");
    if (this.kind === "workspace" && this.clientId)
      url.searchParams.set("client_id", this.clientId);
    return url.toString();
  }
  readonly fetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (this.released && !init.keepalive)
      throw new ApiError("工作台连接已关闭。", "client-closed", "business");
    if (
      this.kind === "query" &&
      new URL(path, location.origin).pathname.startsWith("/api/v1/maintenance/")
    )
      throw new ApiError("此入口只提供查询与阅读。", "read-only", "business");
    const headers = new Headers(init.headers);
    if (this.csrf)
      headers.set(
        this.kind === "workspace" ? "X-Workbench-Csrf" : "X-Sciretriever-Csrf",
        this.csrf,
      );
    const response = await fetch(this.url(path), { ...init, headers });
    if (response.status === 401 && this.kind === "workspace") {
      const failure: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        failure &&
        typeof failure === "object" &&
        "code" in failure &&
        [
          "login-required",
          "client-required",
          "authentication-required",
        ].includes(String(failure.code))
      )
        this.login();
    }
    return response;
  };
  private login(): never {
    if (!this.loginRedirected) {
      this.loginRedirected = true;
      this.stream?.close();
      location.replace(
        `/auth?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
      );
    }
    throw new ApiError("登录已过期，请重新登录。", "login-required", "login");
  }
  async logout(): Promise<void> {
    const response = await fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Init": "1" },
      body: "{}",
    });
    if (!response.ok) throw new Error("退出失败，请检查网络后重试。");
    this.close();
    location.replace("/auth");
  }
  async json(response: Response): Promise<JsonRecord> {
    const value = record(await response.json(), "response");
    if (!response.ok) {
      const code =
        typeof value.code === "string" ? value.code : `http-${response.status}`;
      throw new ApiError(
        typeof value.reason === "string" &&
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(value.reason)
          ? value.reason
          : code,
        code,
        response.status >= 500 || response.status === 429
          ? "retryable"
          : "business",
      );
    }
    return value;
  }
  read(path: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.fetch(path, signal ? { signal } : {}).then((response) =>
      this.json(response),
    );
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
  /** A versioned owner route: `{protocol_version, request}` in, its `result` out. */
  async call(
    path: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const value = await this.json(
      await this.fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: JSON.stringify({ protocol_version: 1, request }),
        ...(signal ? { signal } : {}),
      }),
    );
    if (value.protocol_version !== 1) throw new Error("协议版本不匹配");
    return record(value.result, "result");
  }
  /** Raw bytes to a versioned owner route, streamed by the browser. */
  async send(
    path: string,
    body: Blob,
    signal?: AbortSignal,
    /** Route headers, such as the file's name for a file item. */
    extra: Record<string, string> = {},
  ): Promise<JsonRecord> {
    const value = await this.json(
      await this.fetch(path, {
        method: "POST",
        headers: {
          ...extra,
          "Content-Type": "application/octet-stream",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body,
        ...(signal ? { signal } : {}),
      }),
    );
    if (value.protocol_version !== 1) throw new Error("协议版本不匹配");
    return record(value.result, "result");
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
  async refreshView(signal?: AbortSignal): Promise<WorkbenchView> {
    const before = this.view;
    const value = parseWorkbenchView(await this.read("/api/view", signal));
    // A push or command accepted while this read was in flight is newer local
    // evidence. Do not replace it, including in the calling Query cache.
    if (!this.released && this.view === before) this.accept(value);
    return this.view ?? value;
  }
  accept(value: unknown) {
    this.view = parseWorkbenchView(value);
    for (const listener of this.listeners) listener(this.view);
  }
  close(): void {
    this.stream?.close();
    this.stream = null;
    window.removeEventListener("pagehide", this.onPageHide);
    // Keep pageshow until unload: bfcache restoration must reconnect with a new grant.
    if (this.released) return;
    this.released = true;
    if (this.kind !== "workspace" || !this.clientId || !this.csrf) return;
    void this.fetch("/api/clients/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok)
          console.warn(
            "Workbench disconnect was rejected; grant expiry remains the fallback.",
          );
      })
      .catch(() =>
        console.warn(
          "Workbench disconnect was not delivered; grant expiry remains the fallback.",
        ),
      );
  }
}
