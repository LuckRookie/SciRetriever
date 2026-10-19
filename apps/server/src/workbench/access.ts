import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseStrictJsonObject } from "@sciretriever/contracts";
import type { WorkbenchStaticAsset } from "./http.js";

export interface WorkbenchAccessOptions {
  readonly host?: string;
  readonly password?: string;
}
export class WorkbenchAccessError extends Error {
  constructor(readonly code: "web-access-invalid" | "web-password-required") {
    super(code);
  }
}
export const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_LIMIT = 64;
const LOGIN_WINDOW_MS = 60_000;
// JSON escaping can expand a valid 1024-byte secret to more than 6 KiB.
const LOGIN_BODY_BYTES = 8192;
const PUBLIC_ASSETS = new Set(["/auth.js", "/auth.css"]);

export function isLoopbackPeer(request: IncomingMessage): boolean {
  return ["127.0.0.1", "::ffff:127.0.0.1"].includes(
    request.socket.remoteAddress ?? "",
  );
}

/** Validate before Application assembly can create or open a library. */
export function validateWorkbenchAccess(options: WorkbenchAccessOptions): void {
  const host = options.host ?? "0.0.0.0";
  if (isIP(host) !== 4) throw new WorkbenchAccessError("web-access-invalid");
  if (
    options.password !== undefined &&
    (typeof options.password !== "string" ||
      options.password.trim().length < 12 ||
      Buffer.byteLength(options.password) > 1024)
  )
    throw new WorkbenchAccessError("web-password-required");
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { Location: location });
  response.end();
}

export interface WorkbenchAccessGrant {
  readonly origin: string;
  readonly sessionId: string;
}

/** Single-user transport authentication. It owns no library or persistent facts. */
export class WorkbenchAccess {
  readonly host: string;
  /** Only generated credentials are returned to the startup caller for display. */
  readonly apiKey: string | undefined;
  private readonly salt = randomBytes(16);
  private passwordHash: Buffer | undefined;
  private readonly cookieName = `sr_auth_${randomBytes(8).toString("hex")}`;
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<
    string,
    { start: number; count: number }
  >();
  private windowStart = 0;
  private windowCount = 0;
  private activeLogins = 0;
  origin = "";
  listenAddress = "";
  urls: readonly string[] = [];
  private closed = false;

  private constructor(
    options: WorkbenchAccessOptions,
    private readonly revoked: (id: string) => void,
  ) {
    this.host = options.host ?? "0.0.0.0";
    this.apiKey =
      options.password === undefined
        ? randomBytes(32).toString("base64url")
        : undefined;
  }
  static async create(
    options: WorkbenchAccessOptions,
    revoked: (id: string) => void,
  ) {
    validateWorkbenchAccess(options);
    const access = new WorkbenchAccess(options, revoked);
    access.passwordHash = await derive(
      options.password ?? access.apiKey!,
      access.salt,
    );
    return access;
  }
  listening(port: number): void {
    this.listenAddress = `${this.host}:${port}`;
    this.origin = new URL(
      `http://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${port}`,
    ).origin;
    const addresses =
      this.host === "0.0.0.0"
        ? Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? [])
              .filter((entry) => entry.family === "IPv4" && !entry.internal)
              .map((entry) => entry.address),
          )
        : [this.host];
    this.urls = [
      ...new Set([
        ...addresses.map(
          (host) => `${new URL(`http://${host}:${port}`).origin}/`,
        ),
        `${this.origin}/`,
      ]),
    ];
  }
  address(request: IncomingMessage): { origin: string; host: string } | null {
    // A literal IP (including NAT addresses) or localhost can name this service.
    // Host selects the request's origin, never grants authentication. Do not
    // trust forwarding headers or arbitrary DNS names (DNS rebinding).
    const host = request.headers.host;
    if (!host || !/^(?:localhost|[0-9.]+)(?::[0-9]{1,5})?$/u.test(host))
      return null;
    let url: URL;
    try {
      url = new URL(`http://${host}`);
    } catch {
      return null;
    }
    if (
      (host.split(":")[0] !== "localhost" && isIP(host.split(":")[0]!) !== 4) ||
      url.hostname === "0.0.0.0"
    )
      return null;
    const origin = url.origin;
    if (
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      ["cross-site", "same-site"].includes(
        String(request.headers["sec-fetch-site"]),
      )
    )
      return null;
    return { origin, host: url.host };
  }
  private sessionId(request: IncomingMessage): string | null {
    const prefix = `${this.cookieName}=`;
    const value = (request.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(prefix))
      ?.slice(prefix.length);
    if (!value || !/^[a-f0-9]{64}$/u.test(value)) return null;
    const id = digest(value);
    return this.valid(id) ? id : null;
  }
  valid(id: string): boolean {
    const expiry = this.sessions.get(id);
    if (expiry !== undefined && expiry > Date.now() && !this.closed)
      return true;
    if (expiry !== undefined) {
      this.sessions.delete(id);
      this.revoked(id);
    }
    return false;
  }
  sweep(): void {
    for (const id of this.sessions.keys()) this.valid(id);
  }
  private permitLogin(address: string): boolean {
    const now = Date.now();
    if (now - this.windowStart >= LOGIN_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    for (const [ip, bucket] of this.attempts)
      if (now - bucket.start >= LOGIN_WINDOW_MS) this.attempts.delete(ip);
    let bucket = this.attempts.get(address);
    if (!bucket) {
      if (this.attempts.size >= 256) return false;
      bucket = { start: now, count: 0 };
      this.attempts.set(address, bucket);
    }
    if (bucket.count >= 10 || this.windowCount >= 60 || this.activeLogins >= 2)
      return false;
    bucket.count++;
    this.windowCount++;
    return true;
  }
  private cookie(token: string, maxAge: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }
  async authorize(
    request: IncomingMessage,
    response: ServerResponse,
    assets: ReadonlyMap<string, WorkbenchStaticAsset>,
  ): Promise<WorkbenchAccessGrant | null> {
    const address = this.address(request);
    if (this.closed || !address) {
      json(response, 403, { code: "origin-not-allowed" });
      return null;
    }
    const url = new URL(request.url ?? "/", address.origin);
    if (url.origin !== address.origin) {
      json(response, 403, { code: "origin-not-allowed" });
      return null;
    }
    const id = this.sessionId(request);
    if (
      url.pathname === "/auth/status" &&
      request.method === "GET" &&
      !url.search
    ) {
      json(response, 200, {
        required: true,
        authenticated: id !== null,
      });
      return null;
    }
    if (
      request.method === "GET" &&
      !url.search &&
      PUBLIC_ASSETS.has(url.pathname)
    ) {
      const asset = assets.get(url.pathname);
      if (asset) {
        response.writeHead(200, { "Content-Type": asset.contentType });
        response.end(asset.body);
      } else json(response, 404, { code: "ui-unavailable" });
      return null;
    }
    if (url.pathname === "/auth" && request.method === "GET") {
      const asset = assets.get("/auth");
      if (asset) {
        response.writeHead(200, { "Content-Type": asset.contentType });
        response.end(asset.body);
      } else json(response, 404, { code: "ui-unavailable" });
      return null;
    }
    if (["/auth/login", "/auth/logout"].includes(url.pathname)) {
      if (
        request.method !== "POST" ||
        url.search ||
        request.headers.origin !== address.origin ||
        request.headers["x-workbench-init"] !== "1" ||
        request.headers["content-type"] !== "application/json"
      ) {
        json(response, 403, { code: "csrf-required" });
        return null;
      }
      if (url.pathname === "/auth/logout") {
        if (id) {
          this.sessions.delete(id);
          this.revoked(id);
        }
        response.setHeader("Set-Cookie", this.cookie("", 0));
        json(response, 200, { authenticated: false });
        return null;
      }
      if (!this.permitLogin(request.socket.remoteAddress ?? "unknown")) {
        response.setHeader("Retry-After", "60");
        json(response, 429, { code: "login-rate-limited" });
        return null;
      }
      this.activeLogins++;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > LOGIN_BODY_BYTES) {
            json(response, 413, { code: "login-input-invalid" });
            return null;
          }
          chunks.push(bytes);
        }
        let value: Record<string, unknown>;
        try {
          value = parseStrictJsonObject(Buffer.concat(chunks));
        } catch {
          json(response, 400, { code: "login-input-invalid" });
          return null;
        }
        if (
          Object.keys(value).length !== 1 ||
          typeof value.password !== "string" ||
          Buffer.byteLength(value.password) > 1024
        ) {
          json(response, 400, { code: "login-input-invalid" });
          return null;
        }
        const candidate = await derive(value.password, this.salt);
        if (
          this.closed ||
          !this.passwordHash ||
          !timingSafeEqual(candidate, this.passwordHash)
        ) {
          json(response, 401, { code: "login-failed" });
          return null;
        }
        this.sweep();
        if (id) {
          this.sessions.delete(id);
          this.revoked(id);
        }
        if (this.sessions.size >= SESSION_LIMIT) {
          json(response, 429, { code: "login-session-limit" });
          return null;
        }
        const token = randomBytes(32).toString("hex");
        this.sessions.set(digest(token), Date.now() + WEB_SESSION_TTL_MS);
        response.setHeader(
          "Set-Cookie",
          this.cookie(token, WEB_SESSION_TTL_MS / 1000),
        );
        json(response, 200, { authenticated: true });
        return null;
      } finally {
        this.activeLogins--;
      }
    }
    if (id === null) {
      if (request.method === "GET" && url.pathname === "/")
        redirect(
          response,
          `/auth?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
        );
      else json(response, 401, { code: "login-required" });
      return null;
    }
    return { origin: address.origin, sessionId: id };
  }
  close(): void {
    this.closed = true;
    for (const id of this.sessions.keys()) this.revoked(id);
    this.sessions.clear();
    this.attempts.clear();
    this.passwordHash?.fill(0);
  }
}
