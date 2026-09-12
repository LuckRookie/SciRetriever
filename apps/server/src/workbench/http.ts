import { once } from "node:events";
import {
  LiteratureNotFoundError,
  type LiteratureQueryService,
} from "../literature/query.js";
import type { LiteratureArtifactService } from "../literature/artifacts.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkbenchSession, WorkbenchSessionError } from "./session.js";
import type { BrowserPageInfo } from "../browser/host.js";
import { exportBibliography } from "../literature/bibliography.js";
import type { ConfigurationReadiness } from "@sciretriever/contracts";
import type {
  ConfigurationSection,
  TypeScriptConfigurationDiff,
  TypeScriptConfigurationSnapshot,
  TypeScriptCredentialEdit,
} from "../configuration/owner.js";

export interface WorkbenchStaticAsset {
  readonly contentType: string;
  readonly body: string | Uint8Array;
}
export interface WorkbenchHttpOptions {
  readonly session: WorkbenchSession;
  readonly tabs?: {
    list(): Promise<readonly BrowserPageInfo[]>;
    activate(pageId: string): Promise<void>;
  };
  readonly library?: {
    readonly queries: LiteratureQueryService;
    readonly artifacts: LiteratureArtifactService;
  };
  readonly configuration?: {
    status(signal?: AbortSignal): Promise<ConfigurationReadiness>;
    read?(signal?: AbortSignal): Promise<TypeScriptConfigurationSnapshot>;
    diff?(
      payload: string,
      baseline: string,
      signal?: AbortSignal,
    ): Promise<TypeScriptConfigurationDiff>;
    publish?(
      payload: string,
      baseline: string,
      sections: readonly ConfigurationSection[],
      signal?: AbortSignal,
    ): Promise<TypeScriptConfigurationSnapshot>;
    credential?(
      edit: TypeScriptCredentialEdit,
      baseline: string,
      signal?: AbortSignal,
    ): Promise<ConfigurationReadiness>;
  };
  /** Durable execution surface exposed through the same authenticated port. */
  readonly jobs?: {
    list(limit?: number): Promise<unknown>;
    get(jobId: string): Promise<unknown>;
    targets(jobId: string, limit?: number): Promise<unknown>;
    attempts(targetId: string, limit?: number): Promise<unknown>;
    events(jobId: string, after?: number, limit?: number): Promise<unknown>;
    policy(jobId: string): Promise<unknown>;
    budget(jobId: string): Promise<unknown>;
    interventions(jobId: string, limit?: number): Promise<unknown>;
    run(jobId: string): Promise<unknown>;
    resolveIntervention(
      interventionId: string,
      resolution: "continue" | "skip" | "cancel",
    ): Promise<unknown>;
    create(input: unknown): Promise<unknown>;
    pause(jobId: string): Promise<unknown>;
    resume(jobId: string): Promise<unknown>;
    cancel(jobId: string): Promise<unknown>;
  };
  readonly assets: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
}
interface ClientGrant {
  readonly csrf: string;
  touched: number;
}
const CLIENT_TTL = 180000;
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid command");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  )
    throw new Error("invalid command");
  return record;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json")
    throw new Error("invalid command");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > 65536) throw new Error("invalid command");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Loopback UI transport. Only opaque per-tab grants leave this authentication boundary. */
export async function startWorkbenchHttp(
  options: WorkbenchHttpOptions,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const session = options.session;
  const cookieName = `sr_workbench_${randomBytes(8).toString("hex")}`;
  const cookie = randomBytes(32).toString("hex");
  const clients = new Map<string, ClientGrant>();
  const streams = new Set<ServerResponse>();
  let origin = "",
    host = "",
    closing = false;
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        const code =
          error instanceof WorkbenchSessionError
            ? error.code
            : "command-rejected";
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.removeHeader("Content-Disposition");
        json(response, error instanceof LiteratureNotFoundError ? 404 : 409, {
          code:
            error instanceof LiteratureNotFoundError
              ? "literature-not-found"
              : code,
        });
      });
    },
  );
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const requestOrigin = request.headers.origin;
    if (
      closing ||
      request.headers.host !== host ||
      (requestOrigin !== undefined && requestOrigin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      request.headers["sec-fetch-site"] === "same-site" ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(
        request.socket.remoteAddress ?? "",
      )
    ) {
      json(response, 403, { code: "local-origin-required" });
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    const pathname = url.pathname.startsWith("/api/v1/")
      ? `/api/${url.pathname.slice("/api/v1/".length)}`
      : url.pathname;
    if (
      url.origin !== origin ||
      !["GET", "POST"].includes(request.method ?? "")
    ) {
      json(response, 405, { code: "method-not-allowed" });
      return;
    }
    const cookies = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim());
    const authenticated = cookies.some((part) =>
      equal(part, `${cookieName}=${cookie}`),
    );
    if (request.method === "GET" && pathname === "/" && !url.search) {
      response.setHeader(
        "Set-Cookie",
        `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Strict`,
      );
      const asset = options.assets.get("/");
      if (!asset) {
        json(response, 404, { code: "ui-unavailable" });
        return;
      }
      response.writeHead(200, { "Content-Type": asset.contentType });
      response.end(asset.body);
      return;
    }
    if (!authenticated) {
      json(response, 401, { code: "authentication-required" });
      return;
    }
    if (
      request.method === "GET" &&
      !url.search &&
      options.assets.has(pathname)
    ) {
      const asset = options.assets.get(pathname)!;
      response.writeHead(200, { "Content-Type": asset.contentType });
      response.end(asset.body);
      return;
    }
    if (
      request.method === "POST" &&
      pathname === "/api/clients" &&
      !url.search
    ) {
      if (
        requestOrigin !== origin ||
        request.headers["x-workbench-init"] !== "1"
      ) {
        json(response, 403, { code: "csrf-required" });
        return;
      }
      object(await body(request), []);
      const clientId = session.attach();
      const grant = {
        csrf: randomBytes(32).toString("hex"),
        touched: Date.now(),
      };
      clients.set(clientId, grant);
      json(response, 201, {
        client_id: clientId,
        csrf: grant.csrf,
        view: session.view(),
      });
      return;
    }
    const queryKeys = [...url.searchParams.keys()];
    if (
      queryKeys.some(
        (key) => !["client_id", "frame_seq", "limit", "after"].includes(key),
      ) ||
      new Set(queryKeys).size !== queryKeys.length
    ) {
      json(response, 400, { code: "invalid-query" });
      return;
    }
    const clientId = url.searchParams.get("client_id") ?? "";
    const grant = clients.get(clientId);
    if (!grant) {
      json(response, 401, { code: "client-required" });
      return;
    }
    grant.touched = Date.now();
    if (request.method === "GET" && pathname === "/api/view") {
      json(response, 200, session.view());
      return;
    }
    if (request.method === "GET" && pathname === "/api/version") {
      json(response, 200, { api_version: 1 });
      return;
    }
    if (request.method === "GET" && pathname === "/api/tabs") {
      if (!options.tabs) {
        json(response, 503, { code: "tabs-unavailable" });
        return;
      }
      json(response, 200, { tabs: await options.tabs.list() });
      return;
    }
    if (request.method === "GET" && pathname === "/api/frame") {
      const raw = url.searchParams.get("frame_seq") ?? "";
      if (!/^\d{1,15}$/u.test(raw)) {
        json(response, 400, { code: "invalid-frame" });
        return;
      }
      const frame = session.frame(Number(raw));
      if (!frame) {
        json(response, 409, { code: "frame-replaced" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": frame.byteLength,
      });
      response.end(frame);
      return;
    }
    if (request.method === "GET" && pathname === "/api/events") {
      if (streams.size >= 16) {
        json(response, 429, { code: "viewer-limit" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      });
      streams.add(response);
      const send = () => {
        grant.touched = Date.now();
        // A slow viewer gets the current projection after drain, never an unbounded frame queue.
        if (!response.destroyed && !response.writableNeedDrain)
          response.write(
            `event: view\ndata: ${JSON.stringify(session.view())}\n\n`,
          );
      };
      send();
      const timer = setInterval(send, 750);
      timer.unref();
      response.once("close", () => {
        clearInterval(timer);
        streams.delete(response);
      });
      return;
    }
    if (request.method === "GET" && pathname.startsWith("/api/jobs")) {
      const jobs = options.jobs;
      if (!jobs) {
        json(response, 503, { code: "jobs-unavailable" });
        return;
      }
      const parts = pathname.split("/").filter(Boolean);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const after = Number(url.searchParams.get("after") ?? "-1");
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !Number.isSafeInteger(after) ||
        after < -1
      ) {
        json(response, 400, { code: "invalid-query" });
        return;
      }
      const id = parts[2] ?? "";
      if (id && !/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) {
        json(response, 400, { code: "invalid-job-id" });
        return;
      }
      if (parts.length === 2) {
        json(response, 200, { jobs: await jobs.list(limit) });
        return;
      }
      if (parts.length === 3) {
        json(response, 200, { job: await jobs.get(id) });
        return;
      }
      if (parts.length === 4 && parts[3] === "targets") {
        json(response, 200, { targets: await jobs.targets(id, limit) });
        return;
      }
      if (parts.length === 4 && parts[3] === "events") {
        json(response, 200, { events: await jobs.events(id, after, limit) });
        return;
      }
      if (parts.length === 4 && parts[3] === "policy") {
        json(response, 200, { policy: await jobs.policy(id) });
        return;
      }
      if (parts.length === 4 && parts[3] === "budget") {
        json(response, 200, { budget: await jobs.budget(id) });
        return;
      }
      if (parts.length === 4 && parts[3] === "interventions") {
        json(response, 200, {
          interventions: await jobs.interventions(id, limit),
        });
        return;
      }
      if (
        parts.length === 6 &&
        parts[3] === "targets" &&
        parts[5] === "attempts"
      ) {
        const targetId = parts[4] ?? "";
        if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(targetId)) {
          json(response, 400, { code: "invalid-target-id" });
          return;
        }
        json(response, 200, {
          attempts: await jobs.attempts(targetId, limit),
        });
        return;
      }
      json(response, 404, { code: "endpoint-not-found" });
      return;
    }
    if (
      request.method !== "POST" ||
      requestOrigin !== origin ||
      typeof request.headers["x-workbench-csrf"] !== "string" ||
      !equal(request.headers["x-workbench-csrf"], grant.csrf)
    ) {
      json(response, 403, { code: "csrf-required" });
      return;
    }
    const value = await body(request);
    if (pathname === "/api/tabs/activate") {
      if (!options.tabs) {
        json(response, 503, { code: "tabs-unavailable" });
        return;
      }
      const command = object(value, ["page_id"]);
      if (
        typeof command.page_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(command.page_id)
      )
        throw new Error("invalid tab command");
      await options.tabs.activate(command.page_id);
      await session.refresh();
      json(response, 200, { view: session.view() });
      return;
    }
    if (pathname === "/api/jobs") {
      if (!options.jobs) {
        json(response, 503, { code: "jobs-unavailable" });
        return;
      }
      json(response, 201, { job: await options.jobs.create(value) });
      return;
    }
    if (pathname.startsWith("/api/jobs/") && options.jobs) {
      const parts = pathname.split("/").filter(Boolean);
      if (
        parts.length === 6 &&
        parts[3] === "interventions" &&
        parts[5] === "resolve"
      ) {
        const command = object(value, ["resolution"]);
        if (
          !["continue", "skip", "cancel"].includes(command.resolution as string)
        )
          throw new Error("invalid command");
        json(response, 200, {
          intervention: await options.jobs.resolveIntervention(
            parts[4]!,
            command.resolution as "continue" | "skip" | "cancel",
          ),
        });
        return;
      }
    }
    if (pathname.startsWith("/api/jobs/") && options.jobs) {
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length === 4 && parts[3] === "run") {
        const id = parts[2] ?? "";
        if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) {
          json(response, 400, { code: "invalid-job-command" });
          return;
        }
        object(value, []);
        json(response, 200, { results: await options.jobs.run(id) });
        return;
      }
      const id = parts[2] ?? "";
      if (
        parts.length !== 4 ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(id) ||
        !["pause", "resume", "cancel"].includes(parts[3]!)
      ) {
        json(response, 400, { code: "invalid-job-command" });
        return;
      }
      const action = parts[3];
      const job =
        action === "pause"
          ? await options.jobs.pause(id)
          : action === "resume"
            ? await options.jobs.resume(id)
            : await options.jobs.cancel(id);
      json(response, 200, { job });
      return;
    }
    if (pathname.startsWith("/api/library/")) {
      const library = options.library;
      if (!library) {
        json(response, 503, { code: "library-unavailable" });
        return;
      }
      switch (pathname) {
        case "/api/library/search":
          json(response, 200, { page: await library.queries.search(value) });
          return;
        case "/api/library/detail": {
          const command = object(value, ["literature_id"]);
          json(response, 200, {
            detail: await library.queries.detail(command.literature_id),
          });
          return;
        }
        case "/api/library/references":
          json(response, 200, {
            page: await library.queries.references(value),
          });
          return;
        case "/api/library/reference": {
          const command = object(value, ["reference_id"]);
          json(response, 200, {
            detail: await library.queries.referenceDetail(command.reference_id),
          });
          return;
        }
        case "/api/library/bibliography": {
          const command = object(value, ["literature_id", "format"]);
          if (
            command.format !== "bibtex" &&
            command.format !== "biblatex" &&
            command.format !== "ris" &&
            command.format !== "csl-json"
          )
            throw new Error("invalid bibliography format");
          if (typeof command.literature_id !== "string")
            throw new Error("invalid literature id");
          const detail = await library.queries.detail(command.literature_id);
          const bytes = exportBibliography(detail, command.format);
          const contentType =
            command.format === "bibtex" || command.format === "biblatex"
              ? "application/x-bibtex; charset=utf-8"
              : command.format === "ris"
                ? "application/x-research-info-systems; charset=utf-8"
                : "application/json; charset=utf-8";
          const extension =
            command.format === "bibtex"
              ? "bib"
              : command.format === "biblatex"
                ? "biblatex"
                : command.format === "ris"
                  ? "ris"
                  : "json";
          response.writeHead(200, {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${detail.literature.literature_id}.${extension}"`,
            "Content-Length": bytes.byteLength,
          });
          response.end(bytes);
          return;
        }
        case "/api/library/artifact": {
          const command = object(value, ["literature_id", "kind"]);
          if (
            command.kind !== "primary-pdf" &&
            command.kind !== "content-markdown"
          )
            throw new Error("invalid artifact kind");
          const detail = await library.queries.detail(command.literature_id);
          const descriptor =
            command.kind === "primary-pdf"
              ? detail.primary_pdf?.asset
              : detail.content?.markdown;
          if (!descriptor) {
            json(response, 404, { code: "artifact-not-found" });
            return;
          }
          const stop = new AbortController();
          const abort = () => stop.abort();
          response.once("close", abort);
          response.setHeader(
            "Content-Type",
            command.kind === "primary-pdf"
              ? "application/pdf"
              : "text/markdown; charset=utf-8",
          );
          response.setHeader(
            "Content-Disposition",
            `attachment; filename="${detail.literature.literature_id}.${command.kind === "primary-pdf" ? "pdf" : "md"}"`,
          );
          try {
            await library.artifacts.withArtifact(
              descriptor,
              async (chunks) => {
                for await (const chunk of chunks) {
                  if (stop.signal.aborted)
                    throw new Error("download cancelled");
                  if (!response.write(chunk))
                    await once(response, "drain", { signal: stop.signal });
                }
              },
              { signal: stop.signal },
            );
            response.end();
          } finally {
            response.off("close", abort);
          }
          return;
        }
        default:
          json(response, 404, { code: "endpoint-not-found" });
          return;
      }
    }
    if (pathname === "/api/configuration/status") {
      if (!options.configuration) {
        json(response, 503, { code: "configuration-unavailable" });
        return;
      }
      json(response, 200, { status: await options.configuration.status() });
      return;
    }
    if (pathname === "/api/configuration/read") {
      if (!options.configuration?.read) {
        json(response, 503, { code: "configuration-unavailable" });
        return;
      }
      json(response, 200, { snapshot: await options.configuration.read() });
      return;
    }
    if (pathname === "/api/configuration/diff") {
      if (!options.configuration?.diff) {
        json(response, 503, { code: "configuration-unavailable" });
        return;
      }
      const command = object(value, ["payload", "baseline"]);
      if (
        typeof command.payload !== "string" ||
        typeof command.baseline !== "string"
      )
        throw new Error("invalid configuration command");
      json(response, 200, {
        diff: await options.configuration.diff(
          command.payload,
          command.baseline,
        ),
      });
      return;
    }
    if (pathname === "/api/configuration/publish") {
      if (!options.configuration?.publish) {
        json(response, 503, { code: "configuration-unavailable" });
        return;
      }
      const command = object(value, ["payload", "baseline", "sections"]);
      if (
        typeof command.payload !== "string" ||
        typeof command.baseline !== "string" ||
        !Array.isArray(command.sections) ||
        command.sections.some((section) => typeof section !== "string")
      )
        throw new Error("invalid configuration command");
      json(response, 200, {
        snapshot: await options.configuration.publish(
          command.payload,
          command.baseline,
          command.sections as ConfigurationSection[],
        ),
      });
      return;
    }
    if (pathname === "/api/configuration/credential") {
      if (!options.configuration?.credential) {
        json(response, 503, { code: "configuration-unavailable" });
        return;
      }
      const command = object(value, ["edit", "baseline"]);
      if (typeof command.baseline !== "string")
        throw new Error("invalid configuration command");
      json(response, 200, {
        status: await options.configuration.credential(
          command.edit as TypeScriptCredentialEdit,
          command.baseline,
        ),
      });
      return;
    }
    if (pathname === "/api/candidate/accept") {
      await session.acceptCandidate(clientId, value);
      json(response, 200, { view: session.view() });
      return;
    }
    if (pathname === "/api/candidate/abandon") {
      await session.abandonCandidate(clientId, value);
      json(response, 200, { view: session.view() });
      return;
    }
    if (pathname === "/api/action") {
      const result = await session.command(clientId, value);
      await session.refresh();
      json(response, 200, { result, view: session.view() });
      return;
    }
    if (pathname === "/api/control") {
      const command = object(value, ["kind", "control_epoch"]);
      const epoch = command.control_epoch;
      if (
        typeof epoch !== "number" ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0
      )
        throw new Error("invalid epoch");
      switch (command.kind) {
        case "takeover":
          session.takeover(clientId, epoch);
          break;
        case "release":
          session.release(clientId, epoch);
          break;
        case "pause":
          session.pause(clientId, epoch);
          break;
        case "resume":
          session.resume(clientId, epoch);
          break;
        case "cancel":
          session.cancel(clientId, epoch);
          break;
        case "agent-step": {
          // Respond immediately so a slow model cannot hold the human control channel.
          void session.runAgent(clientId, epoch).catch(() => undefined);
          break;
        }
        default:
          throw new Error("invalid control command");
      }
      json(response, 200, { view: session.view() });
      return;
    }
    if (pathname === "/api/target") {
      const command = object(value, ["article_id", "control_epoch"]);
      if (
        typeof command.article_id !== "string" ||
        typeof command.control_epoch !== "number" ||
        !Number.isSafeInteger(command.control_epoch)
      )
        throw new Error("invalid target command");
      await session.selectTarget(
        clientId,
        command.control_epoch,
        command.article_id,
      );
      json(response, 200, { view: session.view() });
      return;
    }
    json(response, 404, { code: "endpoint-not-found" });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("workbench listen failed");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  const refreshTimer = setInterval(() => {
    if (clients.size) void session.refresh();
    for (const [id, grant] of clients)
      if (Date.now() - grant.touched > CLIENT_TTL) {
        clients.delete(id);
        session.detach(id);
      }
  }, 750);
  refreshTimer.unref();
  return {
    origin,
    close: async () => {
      if (closing) return;
      closing = true;
      clearInterval(refreshTimer);
      for (const response of streams) response.end();
      for (const id of clients.keys()) session.detach(id);
      clients.clear();
      const done = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await done;
    },
  };
}
