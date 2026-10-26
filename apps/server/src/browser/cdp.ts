import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseStrictJsonObject } from "@sciretriever/contracts";

export class BrowserProtocolError extends Error {
  readonly code = "browser-protocol";
  constructor(
    readonly reason:
      | "operation"
      | "target-inactive"
      | "request-inactive"
      | "command-cancelled"
      | "closed"
      | "timeout" = "operation",
  ) {
    super("owned Browser protocol operation failed");
    this.name = "BrowserProtocolError";
  }
}
export interface BrowserProtocolEvent {
  readonly params: Readonly<Record<string, unknown>>;
  readonly session_id: string | undefined;
}
export interface BrowserProtocol {
  send(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  on(
    method: string,
    listener: (event: BrowserProtocolEvent) => void,
  ): () => void;
}

/** Only call while holding the Profile lease and before launching its process. */
export async function clearOwnedDebugEndpoint(profile: string): Promise<void> {
  const path = join(profile, "DevToolsActivePort");
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      metadata.size > 512
    )
      throw new BrowserProtocolError();
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A local capability for this newly launched, Profile-locked Browser only. */
export class OwnedBrowserCdpConnection implements BrowserProtocol {
  private sequence = 0;
  private closed = false;
  private readonly disconnects = new Set<() => void>();
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: Record<string, unknown>) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
      readonly removeAbort: () => void;
    }
  >();
  private readonly listeners = new Map<
    string,
    Set<(event: BrowserProtocolEvent) => void>
  >();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new BrowserProtocolError();
        const message = parseStrictJsonObject(event.data);
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.removeAbort();
          if (message.error !== undefined) {
            const error = message.error;
            const inactive =
              typeof error === "object" &&
              error !== null &&
              "message" in error &&
              [
                "Not attached to an active page",
                "Session with given id not found.",
              ].includes(String(error.message));
            const inactiveRequest =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === -32602 &&
              "message" in error &&
              error.message === "Invalid InterceptionId.";
            pending.reject(
              new BrowserProtocolError(
                inactive
                  ? "target-inactive"
                  : inactiveRequest
                    ? "request-inactive"
                    : "operation",
              ),
            );
          } else if (
            typeof message.result === "object" &&
            message.result !== null &&
            !Array.isArray(message.result)
          )
            pending.resolve(message.result as Record<string, unknown>);
          else pending.reject(new BrowserProtocolError());
          return;
        }
        if (
          typeof message.method !== "string" ||
          typeof message.params !== "object" ||
          message.params === null ||
          Array.isArray(message.params)
        )
          throw new BrowserProtocolError();
        const sessionId = message.sessionId;
        if (sessionId !== undefined && typeof sessionId !== "string")
          throw new BrowserProtocolError();
        const payload: BrowserProtocolEvent = {
          params: message.params as Record<string, unknown>,
          session_id: sessionId,
        };
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(payload);
      } catch {
        this.fail();
      }
    });
    socket.addEventListener("error", () => this.fail());
    socket.addEventListener("close", () => this.fail());
  }

  static async connect(profile: string): Promise<OwnedBrowserCdpConnection> {
    const file = await open(
      join(profile, "DevToolsActivePort"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let endpoint: string;
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== process.getuid?.() ||
        metadata.size > 512
      )
        throw new BrowserProtocolError();
      const [port, path, extra] = (await file.readFile("utf8"))
        .trim()
        .split("\n");
      if (
        !port ||
        !/^\d{1,5}$/u.test(port) ||
        Number(port) < 1 ||
        Number(port) > 65535 ||
        !path ||
        !/^\/devtools\/browser\/[a-f0-9-]{36}$/u.test(path) ||
        extra !== undefined
      )
        throw new BrowserProtocolError();
      endpoint = `ws://127.0.0.1:${port}${path}`;
    } finally {
      await file.close();
    }
    const socket = new WebSocket(endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new BrowserProtocolError()),
          5000,
        );
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new BrowserProtocolError());
          },
          { once: true },
        );
      });
      return new OwnedBrowserCdpConnection(socket);
    } catch {
      socket.close();
      throw new BrowserProtocolError();
    }
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
    timeoutMs = 15000,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new BrowserProtocolError("closed"));
    if (signal?.aborted)
      return Promise.reject(new BrowserProtocolError("command-cancelled"));
    // Navigation waits include platform admission and response/commit, not just
    // protocol processing. Only an explicitly owned navigation can omit the RPC
    // timer; its article cancellation/lifetime and connection still bound it.
    if (timeoutMs === 0 && (method !== "Page.navigate" || !signal))
      return Promise.reject(new BrowserProtocolError());
    const id = ++this.sequence;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        timeoutMs === 0
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              removeAbort();
              reject(new BrowserProtocolError("timeout"));
            }, timeoutMs);
      const abort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        removeAbort();
        reject(new BrowserProtocolError("command-cancelled"));
      };
      const removeAbort = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, timer, removeAbort });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (this.pending.has(id))
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    return response;
  }

  on(
    method: string,
    listener: (event: BrowserProtocolEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    this.listeners.set(method, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  close(): void {
    if (this.closed) return;
    this.fail();
    this.socket.close();
  }
  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener);
    return () => {
      this.disconnects.delete(listener);
    };
  }
  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort();
      pending.reject(new BrowserProtocolError("closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    for (const listener of this.disconnects) listener();
    this.disconnects.clear();
  }
}
