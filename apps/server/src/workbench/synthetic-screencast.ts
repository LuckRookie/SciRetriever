import { createRequire } from "node:module";
// The native canvas takes most of a second to load; only load it once an
// image is drawn, so commands that never draw (most of the CLI) skip it.
let canvasModule: typeof import("@napi-rs/canvas") | undefined;
const nativeCanvas = () =>
  (canvasModule ??= createRequire(import.meta.url)(
    "@napi-rs/canvas",
  ) as typeof import("@napi-rs/canvas"));
import type {
  DirectBrowserInput,
  ScreencastFrame,
} from "@sciretriever/contracts";
import type { BrowserPageHandle } from "../browser/host.js";
import {
  SCREENCAST_PROFILES,
  ScreencastError,
  type BrowserScreencastSource,
  type PageScreencastFrame,
  type PageScreencastObserver,
  type ScreencastProfile,
} from "../browser/screencast.js";
import { WorkbenchSession } from "./session.js";

export type SyntheticScreencastScenario =
  | "running"
  | "controlling"
  | "taken-over"
  | "reconnecting"
  | "no-frame";
/** Explicit test source: no Browser launch, model, network, user page or screenshot fallback. */
export class SyntheticScreencastSource implements BrowserScreencastSource {
  readonly pageId: string;
  documentId = "synthetic-document-1";
  generation = 1;
  starts = 0;
  stops = 0;
  encoded = 0;
  inputs = 0;
  resets = 0;
  private readonly observers = new Set<PageScreencastObserver>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private epoch = 0;
  private status: "live" | "reconnecting" | "no-frame" = "live";
  private profile: ScreencastProfile = SCREENCAST_PROFILES[0]!;
  constructor(
    pageId = "synthetic-page-1",
    private readonly automatic = true,
  ) {
    this.pageId = pageId;
  }
  setStatus(status: "live" | "reconnecting" | "no-frame"): void {
    this.status = status;
    if (status === "live") this.emit();
    else
      for (const observer of this.observers)
        observer.status(
          status,
          status === "no-frame" ? "screencast-page-not-producing" : undefined,
        );
  }
  emit(): PageScreencastFrame | null {
    if (!this.observers.size || this.status !== "live") return null;
    const width = this.profile.width,
      height = Math.round((width * 720) / 1280);
    const canvas = nativeCanvas().createCanvas(width, height),
      context = canvas.getContext("2d");
    context.fillStyle = "#eef3f7";
    context.fillRect(0, 0, width, height);
    context.fillStyle = this.inputs % 2 ? "#257962" : "#325f99";
    context.fillRect(24, 24, width - 48, 130);
    context.fillStyle = "#ffffff";
    context.font = "24px sans-serif";
    context.fillText("Synthetic Browser screencast", 40, 75);
    context.fillText(`Frame ${++this.encoded} · input ${this.inputs}`, 40, 115);
    const frame: PageScreencastFrame = {
      stream_epoch: this.epoch,
      page_id: this.pageId,
      document_id: this.documentId,
      document_generation: this.generation,
      captured_at: new Date().toISOString(),
      width,
      height,
      viewport_width: 1280,
      viewport_height: 720,
      offset_top: 0,
      page_scale_factor: 1,
      device_scale_factor: 1,
      scroll_x: 0,
      scroll_y: 0,
      format: "jpeg",
      quality: this.profile.quality,
      jpeg: new Uint8Array(canvas.toBuffer("image/jpeg", this.profile.quality)),
    };
    for (const observer of this.observers) observer.frame(frame);
    return frame;
  }
  async subscribe(
    observer: PageScreencastObserver,
  ): Promise<() => Promise<void>> {
    if (!this.observers.size) {
      this.starts++;
      this.epoch++;
      if (this.automatic)
        this.timer = setInterval(() => this.emit(), 200).unref();
    }
    this.observers.add(observer);
    observer.status("connecting", undefined, "html", this.epoch);
    if (this.status !== "live")
      observer.status(
        this.status,
        this.status === "no-frame"
          ? "screencast-page-not-producing"
          : undefined,
      );
    else this.emit();
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      this.observers.delete(observer);
      if (!this.observers.size) {
        this.stops++;
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
  async configure(profile: ScreencastProfile): Promise<void> {
    if (
      this.profile.width !== profile.width ||
      this.profile.quality !== profile.quality
    ) {
      this.epoch++;
      for (const observer of this.observers)
        observer.status("connecting", undefined, "html", this.epoch);
      this.profile = profile;
      this.emit();
    }
  }
  async input(
    _input: DirectBrowserInput,
    frame: ScreencastFrame,
    current: () => boolean,
    first: boolean,
  ): Promise<void> {
    if (!current()) throw new ScreencastError("screencast-control-stale");
    if (
      first &&
      (frame.document_id !== this.documentId || frame.page_id !== this.pageId)
    )
      throw new ScreencastError("screencast-document-replaced");
    this.inputs++;
    this.emit();
  }
  async reset(): Promise<void> {
    this.resets++;
  }
  navigate(): void {
    this.documentId = `synthetic-document-${++this.generation}`;
    this.emit();
  }
}
export function createSyntheticScreencastSession(
  options: {
    readonly scenario?: "running" | "reconnecting" | "no-frame";
    readonly automatic?: boolean;
    readonly sessionId?: string;
  } = {},
) {
  const source = new SyntheticScreencastSource(
    "synthetic-page-1",
    options.automatic ?? true,
  );
  const page: BrowserPageHandle = {
    id: source.pageId,
    screencast: source,
    close: async () => {},
    title: async () => "Synthetic screencast",
    url: () => "http://127.0.0.1/synthetic",
    snapshot: async () => ({
      document_generation: source.generation,
      url: "http://127.0.0.1/synthetic",
      title: "Synthetic screencast",
      viewport: { width: 1280, height: 720, device_scale_factor: 1 },
      screenshot: null,
      text: "Synthetic local content",
      elements: [],
    }),
    apply: async () => {},
  };
  const session = new WorkbenchSession(
    "synthetic-article-1",
    page,
    {
      max_actions: 20,
      max_model_calls: 20,
      max_retries: 2,
      max_bytes: 1e6,
      deadline_ms: 600000,
    },
    async () => ({ action: { kind: "stop", reason: "stopped" } }),
    options.sessionId ?? "synthetic-session-1",
  );
  const applyScenario = (
    scenario: SyntheticScreencastScenario,
    viewerId: string,
  ) => {
    if (scenario === "controlling")
      session.takeover(viewerId, session.view().control.epoch);
    if (scenario === "taken-over") {
      const other = session.attach();
      session.takeover(other, session.view().control.epoch);
    }
    source.setStatus(
      scenario === "reconnecting" || scenario === "no-frame"
        ? scenario
        : "live",
    );
  };
  if (options.scenario === "reconnecting" || options.scenario === "no-frame")
    source.setStatus(options.scenario);
  return { session, page, source, applyScenario };
}
