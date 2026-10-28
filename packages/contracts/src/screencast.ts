import { ContractValidationError, parseUtcTimestamp } from "./index.js";
import {
  parseSourceProblem,
  type SourceProblem,
} from "./source-configuration.js";

export const SCREENCAST_PROTOCOL = "sciretriever.screencast.v1";
export const SCREENCAST_FRAME_MAX_BYTES = 8 * 1024 * 1024;
export const SCREENCAST_MESSAGE_MAX_BYTES = 32 * 1024;
export interface ScreencastDocument {
  readonly session_id: string;
  readonly article_id: string;
  readonly page_id: string;
  readonly document_generation: number;
  readonly document_id: string;
}
export interface ScreencastFrame extends ScreencastDocument {
  readonly protocol_version: 1;
  readonly subscription_id: string;
  readonly frame_id: number;
  readonly stream_epoch: number;
  readonly captured_at: string;
  readonly width: number;
  readonly height: number;
  /** CSS pixels in the visible page, including the content offset inside the frame. */
  readonly viewport_width: number;
  readonly viewport_height: number;
  readonly offset_top: number;
  readonly page_scale_factor: number;
  readonly device_scale_factor: number;
  readonly scroll_x: number;
  readonly scroll_y: number;
  readonly format: "jpeg";
  readonly quality: number;
}
export type DirectBrowserInput =
  | {
      readonly kind: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: "none" | "left" | "middle" | "right";
      readonly buttons: number;
      readonly click_count: number;
      readonly modifiers: number;
    }
  | {
      readonly kind: "drag";
      readonly phase: "start" | "move" | "end";
      readonly x: number;
      readonly y: number;
      readonly modifiers: number;
    }
  | {
      readonly kind: "wheel";
      readonly x: number;
      readonly y: number;
      readonly delta_x: number;
      readonly delta_y: number;
      readonly modifiers: number;
    }
  | {
      readonly kind: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      readonly key_code: number;
      readonly location: number;
      readonly auto_repeat: boolean;
      readonly modifiers: number;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  /** Selection offsets follow DOM/CDP UTF-16 indexing, not archive code-point coordinates. */
  | {
      readonly kind: "composition";
      readonly text: string;
      readonly selection_start: number;
      readonly selection_end: number;
    };
export type ScreencastClientMessage =
  | {
      readonly type: "hello";
      readonly protocol_version: 1;
      readonly client_id: string;
      readonly csrf: string;
    }
  | { readonly type: "subscribe"; readonly session_id: string }
  | { readonly type: "unsubscribe" }
  | {
      readonly type: "ack";
      readonly subscription_id: string;
      readonly frame_id: number;
      readonly stream_epoch: number;
    }
  | ({
      readonly type: "input";
      readonly subscription_id: string;
      readonly frame_id: number;
      readonly seq: number;
      readonly control_epoch: number;
      readonly input: DirectBrowserInput;
    } & (
      | { readonly first: true; readonly document: ScreencastDocument }
      | { readonly first: false }
    ))
  | {
      readonly type: "release";
      readonly subscription_id: string;
      readonly seq: number;
      readonly control_epoch: number;
    };
export type ScreencastControlState =
  | "watching"
  | "controlling"
  | "returning"
  | "taken-over";
export type ScreencastStatus =
  | "connecting"
  | "live"
  | "no-frame"
  | "reconnecting"
  | "closed";
export type ScreencastPageKind = "html" | "pdf" | "other" | "unknown";
export type ScreencastServerMessage =
  | {
      readonly type: "ready";
      readonly protocol_version: 1;
      readonly connection_id: string;
      readonly max_in_flight: 1 | 2;
    }
  | {
      readonly type: "state";
      readonly subscription_id: string;
      readonly session_id: string;
      readonly status: ScreencastStatus;
      readonly stream_epoch: number;
      readonly page_kind?: ScreencastPageKind;
      readonly control: ScreencastControlState;
      readonly control_epoch: number;
      readonly agent_paused: boolean;
      readonly problem: SourceProblem | null;
    }
  | {
      readonly type: "input-result";
      readonly seq: number;
      readonly status: "applied" | "rejected";
      readonly control_epoch: number;
      readonly problem: SourceProblem | null;
    };
function fail(): never {
  throw new ContractValidationError();
}
function record(v: unknown, keys: readonly string[]) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const r = v as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    fail();
  return r;
}
const id = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(v) ? v : fail();
const num = (v: unknown, min = 0, max = 16384) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : fail();
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(num(v, min, max)) ? (v as number) : fail();
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail());
const one = <T extends string>(v: unknown, values: readonly T[]): T =>
  values.includes(v as T) ? (v as T) : fail();
const text = (v: unknown, max = 8192) =>
  typeof v === "string" && v.length <= max && !v.includes("\0") ? v : fail();
export function parseScreencastDocument(v: unknown): ScreencastDocument {
  const r = record(v, [
    "session_id",
    "article_id",
    "page_id",
    "document_generation",
    "document_id",
  ]);
  return Object.freeze({
    session_id: id(r.session_id),
    article_id: id(r.article_id),
    page_id: id(r.page_id),
    document_generation: int(r.document_generation),
    document_id: id(r.document_id),
  });
}
export function parseDirectBrowserInput(v: unknown): DirectBrowserInput {
  if (!v || typeof v !== "object" || !("kind" in v)) fail();
  if (v.kind === "text" || v.kind === "paste") {
    const r = record(v, ["kind", "text"]);
    return Object.freeze({ kind: v.kind, text: text(r.text) });
  }
  if (v.kind === "composition") {
    const r = record(v, ["kind", "text", "selection_start", "selection_end"]),
      value = text(r.text),
      start = int(r.selection_start, 0, value.length),
      end = int(r.selection_end, start, value.length);
    return Object.freeze({
      kind: v.kind,
      text: value,
      selection_start: start,
      selection_end: end,
    });
  }
  if (v.kind === "key") {
    const r = record(v, [
      "kind",
      "action",
      "key",
      "code",
      "key_code",
      "location",
      "auto_repeat",
      "modifiers",
    ]);
    return Object.freeze({
      kind: v.kind,
      action: one(r.action, ["down", "up"]),
      key: text(r.key, 64),
      code: text(r.code, 64),
      key_code: int(r.key_code, 0, 255),
      location: int(r.location, 0, 3),
      auto_repeat: bool(r.auto_repeat),
      modifiers: int(r.modifiers, 0, 15),
    });
  }
  if (v.kind === "mouse") {
    const r = record(v, [
      "kind",
      "action",
      "x",
      "y",
      "button",
      "buttons",
      "click_count",
      "modifiers",
    ]);
    if (r.action !== "move" && r.button === "none") fail();
    const bit =
      r.button === "left"
        ? 1
        : r.button === "right"
          ? 2
          : r.button === "middle"
            ? 4
            : 0;
    const buttons = int(r.buttons, 0, 7);
    if (
      (r.action === "down" && !(buttons & bit)) ||
      (r.action === "up" && buttons & bit)
    )
      fail();
    if (r.action !== "move" && r.click_count === 0) fail();
    return Object.freeze({
      kind: v.kind,
      action: one(r.action, ["move", "down", "up"]),
      x: num(r.x, -16384, 16384),
      y: num(r.y, -16384, 16384),
      button: one(r.button, ["none", "left", "middle", "right"]),
      buttons: int(r.buttons, 0, 7),
      click_count: int(r.click_count, 0, 3),
      modifiers: int(r.modifiers, 0, 15),
    });
  }
  if (v.kind === "drag") {
    const r = record(v, ["kind", "phase", "x", "y", "modifiers"]);
    return Object.freeze({
      kind: v.kind,
      phase: one(r.phase, ["start", "move", "end"]),
      x: num(r.x, -16384, 16384),
      y: num(r.y, -16384, 16384),
      modifiers: int(r.modifiers, 0, 15),
    });
  }
  if (v.kind !== "wheel") fail();
  const r = record(v, ["kind", "x", "y", "delta_x", "delta_y", "modifiers"]);
  return Object.freeze({
    kind: v.kind,
    x: num(r.x, -16384, 16384),
    y: num(r.y, -16384, 16384),
    delta_x: num(r.delta_x, -2000, 2000),
    delta_y: num(r.delta_y, -2000, 2000),
    modifiers: int(r.modifiers, 0, 15),
  });
}
export function parseScreencastClientMessage(
  v: unknown,
): ScreencastClientMessage {
  if (!v || typeof v !== "object" || !("type" in v)) fail();
  switch (v.type) {
    case "hello": {
      const r = record(v, ["type", "protocol_version", "client_id", "csrf"]);
      if (r.protocol_version !== 1) fail();
      return {
        type: v.type,
        protocol_version: 1,
        client_id: id(r.client_id),
        csrf: id(r.csrf),
      };
    }
    case "subscribe":
      return {
        type: v.type,
        session_id: id(record(v, ["type", "session_id"]).session_id),
      };
    case "unsubscribe":
      record(v, ["type"]);
      return { type: v.type };
    case "ack": {
      const r = record(v, [
        "type",
        "subscription_id",
        "frame_id",
        "stream_epoch",
      ]);
      return {
        type: v.type,
        subscription_id: id(r.subscription_id),
        frame_id: int(r.frame_id, 1),
        stream_epoch: int(r.stream_epoch, 1),
      };
    }
    case "release": {
      const r = record(v, ["type", "subscription_id", "seq", "control_epoch"]);
      return {
        type: v.type,
        subscription_id: id(r.subscription_id),
        seq: int(r.seq, 1),
        control_epoch: int(r.control_epoch),
      };
    }
    case "input": {
      const shape = v as Record<string, unknown>,
        first = bool(shape.first),
        r = record(v, [
          "type",
          "subscription_id",
          "frame_id",
          "seq",
          "control_epoch",
          "input",
          "first",
          ...(first ? ["document"] : []),
        ]);
      const base = {
        type: "input" as const,
        subscription_id: id(r.subscription_id),
        frame_id: int(r.frame_id, 1),
        seq: int(r.seq, 1),
        control_epoch: int(r.control_epoch),
        input: parseDirectBrowserInput(r.input),
      };
      if (
        first &&
        ((base.input.kind === "mouse" && base.input.action !== "down") ||
          (base.input.kind === "key" && base.input.action !== "down") ||
          (base.input.kind === "drag" && base.input.phase !== "start"))
      )
        fail();
      return first
        ? {
            ...base,
            first: true,
            document: parseScreencastDocument(r.document),
          }
        : { ...base, first: false };
    }
    default:
      fail();
  }
}
export function parseScreencastServerMessage(
  v: unknown,
): ScreencastServerMessage {
  if (!v || typeof v !== "object" || !("type" in v)) fail();
  if (v.type === "ready") {
    const r = record(v, [
      "type",
      "protocol_version",
      "connection_id",
      "max_in_flight",
    ]);
    if (
      r.protocol_version !== 1 ||
      (r.max_in_flight !== 1 && r.max_in_flight !== 2)
    )
      fail();
    return {
      type: v.type,
      protocol_version: 1,
      connection_id: id(r.connection_id),
      max_in_flight: r.max_in_flight as 1 | 2,
    };
  }
  if (v.type === "state") {
    const r = record(v, [
      "type",
      "subscription_id",
      "session_id",
      "status",
      "stream_epoch",
      "control",
      "control_epoch",
      "agent_paused",
      "problem",
      ...(Object.hasOwn(v, "page_kind") ? ["page_kind"] : []),
    ]);
    return {
      ...(Object.hasOwn(r, "page_kind")
        ? {
            page_kind: one(r.page_kind, [
              "html",
              "pdf",
              "other",
              "unknown",
            ] as const),
          }
        : {}),
      type: v.type,
      subscription_id: id(r.subscription_id),
      session_id: id(r.session_id),
      stream_epoch: int(r.stream_epoch),
      status: one(r.status, [
        "connecting",
        "live",
        "no-frame",
        "reconnecting",
        "closed",
      ]),
      control: one(r.control, [
        "watching",
        "controlling",
        "returning",
        "taken-over",
      ]),
      control_epoch: int(r.control_epoch),
      agent_paused: bool(r.agent_paused),
      problem: r.problem === null ? null : parseSourceProblem(r.problem),
    };
  }
  if (v.type !== "input-result") fail();
  const r = record(v, ["type", "seq", "status", "control_epoch", "problem"]),
    status = one(r.status, ["applied", "rejected"]);
  if ((status === "applied") !== (r.problem === null)) fail();
  return {
    type: v.type,
    seq: int(r.seq, 1),
    status,
    control_epoch: int(r.control_epoch),
    problem: r.problem === null ? null : parseSourceProblem(r.problem),
  };
}
const frameKeys = [
  "protocol_version",
  "subscription_id",
  "frame_id",
  "stream_epoch",
  "captured_at",
  "session_id",
  "article_id",
  "page_id",
  "document_generation",
  "document_id",
  "width",
  "height",
  "viewport_width",
  "viewport_height",
  "offset_top",
  "page_scale_factor",
  "device_scale_factor",
  "scroll_x",
  "scroll_y",
  "format",
  "quality",
];
export function parseScreencastFrame(v: unknown): ScreencastFrame {
  const r = record(v, frameKeys);
  if (r.protocol_version !== 1 || r.format !== "jpeg") fail();
  return Object.freeze({
    ...parseScreencastDocument({
      session_id: r.session_id,
      article_id: r.article_id,
      page_id: r.page_id,
      document_generation: r.document_generation,
      document_id: r.document_id,
    }),
    protocol_version: 1,
    subscription_id: id(r.subscription_id),
    frame_id: int(r.frame_id, 1),
    stream_epoch: int(r.stream_epoch, 1),
    captured_at: parseUtcTimestamp(r.captured_at),
    width: int(r.width, 1, 4096),
    height: int(r.height, 1, 4096),
    viewport_width: num(r.viewport_width, 1),
    viewport_height: num(r.viewport_height, 1),
    offset_top: num(r.offset_top),
    page_scale_factor: num(r.page_scale_factor, 0.05, 16),
    device_scale_factor: num(r.device_scale_factor, 0.25, 8),
    scroll_x: num(r.scroll_x, -1e8, 1e8),
    scroll_y: num(r.scroll_y, -1e8, 1e8),
    format: "jpeg",
    quality: int(r.quality, 1, 100),
  });
}
/** 16-byte prefix: SCR1, uint32 header bytes, uint32 JPEG bytes, uint32 reserved=0; all big-endian. */
export function encodeScreencastFrame(
  value: ScreencastFrame,
  jpeg: Uint8Array,
): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify(parseScreencastFrame(value)),
  );
  if (
    header.length > 4096 ||
    jpeg.length < 4 ||
    jpeg.length + header.length + 16 > SCREENCAST_FRAME_MAX_BYTES ||
    jpeg[0] !== 255 ||
    jpeg[1] !== 216 ||
    jpeg.at(-2) !== 255 ||
    jpeg.at(-1) !== 217
  )
    fail();
  const out = new Uint8Array(16 + header.length + jpeg.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x53435231);
  view.setUint32(4, header.length);
  view.setUint32(8, jpeg.length);
  out.set(header, 16);
  out.set(jpeg, 16 + header.length);
  return out;
}
export function decodeScreencastFrame(packet: Uint8Array): {
  frame: ScreencastFrame;
  jpeg: Uint8Array;
} {
  if (packet.length < 20 || packet.length > SCREENCAST_FRAME_MAX_BYTES) fail();
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength),
    h = v.getUint32(4),
    n = v.getUint32(8);
  if (
    v.getUint32(0) !== 0x53435231 ||
    v.getUint32(12) !== 0 ||
    h > 4096 ||
    n < 4 ||
    16 + h + n !== packet.length
  )
    fail();
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        packet.subarray(16, 16 + h),
      ),
    );
  } catch {
    fail();
  }
  const jpeg = packet.subarray(16 + h);
  if (
    jpeg[0] !== 255 ||
    jpeg[1] !== 216 ||
    jpeg.at(-2) !== 255 ||
    jpeg.at(-1) !== 217
  )
    fail();
  return { frame: parseScreencastFrame(decoded), jpeg };
}
