import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContractValidationError,
  parseStrictJsonObject,
  deviceRecord,
  parseDevicePairingRequest,
  type DeviceConnection,
  type DevicePurpose,
} from "@sciretriever/contracts";
import {
  DeviceConnectionError,
  requireDevicePurpose,
  type DeviceConnectionService,
} from "./device-connections.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";

export interface DeviceRoute {
  readonly method: "GET" | "POST" | "DELETE";
  /** Anchored literal path, with optional :id segments. No wildcard/implicit subtree grants. */
  readonly path: string;
  /** Any one explicitly registered purpose suffices. No purpose implies another. */
  readonly purposes: readonly DevicePurpose[];
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    connection: DeviceConnection,
    parameters: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Explicit opt-in after the ordinary Web session/client/CSRF admission. */
  handleWeb?(
    request: IncomingMessage,
    response: ServerResponse,
    parameters: Readonly<Record<string, string>>,
  ): Promise<void>;
}

export async function handleWebDeviceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: DeviceHttpOptions | undefined,
): Promise<boolean> {
  const artifact =
    /^\/api\/v1\/device-connections\/(instructions|skill)$/u.exec(url.pathname);
  if (request.method === "GET" && artifact) {
    try {
      if (!options) throw new DeviceConnectionError("device-unavailable");
      await downloadDeviceArtifact(
        response,
        artifact[1] as keyof typeof artifactNames,
        options.artifactDirectory ?? DEVICE_ARTIFACT_DIRECTORY,
      );
    } catch (error) {
      deviceFailure(response, error);
    }
    return true;
  }
  const registered = options?.routes?.find(request.method, url.pathname);
  if (!registered?.route.handleWeb) return false;
  await registered.route.handleWeb(request, response, registered.parameters);
  return true;
}
/** Only future import/capture/MCP business surfaces can be registered. */
export class DeviceRouteRegistry {
  private readonly routes: {
    route: DeviceRoute;
    expression: RegExp;
    keys: string[];
  }[] = [];
  constructor(
    routes: readonly DeviceRoute[] = [],
    private readonly dispose?: () => Promise<void>,
  ) {
    for (const route of routes) {
      if (
        !route.purposes.length ||
        route.purposes.some(
          (p) => !["capture", "import", "read", "operate"].includes(p),
        ) ||
        !/^(?:\/api\/v1\/(?:import|capture)\/[a-zA-Z0-9:/_-]+|\/mcp)$/u.test(
          route.path,
        ) ||
        this.routes.some(
          (v) => v.route.method === route.method && v.route.path === route.path,
        )
      )
        throw new Error("Device route registration invalid");
      const keys: string[] = [];
      const pattern = route.path
        .split("/")
        .map((part) => {
          if (part.startsWith(":")) {
            if (!/^:[a-z_]+$/u.test(part))
              throw new Error("Device route registration invalid");
            keys.push(part.slice(1));
            return "([A-Za-z0-9_-]{1,128})";
          }
          return part;
        })
        .join("/");
      this.routes.push({
        route,
        expression: new RegExp("^" + pattern + "$", "u"),
        keys,
      });
    }
  }
  close(): Promise<void> {
    return this.dispose?.() ?? Promise.resolve();
  }
  find(method: string | undefined, path: string) {
    for (const entry of this.routes) {
      const match = entry.expression.exec(path);
      if (entry.route.method === method && match)
        return {
          route: entry.route,
          parameters: Object.fromEntries(
            entry.keys.map((key, i) => [key, match[i + 1]!]),
          ),
        };
    }
    return null;
  }
}
const artifactNames = {
  instructions: "instructions.md",
  skill: "skill.zip",
  extension: "browser-extension.zip",
} as const;
export const DEVICE_ARTIFACT_DIRECTORY = new URL(
  "../agent-access/",
  import.meta.url,
);
export interface DeviceHttpOptions {
  readonly service: DeviceConnectionService;
  readonly routes?: DeviceRouteRegistry;
  /** Offline artifact seam; production always resolves the installed build directory. */
  readonly artifactDirectory?: URL;
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
export function deviceFailure(response: ServerResponse, error: unknown) {
  if (catalogCorruption(error)) {
    if (response.headersSent || response.destroyed) response.destroy();
    else
      reply(response, 503, {
        protocol_version: 1,
        code: "catalog-corrupt",
        maintenance_hint: "verify-catalog",
      });
    return;
  }
  const code =
    error instanceof DeviceConnectionError
      ? error.code
      : error instanceof ContractValidationError
        ? "device-input-invalid"
        : "device-unavailable";
  const status =
    code === "device-exchange-rate-limited"
      ? 429
      : code === "device-purpose-forbidden" ||
          code === "device-address-mismatch"
        ? 403
        : code === "device-connection-missing"
          ? 404
          : code === "device-artifact-unavailable" ||
              code === "device-unavailable"
            ? 503
            : code === "device-token-invalid" || code === "device-revoked"
              ? 401
              : code === "device-pairing-used" ||
                  code === "device-pairing-expired"
                ? 409
                : 400;
  if (status === 429) response.setHeader("Retry-After", "60");
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  reply(response, status, { protocol_version: 1, code });
}
/** Issued material is recognizable; encoded URL material is rejected before any auth/logging. */
export function deviceMaterialInUrl(raw: string): boolean {
  let decoded = raw;
  try {
    for (let n = 0; n < 3; n++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return true;
  }
  return /(?:srd1_|srp1_|sr-connect1:|[?&](?:token|access_token|device_token|pairing_code|connection_code|authorization)=)/iu.test(
    decoded,
  );
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json")
    throw new ContractValidationError();
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 8192) throw new ContractValidationError();
    parts.push(bytes);
  }
  return parseStrictJsonObject(Buffer.concat(parts));
}
export async function downloadDeviceArtifact(
  response: ServerResponse,
  kind: keyof typeof artifactNames,
  directory: URL,
) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      new URL(artifactNames[kind], directory),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await file.stat();
    const limit =
      kind === "extension"
        ? 16 * 1024 * 1024
        : kind === "skill"
          ? 8 * 1024 * 1024
          : 1024 * 1024;
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > limit
    )
      throw new Error("Invalid device artifact");
    // A replaced/growing build file must not turn a bounded download into an
    // unbounded readFile allocation. Read no more than its admitted size + 1.
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await file.read(buffer, size, buffer.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await file.stat();
    if (
      size !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error("Invalid device artifact");
    const bytes = buffer.subarray(0, size);
    response.writeHead(200, {
      "Content-Type":
        kind === "instructions"
          ? "text/markdown; charset=utf-8"
          : "application/zip",
      "Content-Disposition": `attachment; filename="sciretriever-${artifactNames[kind]}"`,
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    throw new DeviceConnectionError("device-artifact-unavailable");
  } finally {
    await file?.close();
  }
}
/** Runs before Web authentication. A token never becomes a Web session/client grant. */
export async function handleDeviceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: DeviceHttpOptions | undefined,
): Promise<boolean> {
  const exchange = url.pathname === "/api/v1/device-connections/exchange";
  const downloadRoute =
    /^\/api\/v1\/device-connections\/(instructions|skill)$/u.test(url.pathname);
  const authorization = request.headers.authorization;
  if (downloadRoute && authorization === undefined) return false;
  if (
    !exchange &&
    !downloadRoute &&
    url.pathname !== "/mcp" &&
    authorization === undefined
  )
    return false;
  try {
    if (!options) throw new DeviceConnectionError("device-unavailable");
    if (url.search) throw new DeviceConnectionError("device-token-in-url");
    if (exchange) {
      if (authorization !== undefined)
        throw new DeviceConnectionError("device-purpose-forbidden");
      if (request.method !== "POST")
        throw new DeviceConnectionError("device-input-invalid");
      let value: unknown;
      try {
        value = await readBody(request);
      } catch {
        value = null;
      }
      // Direct socket identity, never forwarding headers supplied by a client.
      const result = await options.service.exchange(
        value,
        request.socket.remoteAddress ?? "unknown",
      );
      reply(response, 200, { protocol_version: 1, result });
      return true;
    }
    const match = /^Bearer (srd1_[A-Za-z0-9_-]{43})$/u.exec(
      authorization ?? "",
    );
    if (!match) throw new DeviceConnectionError("device-token-invalid");
    const { connection } = await options.service.authenticate(match[1]!);
    const artifact =
      /^\/api\/v1\/device-connections\/(instructions|skill)$/u.exec(
        url.pathname,
      );
    if (artifact && request.method === "GET") {
      await downloadDeviceArtifact(
        response,
        artifact[1] as keyof typeof artifactNames,
        options.artifactDirectory ?? DEVICE_ARTIFACT_DIRECTORY,
      );
      return true;
    }
    const registered = options.routes?.find(request.method, url.pathname);
    if (!registered)
      throw new DeviceConnectionError("device-purpose-forbidden");
    requireDevicePurpose(connection, registered.route.purposes);
    await registered.route.handle(
      request,
      response,
      connection,
      registered.parameters,
    );
  } catch (error) {
    deviceFailure(response, error);
  }
  return true;
}
/** Called only after Web login, client and POST CSRF admission. Not an Entry operation. */
export async function manageDevices(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  options: DeviceHttpOptions | undefined,
): Promise<boolean> {
  const path = url.pathname;
  if (
    !/^\/api\/v1\/device-connections(?:\/(?:pairings|rename|revoke))?$/u.test(
      path,
    )
  )
    return false;
  try {
    if (!options) throw new DeviceConnectionError("device-unavailable");
    let result: unknown;
    if (request.headers["x-sciretriever-protocol-version"] !== "1")
      throw new ContractValidationError();
    if (path === "/api/v1/device-connections" && request.method === "POST") {
      const value = await readBody(request);
      const envelope = deviceRecord(value, ["protocol_version", "request"]);
      if (envelope.protocol_version !== 1) throw new ContractValidationError();
      result = await options.service.list(envelope.request);
    } else {
      if (request.method !== "POST") throw new ContractValidationError();
      const envelope = deviceRecord(await readBody(request), [
        "protocol_version",
        "request",
      ]);
      if (envelope.protocol_version !== 1) throw new ContractValidationError();
      if (path.endsWith("/pairings")) {
        const r = parseDevicePairingRequest(envelope.request);
        if (new URL(r.address).origin !== origin)
          throw new DeviceConnectionError("device-address-mismatch");
        result = await options.service.create(r);
      } else if (path.endsWith("/rename"))
        result = await options.service.rename(envelope.request);
      else if (path.endsWith("/revoke"))
        result = await options.service.revoke(envelope.request);
      else throw new ContractValidationError();
    }
    reply(response, 200, { protocol_version: 1, result });
  } catch (error) {
    deviceFailure(response, error);
  }
  return true;
}
