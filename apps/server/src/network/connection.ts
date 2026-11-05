import { connectProxyTunnel } from "./proxy-tunnel.js";
import {
  networkEgressSelected,
  ProxyUnavailableError,
  type OutboundEgress,
} from "./egress.js";
import {
  createConnection,
  isIP,
  type NetConnectOpts,
  type Socket,
} from "node:net";
import {
  checkServerIdentity,
  connect as tlsConnect,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";

import {
  assertResolvedDestination,
  NetworkPolicyError,
  type ResolvedDestination,
} from "./policy.js";

export class NetworkConnectionError extends Error {
  readonly code = "network-connection" as const;
  constructor() {
    super("network connection operation failed");
    this.name = "NetworkConnectionError";
  }
}

export interface VerifiedConnection {
  readonly socket: Socket | TLSSocket;
  readonly address: string;
  readonly servername: string | null;
}
export interface ConnectionDependencies {
  readonly connect?: (options: NetConnectOpts) => Socket;
  readonly tlsConnect?: (options: ConnectionOptions) => TLSSocket;
}

function waitFor(
  socket: Socket | TLSSocket,
  event: "connect" | "secureConnect",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener(event, success);
      socket.removeListener("error", fail);
      socket.removeListener("close", fail);
      signal?.removeEventListener("abort", fail);
    };
    const success = (): void => {
      cleanup();
      resolve();
    };
    const fail = (): void => {
      cleanup();
      reject(new NetworkConnectionError());
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.once(event, success);
    socket.once("error", fail);
    socket.once("close", fail);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) fail();
  });
}

export async function connectVerified(
  destination: ResolvedDestination,
  address: string,
  timeoutMs = 10_000,
  dependencies: ConnectionDependencies = {},
  signal?: AbortSignal,
  egress?: OutboundEgress,
): Promise<VerifiedConnection> {
  assertResolvedDestination(destination);
  if (
    !destination.addresses.includes(address) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    throw new NetworkPolicyError();
  let socket: Socket | undefined;
  let secure: TLSSocket | undefined;
  const started = performance.now();
  try {
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new NetworkConnectionError();
    if (signal?.aborted) throw new NetworkConnectionError();
    const connector = dependencies.connect ?? createConnection;
    const viaProxy =
      egress?.mode === "proxy" &&
      destination.classes.every((c) => c === "public");
    networkEgressSelected(viaProxy ? "proxy" : "direct");
    if (viaProxy) {
      if (!egress.proxy) throw new ProxyUnavailableError();
      socket = await connectProxyTunnel(
        egress.proxy,
        destination.url.hostname,
        destination.url.port,
        timeoutMs,
        signal,
        connector,
      );
    } else socket = connector({ host: address, port: destination.url.port });
    // Retain a fixed error handler during ownership transfer to the HTTP consumer.
    socket.on("error", () => undefined);
    if (!viaProxy) await waitFor(socket, "connect", timeoutMs, signal);
    if (destination.url.scheme === "http") {
      if (viaProxy) socket.resume();
      return { socket, address, servername: null };
    }
    const remaining = Math.ceil(timeoutMs - (performance.now() - started));
    if (remaining < 1 || signal?.aborted) throw new NetworkConnectionError();
    const connectorTls = dependencies.tlsConnect ?? tlsConnect;
    secure = connectorTls({
      socket,
      ...(isIP(destination.url.hostname)
        ? {}
        : { servername: destination.url.hostname }),
      rejectUnauthorized: true,
    });
    secure.on("error", () => undefined);
    await waitFor(secure, "secureConnect", remaining, signal);
    if (
      !secure.authorized ||
      checkServerIdentity(destination.url.hostname, secure.getPeerCertificate())
    )
      throw new NetworkConnectionError();
    return { socket: secure, address, servername: destination.url.hostname };
  } catch (error) {
    secure?.destroy();
    socket?.destroy();
    if (error instanceof ProxyUnavailableError) throw error;
    throw new NetworkConnectionError();
  }
}
