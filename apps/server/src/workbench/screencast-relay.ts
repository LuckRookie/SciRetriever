import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import {
  encodeScreencastFrame,
  parseScreencastClientMessage,
  parseStrictJsonValue,
  SCREENCAST_MESSAGE_MAX_BYTES,
  SCREENCAST_PROTOCOL,
  type ScreencastFrame,
  type ScreencastServerMessage,
} from "@sciretriever/contracts";
import { WebSocket, WebSocketServer } from "ws";
import {
  SCREENCAST_PROFILES,
  ScreencastError,
  type PageScreencastFrame,
} from "../browser/screencast.js";
import { sourceProblem } from "../providers/shared/source-problem.js";
import type { WorkbenchSession } from "./session.js";

/** Per-viewer pump: N sent frames plus one replacement slot, no acknowledged JPEGs.
 * The session separately retains one current page JPEG to bootstrap late viewers.
 */
export class ScreencastFramePump {
  private pending: { frame: ScreencastFrame; jpeg: Uint8Array } | undefined;
  private readonly flights = new Map<number, { sent: number; bytes: number }>();
  private readonly history = new Map<
    number,
    { frame: ScreencastFrame; sent: number }
  >();
  private sequence = 0;
  private latestSent = 0;
  private epoch = 0;
  private drops = 0;
  constructor(
    private readonly subscription: string,
    private readonly sessionId: string,
    private readonly articleId: string,
    private readonly limit: 1 | 2,
    private readonly send: (bytes: Uint8Array) => void,
    private readonly onAck: (bytes: number, elapsed: number) => void = () =>
      undefined,
    private readonly now: () => number = Date.now,
  ) {}
  advance(epoch: number): void {
    if (epoch <= this.epoch) return;
    if (this.pending) this.drops++;
    this.pending = undefined;
    this.flights.clear();
    // An already-seen frame remains valid coordinate evidence on the same document.
    // Only image/ACK scheduling changes generation; this is not a control revision.
    this.epoch = epoch;
  }
  offer(source: PageScreencastFrame): void {
    if (source.stream_epoch < this.epoch) {
      this.drops++;
      return;
    }
    this.advance(source.stream_epoch);
    const { jpeg, ...facts } = source;
    const frame: ScreencastFrame = {
      ...facts,
      protocol_version: 1,
      subscription_id: this.subscription,
      session_id: this.sessionId,
      article_id: this.articleId,
      frame_id: ++this.sequence,
    };
    if (this.pending) this.drops++;
    this.pending = { frame, jpeg };
    this.drain();
  }
  private drain(): void {
    if (!this.pending || this.flights.size >= this.limit) return;
    const { frame, jpeg } = this.pending;
    this.pending = undefined;
    const bytes = encodeScreencastFrame(frame, jpeg),
      sent = this.now();
    this.flights.set(frame.frame_id, { sent, bytes: bytes.byteLength });
    this.history.set(frame.frame_id, { frame, sent });
    this.latestSent = frame.frame_id;
    for (const [id, entry] of this.history) {
      if (
        id !== this.latestSent &&
        (this.history.size > 128 || sent - entry.sent > 15000)
      )
        this.history.delete(id);
      else break;
    }
    this.send(bytes);
  }
  ack(id: number, epoch = this.epoch): void {
    if (epoch !== this.epoch) return;
    const flight = this.flights.get(id);
    if (!flight) return;
    this.flights.delete(id);
    this.onAck(flight.bytes, Math.max(1, this.now() - flight.sent));
    this.drain();
  }
  frame(id: number): ScreencastFrame | undefined {
    const value = this.history.get(id);
    return value && (id === this.latestSent || this.now() - value.sent <= 15000)
      ? value.frame
      : undefined;
  }
  stalled(): boolean {
    return [...this.flights.values()].some((f) => this.now() - f.sent > 15000);
  }
  stats() {
    return {
      in_flight: this.flights.size,
      pending: this.pending ? 1 : 0,
      dropped: this.drops,
      metadata: this.history.size,
    };
  }
  clear(): void {
    this.pending = undefined;
    this.flights.clear();
    this.history.clear();
  }
}

/** ACKs measure the entire receive/decode/draw path, only after enough changing frames. */
export class ScreencastBandwidthController {
  private rank = 0;
  private samples: number[] = [];
  private bytes = 0;
  private start: number;
  private adjusted = 0;
  constructor(private readonly now: () => number = Date.now) {
    this.start = now();
  }
  ack(bytes: number, elapsed: number): number | null {
    this.samples.push(elapsed);
    this.bytes += bytes;
    const now = this.now(),
      interval = now - this.start;
    if (this.samples.length < 8 || interval < 2000) return null;
    const latency = [...this.samples].sort((a, b) => a - b)[
      Math.floor(this.samples.length / 2)
    ]!;
    const averageFrame = this.bytes / this.samples.length,
      throughput = this.bytes / Math.max(1, interval);
    const next =
      latency > 180 && throughput < (averageFrame * 15) / 1000
        ? Math.min(this.rank + 1, SCREENCAST_PROFILES.length - 1)
        : latency < 80 && now - this.adjusted > 15000
          ? Math.max(0, this.rank - 1)
          : this.rank;
    this.samples = [];
    this.bytes = 0;
    this.start = now;
    if (next === this.rank) return null;
    this.rank = next;
    this.adjusted = now;
    return next;
  }
}

export interface ScreencastRelayOptions {
  readonly server: Server;
  readonly maxInFlight?: 1 | 2;
  /** Performs strict same-Origin and existing login-cookie authentication before upgrade. */
  readonly authenticate: (request: IncomingMessage) => string | null;
  readonly grant: (
    clientId: string,
    csrf: string,
    authSession: string,
  ) => boolean;
  readonly valid: (clientId: string, authSession: string) => boolean;
  readonly session: (clientId: string, sessionId: string) => WorkbenchSession;
}
/** Images and input stay on this authenticated, non-durable transport. Never log message data. */
export class ScreencastRelay {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: SCREENCAST_MESSAGE_MAX_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(SCREENCAST_PROTOCOL) ? SCREENCAST_PROTOCOL : false,
  });
  private readonly connections = new Map<string, WebSocket>();
  private readonly sockets = new Set<WebSocket>();
  private readonly cleanups = new Map<WebSocket, () => Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly options: ScreencastRelayOptions) {
    options.server.on("upgrade", this.upgrade);
    this.timer = setInterval(() => {
      for (const ws of this.sockets) ws.ping();
    }, 10000).unref();
  }
  private readonly upgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const auth = this.options.authenticate(request);
    if (
      this.closed ||
      this.sockets.size >= 16 ||
      !auth ||
      request.url !== "/api/screencast" ||
      request.headers["sec-websocket-protocol"] !== SCREENCAST_PROTOCOL
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) =>
      this.connected(ws, auth),
    );
  };
  private connected(ws: WebSocket, authSession: string): void {
    this.sockets.add(ws);
    let clientId = "",
      subscription = "",
      bound: WorkbenchSession | undefined,
      pump: ScreencastFramePump | undefined;
    let stop: (() => Promise<void>) | undefined,
      seq = 0,
      queued = 0,
      ending = false,
      alive = true;
    let cleanupPromise: Promise<void> | undefined;
    let tail = Promise.resolve(),
      lastState = "",
      bandwidth = new ScreencastBandwidthController();
    const maxInFlight = this.options.maxInFlight ?? 1;
    const send = (message: ScreencastServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        const data = JSON.stringify(message);
        if (message.type === "state") {
          if (data === lastState) return;
          lastState = data;
        }
        ws.send(data);
      }
    };
    const unsubscribe = async () => {
      const old = bound,
        oldStop = stop;
      bound = undefined;
      stop = undefined;
      pump?.clear();
      pump = undefined;
      subscription = "";
      try {
        await oldStop?.();
      } finally {
        if (old && clientId) await old.disconnectScreencast(clientId);
      }
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      ending = true;
      cleanupPromise = (async () => {
        clearTimeout(helloTimer);
        clearInterval(heartbeat);
        try {
          await tail;
          await unsubscribe();
        } finally {
          if (this.connections.get(clientId) === ws)
            this.connections.delete(clientId);
          this.sockets.delete(ws);
          this.cleanups.delete(ws);
        }
      })();
      return cleanupPromise;
    };
    this.cleanups.set(ws, cleanup);
    const reject = () => ws.close(1008, "Screencast request rejected");
    const helloTimer = setTimeout(reject, 5000).unref();
    const heartbeat = setInterval(() => {
      if (
        !alive ||
        (clientId &&
          (!this.options.valid(clientId, authSession) || pump?.stalled()))
      ) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 15000).unref();
    ws.on("pong", () => {
      alive = true;
    });
    const reportFailure = (id: number, error: unknown) => {
      const code =
        error instanceof ScreencastError
          ? error.code
          : "screencast-input-rejected";
      send({
        type: "input-result",
        seq: id,
        status: "rejected",
        control_epoch: bound?.screencastState(clientId).control_epoch ?? 0,
        problem: sourceProblem(code, "runtime"),
      });
    };
    const adapt = (bytes: number, elapsed: number) => {
      const next = bandwidth.ack(bytes, elapsed);
      if (next === null || !bound) return;
      void bound
        .configureScreencast(clientId, SCREENCAST_PROFILES[next]!)
        .catch(() => {
          ws.close(1011, "Screencast source unavailable");
        });
    };
    ws.on("message", (data, binary) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (ending || binary || raw.byteLength > SCREENCAST_MESSAGE_MAX_BYTES) {
        reject();
        return;
      }
      let message;
      try {
        message = parseScreencastClientMessage(parseStrictJsonValue(raw));
      } catch {
        reject();
        return;
      }
      if (!clientId) {
        if (
          message.type !== "hello" ||
          !this.options.grant(message.client_id, message.csrf, authSession)
        ) {
          reject();
          return;
        }
        clientId = message.client_id;
        clearTimeout(helloTimer);
        const prior = this.connections.get(clientId);
        // Replace only after prior input/cleanup has drained, so an old close cannot revoke the new lease.
        this.connections.set(clientId, ws);
        if (prior && prior !== ws) {
          prior.close(1000, "Reconnected");
          tail = this.cleanups.get(prior)?.() ?? Promise.resolve();
        }
        send({
          type: "ready",
          protocol_version: 1,
          connection_id: randomUUID(),
          max_in_flight: maxInFlight,
        });
        return;
      }
      if (
        !this.options.valid(clientId, authSession) ||
        message.type === "hello"
      ) {
        reject();
        return;
      }
      if (message.type === "ack") {
        if (message.subscription_id === subscription)
          pump?.ack(message.frame_id, message.stream_epoch);
        return;
      }
      if (++queued > 128) {
        reject();
        return;
      }
      const command = message;
      tail = tail
        .then(async () => {
          if (ending) return;
          if (command.type === "unsubscribe") {
            await unsubscribe();
            return;
          }
          if (command.type === "subscribe") {
            await unsubscribe();
            if (ending) return;
            bound = this.options.session(clientId, command.session_id);
            const target = bound;
            subscription = randomUUID();
            lastState = "";
            bandwidth = new ScreencastBandwidthController();
            pump = new ScreencastFramePump(
              subscription,
              target.id,
              target.articleId,
              maxInFlight,
              (bytes) => {
                if (
                  ws.readyState === WebSocket.OPEN &&
                  this.options.valid(clientId, authSession)
                )
                  ws.send(bytes, { binary: true }, (error) => {
                    if (error) ws.terminate();
                  });
              },
              adapt,
            );
            stop = await target.subscribeScreencast(clientId, {
              frame: (frame) => {
                if (bound === target && !ending) pump?.offer(frame);
              },
              state: (state) => {
                if (bound !== target || ending) return;
                pump?.advance(state.stream_epoch);
                const { code, ...facts } = state;
                send({
                  type: "state",
                  subscription_id: subscription,
                  session_id: target.id,
                  ...facts,
                  problem: code ? sourceProblem(code, "runtime") : null,
                });
              },
            });
            return;
          }
          if (
            command.seq <= seq ||
            command.subscription_id !== subscription ||
            !bound
          ) {
            reportFailure(
              command.seq,
              new ScreencastError("screencast-sequence-stale"),
            );
            return;
          }
          seq = command.seq;
          try {
            if (command.type === "release")
              await bound.releaseDirect(clientId, command.control_epoch);
            else {
              const frame = pump?.frame(command.frame_id);
              if (!frame) throw new ScreencastError("screencast-frame-expired");
              if (
                command.first &&
                (command.document.session_id !== frame.session_id ||
                  command.document.article_id !== frame.article_id ||
                  command.document.page_id !== frame.page_id ||
                  command.document.document_id !== frame.document_id ||
                  command.document.document_generation !==
                    frame.document_generation)
              )
                throw new ScreencastError("screencast-document-mismatch");
              await bound.directInput(
                clientId,
                command.control_epoch,
                frame,
                command.input,
                command.first,
              );
            }
            send({
              type: "input-result",
              seq: command.seq,
              status: "applied",
              control_epoch: bound.screencastState(clientId).control_epoch,
              problem: null,
            });
          } catch (error) {
            reportFailure(command.seq, error);
          }
        })
        .catch(() => {
          ws.close(1011, "Screencast subscription unavailable");
        })
        .finally(() => {
          queued--;
        });
    });
    ws.on("close", () => {
      void cleanup().catch(() => {
        ws.terminate();
      });
    });
    ws.on("error", () => {
      ws.terminate();
    });
  }
  revoke(clientId: string): void {
    this.connections.get(clientId)?.terminate();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.options.server.off("upgrade", this.upgrade);
    for (const ws of this.sockets) ws.terminate();
    const results = await Promise.allSettled(
      [...this.cleanups.values()].map((cleanup) => cleanup()),
    );
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Screencast cleanup failed",
      );
  }
}
