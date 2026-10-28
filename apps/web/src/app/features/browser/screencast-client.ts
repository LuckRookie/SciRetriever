import {
  decodeScreencastFrame,
  parseScreencastServerMessage,
  SCREENCAST_PROTOCOL,
  type DirectBrowserInput,
  type ScreencastControlState,
  type ScreencastFrame,
  type ScreencastPageKind,
  type ScreencastStatus,
  type SourceProblem,
} from "@sciretriever/contracts";

export interface ScreencastState {
  /** Socket and stream together: what the person sees above the picture. */
  readonly status: ScreencastStatus;
  readonly control: ScreencastControlState;
  readonly agentPaused: boolean;
  readonly pageKind: ScreencastPageKind | null;
  readonly problem: SourceProblem | null;
  /** The first frame has been drawn; until then the canvas is empty. */
  readonly painted: boolean;
}
export class ScreencastInputError extends Error {
  constructor(readonly problem: SourceProblem | null) {
    super("页面没有接受这次操作");
  }
}
interface Pending {
  resolve: (epoch: number) => void;
  reject: (error: Error) => void;
}
const initial: ScreencastState = {
  status: "connecting",
  control: "watching",
  agentPaused: false,
  pageKind: null,
  problem: null,
  painted: false,
};

/**
 * One window's live view of one Browser session (ADR 0042). Frames are drawn only if
 * they still belong to the current subscription and stream epoch, then acknowledged;
 * the server sends the next frame only after that. The first meaningful input carries
 * the document it was aimed at and takes control; later inputs wait for that answer
 * and then flow in order. Nothing is replayed after a reconnect.
 */
export class ScreencastClient {
  private socket: WebSocket | null = null;
  private subscription: string | null = null;
  private streamEpoch = 0;
  private controlEpoch = 0;
  private seq = 0;
  private frame: ScreencastFrame | null = null;
  private takeover: Promise<number> | null = null;
  private readonly pending = new Map<number, Pending>();
  private listeners = new Set<(state: ScreencastState) => void>();
  private value: ScreencastState = initial;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly grant: () => { clientId: string; csrf: string },
    private readonly canvas: () => HTMLCanvasElement | null,
  ) {}

  get state() {
    return this.value;
  }
  /** Size of the last frame in JPEG pixels; input coordinates use the same space. */
  get frameSize() {
    return this.frame
      ? { width: this.frame.width, height: this.frame.height }
      : null;
  }
  subscribe(listener: (state: ScreencastState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(patch: Partial<ScreencastState>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener(this.value);
  }

  connect() {
    if (this.closed || this.socket) return;
    const url = new URL("/api/screencast", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, SCREENCAST_PROTOCOL);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      const { clientId, csrf } = this.grant();
      this.send({
        type: "hello",
        protocol_version: 1,
        client_id: clientId,
        csrf,
      });
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) void this.paint(event.data);
      else this.message(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscription = null;
      this.takeover = null;
      for (const p of this.pending.values())
        p.reject(new Error("连接已断开，这次操作没有确认"));
      this.pending.clear();
      if (this.closed) return;
      // A dropped controller loses control and the Agent stays paused until someone acts.
      this.set({ status: "reconnecting", control: "watching" });
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(5000, 500 * 2 ** this.retry++),
      );
    });
  }
  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
  private message(text: string) {
    const message = parseScreencastServerMessage(JSON.parse(text));
    if (message.type === "ready") {
      this.retry = 0;
      this.send({ type: "subscribe", session_id: this.sessionId });
      return;
    }
    if (message.type === "state") {
      if (message.session_id !== this.sessionId) return;
      this.subscription = message.subscription_id;
      this.streamEpoch = message.stream_epoch;
      this.controlEpoch = message.control_epoch;
      this.set({
        status: message.status,
        control: message.control,
        agentPaused: message.agent_paused,
        pageKind: message.page_kind ?? null,
        problem: message.problem,
      });
      return;
    }
    const pending = this.pending.get(message.seq);
    if (!pending) return;
    this.pending.delete(message.seq);
    if (message.status === "applied") {
      this.controlEpoch = message.control_epoch;
      pending.resolve(message.control_epoch);
    } else pending.reject(new ScreencastInputError(message.problem));
  }
  private async paint(data: ArrayBuffer) {
    const { frame, jpeg } = decodeScreencastFrame(new Uint8Array(data));
    const current = () =>
      frame.subscription_id === this.subscription &&
      frame.stream_epoch >= this.streamEpoch;
    if (!current()) return;
    const bitmap = await createImageBitmap(
      new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
    );
    try {
      // Decoding is asynchronous: a newer stream or subscription may have arrived meanwhile.
      const canvas = this.canvas();
      if (!current() || !canvas) return;
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      this.frame = frame;
      if (!this.value.painted) this.set({ painted: true });
      this.send({
        type: "ack",
        subscription_id: frame.subscription_id,
        stream_epoch: frame.stream_epoch,
        frame_id: frame.frame_id,
      });
    } finally {
      bitmap.close();
    }
  }
  private request(build: (seq: number) => unknown) {
    const seq = ++this.seq;
    return new Promise<number>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.send(build(seq));
    });
  }
  private direct(input: DirectBrowserInput, first: boolean) {
    const frame = this.frame,
      subscription = this.subscription;
    if (!frame || !subscription)
      return Promise.reject(new Error("还没有画面，暂不能操作"));
    return this.request((seq) => ({
      type: "input",
      subscription_id: subscription,
      frame_id: frame.frame_id,
      seq,
      control_epoch: this.controlEpoch,
      ...(first
        ? {
            first: true,
            document: {
              session_id: frame.session_id,
              article_id: frame.article_id,
              page_id: frame.page_id,
              document_generation: frame.document_generation,
              document_id: frame.document_id,
            },
          }
        : { first: false }),
      input,
    }));
  }
  /**
   * Sends one input in order. The first one while watching takes control and pauses
   * the Agent; anything sent before that answer waits for it, so a quick click's
   * release is not judged against the old control epoch.
   */
  input(input: DirectBrowserInput): Promise<number> {
    if (this.takeover)
      return this.takeover.then(() => this.direct(input, false));
    if (this.value.control === "controlling") return this.direct(input, false);
    const takeover = this.direct(input, true).finally(() => {
      if (this.takeover === takeover) this.takeover = null;
    });
    this.takeover = takeover;
    return takeover;
  }
  /** Gives control back; resolves only once the server has re-observed and released. */
  async release() {
    if (this.takeover) await this.takeover.catch(() => undefined);
    const subscription = this.subscription;
    if (!subscription || this.value.control !== "controlling") return;
    this.set({ control: "returning" });
    try {
      await this.request((seq) => ({
        type: "release",
        subscription_id: subscription,
        seq,
        control_epoch: this.controlEpoch,
      }));
    } catch (error) {
      this.set({ control: "controlling" });
      throw error;
    }
  }
  /** Closing the view returns control first; a failed return keeps the view open. */
  async close() {
    await this.release();
    this.dispose();
  }
  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.send({ type: "unsubscribe" });
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
  }
}
