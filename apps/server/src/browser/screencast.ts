import type { CDPSession, Page } from "playwright";
import type {
  DirectBrowserInput,
  ScreencastFrame,
  ScreencastPageKind,
} from "@sciretriever/contracts";

export interface ScreencastProfile {
  readonly width: number;
  readonly quality: number;
}
export const SCREENCAST_PROFILES: readonly ScreencastProfile[] = Object.freeze([
  { width: 1280, quality: 60 },
  { width: 960, quality: 60 },
  { width: 960, quality: 40 },
  { width: 640, quality: 40 },
]);
export type PageScreencastFrame = Omit<
  ScreencastFrame,
  | "subscription_id"
  | "frame_id"
  | "session_id"
  | "article_id"
  | "protocol_version"
> & { readonly jpeg: Uint8Array };
export interface PageScreencastObserver {
  frame(frame: PageScreencastFrame): void;
  status(
    status: "connecting" | "no-frame" | "reconnecting" | "closed",
    code?: string,
    pageKind?: ScreencastPageKind,
    streamEpoch?: number,
  ): void;
}
export interface BrowserScreencastSource {
  diagnostics?(): {
    readonly raw_frames: number;
    readonly delivered_frames: number;
    readonly starts: number;
    readonly stops: number;
  };
  subscribe(observer: PageScreencastObserver): Promise<() => Promise<void>>;
  configure(profile: ScreencastProfile): Promise<void>;
  input(
    input: DirectBrowserInput,
    frame: ScreencastFrame,
    current: () => boolean,
    first: boolean,
  ): Promise<void>;
  reset(): Promise<void>;
}
export class ScreencastError extends Error {
  constructor(readonly code: string) {
    super("Browser screencast operation failed");
  }
}
export function jpegDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw new ScreencastError("screencast-frame-invalid");
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 255) break;
    while (bytes[i] === 255) i++;
    const marker = bytes[i++]!;
    if (marker === 217 || marker === 218) break;
    const size = bytes[i]! * 256 + bytes[i + 1]!;
    if (size < 2 || i + size > bytes.length) break;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    )
      return {
        height: bytes[i + 3]! * 256 + bytes[i + 4]!,
        width: bytes[i + 5]! * 256 + bytes[i + 6]!,
      };
    i += size;
  }
  throw new ScreencastError("screencast-frame-invalid");
}
/** A dedicated CDP session on an already owned page; it never changes Network admission. */
export class ChromiumScreencastSource implements BrowserScreencastSource {
  private session: CDPSession | undefined;
  private opening: Promise<CDPSession> | undefined;
  private observers = new Set<PageScreencastObserver>();
  private profile: ScreencastProfile = SCREENCAST_PROFILES[0]!;
  private tail = Promise.resolve();
  private loader = "";
  private pageKind: ScreencastPageKind = "unknown";
  private generation = 0;
  private closed = false;
  private encoding = false;
  private noFrame: ReturnType<typeof setTimeout> | undefined;
  private pressedKeys = new Map<
    string,
    Extract<DirectBrowserInput, { kind: "key" }>
  >();
  private buttons = 0;
  private point = { x: 0, y: 0 };
  private dpr = 1;
  private composing = false;
  private streamEpoch = 0;
  private rawFrames = 0;
  private deliveredFrames = 0;
  private starts = 0;
  private stops = 0;
  diagnostics() {
    return {
      raw_frames: this.rawFrames,
      delivered_frames: this.deliveredFrames,
      starts: this.starts,
      stops: this.stops,
    };
  }
  constructor(
    private readonly page: Page,
    private readonly pageId: string,
    private readonly inputScope: <T>(action: () => Promise<T>) => Promise<T>,
  ) {
    const close = () => {
      this.closed = true;
      clearTimeout(this.noFrame);
      this.encoding = false;
      for (const o of this.observers)
        o.status("closed", "screencast-page-closed", this.pageKind);
      this.observers.clear();
    };
    page.once("close", close);
    page.once("crash", close);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const p = this.tail.then(action);
    this.tail = p.then(
      () => {},
      () => {},
    );
    return p;
  }
  private async connection(): Promise<CDPSession> {
    if (this.closed || this.page.isClosed())
      throw new ScreencastError("screencast-page-closed");
    if (this.session) return this.session;
    this.opening ??= (async () => {
      const cdp = await this.page.context().newCDPSession(this.page);
      cdp.on("Page.frameNavigated", (event) => {
        if (this.session !== cdp) return;
        if (!event.frame.parentId)
          this.document(event.frame.loaderId, event.frame.mimeType);
      });
      cdp.on("Page.screencastFrame", (event) => {
        this.rawFrames++;
        // ACK even a dropped frame: Chromium owns its encoder pressure separately.
        void cdp
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => {
            if (this.session === cdp && this.encoding && !this.closed)
              this.failed("screencast-ack-failed");
          });
        if (
          !this.encoding ||
          this.session !== cdp ||
          !this.observers.size ||
          this.closed ||
          !this.loader
        )
          return;
        try {
          const jpeg = new Uint8Array(Buffer.from(event.data, "base64"));
          if (jpeg.length > 8 * 1024 * 1024)
            throw new ScreencastError("screencast-frame-too-large");
          const dims = jpegDimensions(jpeg),
            m = event.metadata;
          const frame: PageScreencastFrame = {
            ...dims,
            stream_epoch: this.streamEpoch,
            page_id: this.pageId,
            document_generation: this.generation,
            document_id: this.loader,
            captured_at: new Date(
              typeof m.timestamp === "number" ? m.timestamp * 1000 : Date.now(),
            ).toISOString(),
            viewport_width: m.deviceWidth,
            viewport_height: m.deviceHeight,
            offset_top: m.offsetTop,
            page_scale_factor: m.pageScaleFactor,
            device_scale_factor: this.dpr,
            scroll_x: m.scrollOffsetX,
            scroll_y: m.scrollOffsetY,
            format: "jpeg",
            quality: this.profile.quality,
            jpeg,
          };
          clearTimeout(this.noFrame);
          this.deliveredFrames++;
          for (const o of this.observers) o.frame(frame);
        } catch {
          this.failed("screencast-frame-invalid");
        }
      });
      await cdp.send("Page.enable");
      const tree = await cdp.send("Page.getFrameTree");
      this.document(
        tree.frameTree.frame.loaderId,
        tree.frameTree.frame.mimeType,
      );
      this.dpr = await this.page.evaluate(() => devicePixelRatio || 1);
      this.session = cdp;
      return cdp;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  private document(loader: string, mime?: string) {
    this.pageKind =
      mime === "application/pdf"
        ? "pdf"
        : mime?.includes("html")
          ? "html"
          : mime
            ? "other"
            : "unknown";
    if (loader !== this.loader) {
      this.loader = loader;
      this.generation++;
      if (this.encoding) {
        for (const observer of this.observers)
          observer.status("reconnecting", undefined, this.pageKind);
        this.armNoFrame();
      }
    }
  }
  private armNoFrame(): void {
    clearTimeout(this.noFrame);
    this.noFrame = setTimeout(
      () => this.failed("screencast-page-not-producing"),
      3000,
    );
    this.noFrame.unref();
  }
  private failed(code: string) {
    for (const o of this.observers) o.status("no-frame", code, this.pageKind);
  }
  private async start() {
    const cdp = await this.connection();
    if (!this.observers.size) return;
    this.encoding = true;
    this.streamEpoch++;
    for (const o of this.observers)
      o.status("connecting", undefined, this.pageKind, this.streamEpoch);
    try {
      this.armNoFrame();
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.profile.quality,
        maxWidth: this.profile.width,
        maxHeight: 1080,
        everyNthFrame: 1,
      });
      this.starts++;
    } catch {
      clearTimeout(this.noFrame);
      this.encoding = false;
      this.failed("screencast-start-failed");
    }
  }
  private async stopNative(reset: boolean): Promise<void> {
    clearTimeout(this.noFrame);
    this.encoding = false;
    const cdp = this.session;
    if (!cdp || this.closed) return;
    const failures: unknown[] = [];
    if (reset) {
      try {
        await this.reset();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await cdp.send("Page.stopScreencast");
      this.stops++;
    } catch (error) {
      failures.push(error);
    }
    // A compositor capture can already be in flight at the stop reply. The native
    // detach completes its retirement and gives the next static subscription a fresh agent.
    if (this.session === cdp) this.session = undefined;
    try {
      await cdp.detach();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "Screencast native retirement failed");
  }
  async subscribe(
    observer: PageScreencastObserver,
  ): Promise<() => Promise<void>> {
    await this.serial(async () => {
      this.observers.add(observer);
      try {
        if (!this.encoding) await this.start();
      } catch {
        observer.status("no-frame", "screencast-start-failed");
      }
    });
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      await this.serial(async () => {
        this.observers.delete(observer);
        if (!this.observers.size) await this.stopNative(true);
      });
    };
  }
  async configure(profile: ScreencastProfile) {
    if (
      !SCREENCAST_PROFILES.some(
        (p) => p.width === profile.width && p.quality === profile.quality,
      )
    )
      throw new ScreencastError("screencast-profile-invalid");
    await this.serial(async () => {
      if (
        this.profile.width === profile.width &&
        this.profile.quality === profile.quality
      )
        return;
      this.profile = profile;
      if (this.encoding) {
        await this.stopNative(false);
        await this.start();
      }
    });
  }
  async input(
    input: DirectBrowserInput,
    frame: ScreencastFrame,
    current: () => boolean,
    first: boolean,
  ) {
    await this.inputScope(async () => {
      if (!current()) throw new ScreencastError("screencast-control-stale");
      const cdp = await this.connection();
      if (first) {
        const tree = await cdp.send("Page.getFrameTree");
        this.document(
          tree.frameTree.frame.loaderId,
          tree.frameTree.frame.mimeType,
        );
        if (
          frame.page_id !== this.pageId ||
          frame.document_id !== this.loader ||
          frame.document_generation !== this.generation
        )
          throw new ScreencastError("screencast-document-replaced");
      }
      if (!current()) throw new ScreencastError("screencast-control-stale");
      if (input.kind === "text" || input.kind === "paste") {
        await cdp.send("Input.insertText", { text: input.text });
        this.composing = false;
        return;
      }
      if (input.kind === "composition") {
        await cdp.send("Input.imeSetComposition", {
          text: input.text,
          selectionStart: input.selection_start,
          selectionEnd: input.selection_end,
        });
        this.composing = input.text.length > 0;
        return;
      }
      if (input.kind === "key") {
        await cdp.send("Input.dispatchKeyEvent", {
          type: input.action === "down" ? "keyDown" : "keyUp",
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.key_code,
          nativeVirtualKeyCode: input.key_code,
          location: input.location,
          isKeypad: input.location === 3,
          autoRepeat: input.auto_repeat,
          modifiers: input.modifiers,
        });
        if (input.action === "down") this.pressedKeys.set(input.code, input);
        else this.pressedKeys.delete(input.code);
        return;
      }
      const pixelX = Math.max(0, Math.min(frame.width - 1, input.x));
      const pixelY = Math.max(0, Math.min(frame.height - 1, input.y));
      const x =
          (pixelX * frame.viewport_width) /
          frame.width /
          frame.page_scale_factor,
        y =
          ((pixelY * frame.viewport_height) / frame.height - frame.offset_top) /
          frame.page_scale_factor;
      if (x < 0 || y < 0) throw new ScreencastError("screencast-point-outside");
      this.point = { x, y };
      if (input.kind === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: Math.max(-2000, Math.min(2000, input.delta_x)),
          deltaY: Math.max(-2000, Math.min(2000, input.delta_y)),
          modifiers: input.modifiers,
        });
        return;
      }
      const action =
        input.kind === "drag"
          ? input.phase === "start"
            ? "down"
            : input.phase === "end"
              ? "up"
              : "move"
          : input.action;
      this.buttons =
        input.kind === "drag" ? (action === "up" ? 0 : 1) : input.buttons;
      await cdp.send("Input.dispatchMouseEvent", {
        type:
          action === "down"
            ? "mousePressed"
            : action === "up"
              ? "mouseReleased"
              : "mouseMoved",
        x,
        y,
        button: input.kind === "drag" ? "left" : input.button,
        buttons: this.buttons,
        clickCount: input.kind === "drag" ? 1 : input.click_count,
        modifiers: input.modifiers,
      });
    });
  }
  async reset() {
    if (!this.session || this.closed) {
      this.pressedKeys.clear();
      this.buttons = 0;
      return;
    }
    if (!this.pressedKeys.size && !this.buttons && !this.composing) return;
    const cdp = this.session;
    await this.inputScope(async () => {
      for (const key of this.pressedKeys.values())
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.key_code,
        });
      this.pressedKeys.clear();
      for (const [bit, button] of [
        [1, "left"],
        [2, "right"],
        [4, "middle"],
      ] as const)
        if (this.buttons & bit)
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...this.point,
            button,
            buttons: 0,
            clickCount: 1,
          });
      this.buttons = 0;
      if (this.composing) {
        await cdp.send("Input.imeSetComposition", {
          text: "",
          selectionStart: 0,
          selectionEnd: 0,
        });
        this.composing = false;
      }
    });
  }
}
