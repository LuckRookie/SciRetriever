import {
  createConnection,
  isIP,
  type Socket,
  type NetConnectOpts,
} from "node:net";
import { normalizeNetworkProxy } from "@sciretriever/contracts";
import { ProxyUnavailableError, type OutboundEgress } from "./egress.js";

/** CONNECT is the only proxy protocol. Target admission happens before this call. */
export async function connectProxyTunnel(
  proxy: NonNullable<OutboundEgress["proxy"]>,
  hostname: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
  connector: (options: NetConnectOpts) => Socket = createConnection,
): Promise<Socket> {
  let url: URL;
  try {
    url = new URL(normalizeNetworkProxy(proxy.origin));
  } catch {
    throw new ProxyUnavailableError();
  }
  if (signal?.aborted) throw new ProxyUnavailableError();
  return new Promise<Socket>((resolve, reject) => {
    let socket: Socket | undefined,
      buffer = Buffer.alloc(0),
      settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      socket?.removeListener("error", fail);
      socket?.removeListener("close", fail);
      socket?.removeListener("data", data);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
      reject(new ProxyUnavailableError());
    };
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if ((end < 0 && buffer.length > 16384) || end > 16384) return fail();
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString("latin1"),
        lines = header.split("\r\n");
      const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/u.exec(
        lines[0] ?? "",
      );
      if (
        !status ||
        Number(status[1]) < 200 ||
        Number(status[1]) >= 300 ||
        lines
          .slice(1)
          .some(
            (line) =>
              !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+:[\t\x20-\x7e\x80-\xff]*$/u.test(
                line,
              ),
          )
      )
        return fail();
      settled = true;
      socket!.pause();
      cleanup();
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket!.unshift(rest);
      resolve(socket!);
    };
    const timer = setTimeout(fail, timeoutMs);
    signal?.addEventListener("abort", fail, { once: true });
    try {
      socket = connector({
        host: url.hostname.replace(/^\[|\]$/gu, ""),
        port: Number(url.port || 80),
      });
      socket.on("error", () => undefined);
      socket.once("error", fail);
      socket.once("close", fail);
      socket.on("data", data);
      socket.once("connect", () => {
        void (async () => {
          const pair = await proxy.authorization?.();
          if (settled || signal?.aborted) return;
          if (
            pair !== undefined &&
            pair !== null &&
            (!pair.includes(":") || /[\p{Cc}\p{Cf}]/u.test(pair))
          )
            return fail();
          const authority = `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
          const authentication = pair
            ? `Proxy-Authorization: Basic ${Buffer.from(pair).toString("base64")}\r\n`
            : "";
          socket!.write(
            `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authentication}\r\n`,
          );
        })().catch(fail);
      });
    } catch {
      fail();
    }
  });
}
