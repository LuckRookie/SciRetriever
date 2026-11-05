import { createServer, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";

/** Loopback CONNECT peer. Never resolves or contacts the requested public name. */
export async function connectProxyFixture(
  options: {
    readonly status?: number;
    readonly hang?: boolean;
    readonly targetPort?: number;
  } = {},
) {
  const connections: {
    authority: string;
    authorization: string | undefined;
  }[] = [];
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = createServer();
  server.on("connection", track);
  server.on("connect", (request: IncomingMessage, raw, head) => {
    const client = raw as Socket;
    connections.push({
      authority: request.url ?? "",
      authorization: request.headers["proxy-authorization"],
    });
    if (options.hang) return;
    const status = options.status ?? 200;
    if (status < 200 || status >= 300) {
      client.end(`HTTP/1.1 ${status} Fixture\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (options.targetPort) {
      const target = track(
        createConnection({ host: "127.0.0.1", port: options.targetPort }),
      );
      target.once("connect", () => {
        client.write(`HTTP/1.1 ${status} Fixture\r\n\r\n`);
        if (head.length) target.write(head);
        client.pipe(target);
        target.pipe(client);
      });
      client.once("close", () => target.destroy());
      target.once("close", () => client.destroy());
    } else client.write(`HTTP/1.1 ${status} Fixture\r\n\r\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture listen failed");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
