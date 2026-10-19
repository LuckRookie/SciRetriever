import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  ContractValidationError,
  parseStrictJsonValue,
  parseWorkbenchView,
  parseWorkbenchActionCommand,
} from "@sciretriever/contracts";
import { operationRecord } from "../entry/query-operations.js";

export const WORKBENCH_READ_OPERATIONS = [
  "view",
  "select",
  "tabs",
  "frame",
  "task-list",
  "task-read",
] as const;
export const WORKBENCH_WRITE_OPERATIONS = [
  "control",
  "action",
  "guidance",
  "cancel-guidance",
  "activate-tab",
  "accept-candidate",
  "abandon-candidate",
  "task-create",
  "task-control",
] as const;
export type WorkbenchOperation =
  | (typeof WORKBENCH_READ_OPERATIONS)[number]
  | (typeof WORKBENCH_WRITE_OPERATIONS)[number];
export class MachineWorkbenchError extends Error {
  constructor(readonly code: string) {
    super("workbench operation could not complete");
  }
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value))
    throw new ContractValidationError();
}
/** Explicit IPv4 runtime only; no credentials in URLs, redirects or arbitrary paths. */
export function workbenchOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractValidationError();
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && isIP(url.hostname) !== 4) ||
    url.hostname === "0.0.0.0" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ContractValidationError();
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}
/** Private HTTP adapter to the process that owns the Browser. Grants never leave this object. */
export class MachineWorkbenchClient {
  private readonly origin: string;
  private cookie = "";
  private clientId = "";
  private csrf = "";
  private ready: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: Promise<unknown> | undefined;
  private lost = false;
  private authenticated = false;
  constructor(
    origin: string,
    private readonly maintenance = false,
  ) {
    this.origin = workbenchOrigin(origin);
  }

  private async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    init = false,
    closing = false,
  ): Promise<Response> {
    const url = new URL(path, this.origin);
    if (this.clientId && !init)
      url.searchParams.set("client_id", this.clientId);
    const signals = [
      AbortSignal.timeout(
        closing ? 5000 : path === "/api/action" ? 150000 : 30000,
      ),
      ...(closing ? [] : [this.stop.signal]),
      ...(signal ? [signal] : []),
    ];
    try {
      return await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Origin: this.origin,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(this.csrf ? { "X-Workbench-Csrf": this.csrf } : {}),
          ...(init ? { "X-Workbench-Init": "1" } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
    } catch {
      if (signal?.aborted || (this.stop.signal.aborted && !closing))
        throw new MachineWorkbenchError("operation-cancelled");
      throw new MachineWorkbenchError("workbench-unreachable");
    }
  }
  private async bytes(
    response: Response,
    limit = 4 * 1024 * 1024,
  ): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new MachineWorkbenchError("workbench-protocol");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new MachineWorkbenchError("response-budget");
        chunks.push(part.value);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      await reader.cancel();
      if (error instanceof MachineWorkbenchError) throw error;
      throw new MachineWorkbenchError("workbench-unreachable");
    } finally {
      reader.releaseLock();
    }
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    const value = parseStrictJsonValue(await this.bytes(response));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new MachineWorkbenchError("workbench-protocol");
    const r = value as Record<string, unknown>;
    if (!response.ok)
      throw new MachineWorkbenchError(
        typeof r.code === "string" && /^[a-z][a-z0-9-]{1,95}$/u.test(r.code)
          ? r.code
          : "workbench-rejected",
      );
    return r;
  }
  private async connect(signal?: AbortSignal) {
    const password = process.env.SCIRETRIEVER_WEB_PASSWORD;
    if (!password) throw new MachineWorkbenchError("web-password-required");
    const status = await this.json(
      await this.request("/auth/status", undefined, signal),
    );
    if (status.required !== true)
      throw new MachineWorkbenchError("workbench-auth-unavailable");
    const login = await this.request("/auth/login", { password }, signal, true);
    await this.json(login);
    const authCookie = login.headers
      .getSetCookie()
      .find((s) => /^sr_auth_[0-9a-f]+=/.test(s))
      ?.split(";")[0];
    if (!authCookie || !/^sr_auth_[0-9a-f]+=[0-9a-f]{64}$/u.test(authCookie))
      throw new MachineWorkbenchError("workbench-protocol");
    this.cookie = authCookie;
    this.authenticated = true;
    const page = await this.request("/", undefined, signal);
    if (!page.ok) {
      await this.bytes(page);
      throw new MachineWorkbenchError("workbench-unavailable");
    }
    const cookie = page.headers
      .getSetCookie()
      .find((s) => /^sr_workbench_[0-9a-f]+=/.test(s))
      ?.split(";")[0];
    await this.bytes(page, 1024 * 1024);
    if (!cookie || !/^sr_workbench_[0-9a-f]+=[0-9a-f]{64}$/u.test(cookie))
      throw new MachineWorkbenchError("workbench-protocol");
    this.cookie = [this.cookie, cookie].filter(Boolean).join("; ");
    const grant = await this.json(
      await this.request("/api/clients", {}, signal, true),
    );
    identifier(grant.client_id);
    if (typeof grant.csrf !== "string" || !/^[0-9a-f]{64}$/u.test(grant.csrf))
      throw new MachineWorkbenchError("workbench-protocol");
    this.clientId = grant.client_id;
    this.csrf = grant.csrf;
    parseWorkbenchView(grant.view);
    // Keep an attached viewer alive. This never takes, resumes or renews control authority.
    this.timer = setInterval(() => {
      if (this.heartbeat || this.lost || this.stop.signal.aborted) return;
      this.heartbeat = this.request("/api/view")
        .then((r) => this.json(r))
        .catch(() => {
          this.lost = true;
        })
        .finally(() => {
          this.heartbeat = undefined;
        });
    }, 30000).unref();
  }
  execute(
    operation: WorkbenchOperation,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const pending = this.tail.then(async () => {
      if (this.stop.signal.aborted || this.lost)
        throw new MachineWorkbenchError("workbench-disconnected");
      const read = (WORKBENCH_READ_OPERATIONS as readonly string[]).includes(
        operation,
      );
      if (
        !read &&
        (!(WORKBENCH_WRITE_OPERATIONS as readonly string[]).includes(
          operation,
        ) ||
          !this.maintenance)
      )
        throw new MachineWorkbenchError("capability-unavailable");
      this.ready ??= this.connect(signal);
      await this.ready;
      if (operation === "view" || operation === "tabs") {
        operationRecord(value, []);
        const result = await this.json(
          await this.request(
            operation === "view" ? "/api/view" : "/api/tabs",
            undefined,
            signal,
          ),
        );
        return operation === "view" ? this.view(result) : result;
      }
      if (operation === "frame") {
        const r = operationRecord(value, ["session_id", "frame_seq"]);
        identifier(r.session_id);
        if (!Number.isSafeInteger(r.frame_seq) || (r.frame_seq as number) < 0)
          throw new ContractValidationError();
        const response = await this.request(
          `/api/frame?session_id=${encodeURIComponent(r.session_id)}&frame_seq=${r.frame_seq}`,
          undefined,
          signal,
        );
        if (!response.ok) return this.json(response);
        if (response.headers.get("content-type") !== "image/jpeg")
          throw new MachineWorkbenchError("workbench-protocol");
        const bytes = await this.bytes(response);
        return {
          ...r,
          media_type: "image/jpeg",
          byte_size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes_base64: bytes.toString("base64"),
        };
      }
      let path: string;
      switch (operation) {
        case "task-list": {
          const r = operationRecord(
            value,
            [],
            ["limit", "cursor", "status_group"],
          );
          const params = new URLSearchParams();
          if (r.limit !== undefined) {
            if (
              !Number.isSafeInteger(r.limit) ||
              (r.limit as number) < 1 ||
              (r.limit as number) > 1000
            )
              throw new ContractValidationError();
            params.set("limit", String(r.limit));
          }
          if (r.cursor !== undefined) {
            if (typeof r.cursor !== "string")
              throw new ContractValidationError();
            params.set("cursor", r.cursor);
          }
          if (r.status_group !== undefined) {
            if (
              typeof r.status_group !== "string" ||
              !["active", "attention", "ended"].includes(r.status_group)
            )
              throw new ContractValidationError();
            params.set("status_group", String(r.status_group));
          }
          return this.json(
            await this.request(`/api/tasks?${params}`, undefined, signal),
          );
        }
        case "task-read": {
          const r = operationRecord(value, ["job_id"]);
          identifier(r.job_id);
          return this.json(
            await this.request(
              `/api/tasks/${encodeURIComponent(r.job_id)}`,
              undefined,
              signal,
            ),
          );
        }
        case "task-create":
          path = "/api/tasks";
          break;
        case "task-control": {
          const r = operationRecord(value, ["job_id", "action"]);
          identifier(r.job_id);
          if (
            typeof r.action !== "string" ||
            !["run", "pause", "cancel", "resume", "retry"].includes(
              String(r.action),
            )
          )
            throw new ContractValidationError();
          return this.json(
            await this.request(
              `/api/tasks/${encodeURIComponent(r.job_id)}/${r.action === "run" ? "start" : r.action}`,
              {},
              signal,
            ),
          );
        }
        case "select": {
          const r = operationRecord(value, ["session_id"]);
          identifier(r.session_id);
          path = "/api/sessions/select";
          break;
        }
        case "control": {
          const r = operationRecord(value, [
            "kind",
            "session_id",
            "article_id",
            "control_epoch",
          ]);
          identifier(r.session_id);
          identifier(r.article_id);
          if (
            typeof r.kind !== "string" ||
            !["takeover", "release", "pause", "resume", "cancel"].includes(
              String(r.kind),
            ) ||
            !Number.isSafeInteger(r.control_epoch) ||
            (r.control_epoch as number) < 0
          )
            throw new ContractValidationError();
          path = "/api/control";
          break;
        }
        case "action":
          parseWorkbenchActionCommand(value);
          path = "/api/action";
          break;
        case "guidance":
          operationRecord(value, [
            "guidance_id",
            "session_id",
            "article_id",
            "control_epoch",
            "text",
          ]);
          path = "/api/guidance";
          break;
        case "cancel-guidance":
          operationRecord(value, ["guidance_id", "session_id"]);
          path = "/api/guidance/cancel";
          break;
        case "activate-tab": {
          const r = operationRecord(value, ["page_id"]);
          identifier(r.page_id);
          path = "/api/tabs/activate";
          break;
        }
        case "accept-candidate":
        case "abandon-candidate":
          operationRecord(value, [
            "session_id",
            "control_epoch",
            "sha256",
            "transfer_id",
          ]);
          path =
            operation === "accept-candidate"
              ? "/api/candidate/accept"
              : "/api/candidate/abandon";
          break;
        default:
          throw new ContractValidationError();
      }
      const result = await this.json(await this.request(path, value, signal));
      return {
        ...result,
        ...(result.view ? { view: this.view(result.view) } : {}),
      };
    });
    this.tail = pending.catch(() => undefined);
    return pending.catch((error: unknown) => {
      if (signal?.aborted || this.stop.signal.aborted)
        throw new MachineWorkbenchError("operation-cancelled");
      throw error;
    });
  }
  private view(value: unknown) {
    const view = parseWorkbenchView(value);
    return {
      ...view,
      controlled_by_client: view.control.controller_id === this.clientId,
    };
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stop.abort();
      clearInterval(this.timer);
      await Promise.allSettled([this.tail, this.heartbeat]);
      try {
        if (this.clientId) {
          await this.json(
            await this.request(
              "/api/clients/disconnect",
              {},
              undefined,
              false,
              true,
            ),
          );
        }
      } finally {
        try {
          if (this.authenticated)
            await this.json(
              await this.request("/auth/logout", {}, undefined, true, true),
            );
        } finally {
          this.cookie = "";
          this.csrf = "";
          this.clientId = "";
          this.authenticated = false;
        }
      }
    })();
    return this.closing;
  }
}
