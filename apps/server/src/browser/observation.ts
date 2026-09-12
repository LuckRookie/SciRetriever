import type { BrowserElement } from "./page-runtime.js";
import { createHash } from "node:crypto";
export type BrowserPageState =
  | "NORMAL"
  | "CHALLENGE"
  | "LOGIN_REQUIRED"
  | "MFA_REQUIRED"
  | "NOT_ENTITLED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "FAILED";
export type BrowserCaptureState = "NONE" | "CANDIDATE" | "CAPTURED";

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor: number;
}
export interface BrowserPageSnapshot {
  readonly document_generation?: number;
  readonly text?: string;
  readonly elements?: readonly BrowserElement[];
  readonly loading?: boolean;
  readonly partial?: boolean;
  readonly url: string;
  readonly title: string;
  readonly viewport: BrowserViewport;
  readonly screenshot: Uint8Array | null;
}
export interface BrowserObservation {
  /** Native Host generation, distinct from the legacy observation change counter. */
  readonly document_generation?: number;
  readonly article_id: string;
  readonly page_id: string;
  readonly revision: number;
  readonly document_version: number;
  readonly viewport_version: number;
  readonly url: string;
  readonly title: string;
  readonly viewport: BrowserViewport;
  readonly frame: Uint8Array | null;
  readonly frame_truncated: boolean;
  readonly page_state: BrowserPageState;
  readonly capture_state: BrowserCaptureState;
  readonly text?: string;
  readonly elements?: readonly BrowserElement[];
  readonly loading?: boolean;
  readonly partial?: boolean;
}
export interface BrowserObservationSource {
  snapshot(): Promise<BrowserPageSnapshot>;
}

const MAX_FRAME_BYTES = 2_000_000;
const SECRET_TITLE =
  /(?:api[_ -]?key|access[_ -]?token|authorization|bearer|cookie|password|secret|token|signature)\s*[:=]/iu;

function safeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("browser observation failed");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new Error("browser observation failed");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function pageState(title: string): BrowserPageState {
  const value = title.toLowerCase();
  if (/(?:mfa|two-factor|二次验证)/u.test(value)) return "MFA_REQUIRED";
  if (/(?:login|sign in|登录)/u.test(value)) return "LOGIN_REQUIRED";
  if (/(?:challenge|验证)/u.test(value)) return "CHALLENGE";
  if (/(?:not entitled|subscription required)/u.test(value))
    return "NOT_ENTITLED";
  if (/(?:access denied|forbidden|拒绝访问)/u.test(value))
    return "ACCESS_DENIED";
  if (/(?:not found|page missing|404)/u.test(value)) return "NOT_FOUND";
  return "NORMAL";
}

function boundedFrame(
  value: Uint8Array | null,
): readonly [Uint8Array | null, boolean] {
  if (value === null) return [null, false];
  if (value.byteLength <= MAX_FRAME_BYTES)
    return [new Uint8Array(value), false];
  return [null, true];
}

export class BrowserObservationStore {
  private revision = 0;
  private documentVersion = 0;
  private viewportVersion = 0;
  private lastUrl: string | undefined;
  private lastDocumentGeneration: number | undefined;
  private lastPageId: string | undefined;
  private lastViewport: BrowserViewport | undefined;
  private current: BrowserObservation | undefined;
  private digest: string | undefined;

  async observe(
    articleId: string,
    pageId: string,
    source: BrowserObservationSource,
    captureState: BrowserCaptureState = "NONE",
  ): Promise<BrowserObservation> {
    if (
      !/^[a-zA-Z0-9._:-]{1,128}$/u.test(articleId) ||
      !/^[a-zA-Z0-9._:-]{1,128}$/u.test(pageId)
    )
      throw new Error("browser observation failed");
    const snapshot = await source.snapshot();
    const url = safeUrl(snapshot.url);
    const title =
      snapshot.title.length > 4096 || SECRET_TITLE.test(snapshot.title)
        ? "[redacted]"
        : snapshot.title;
    if (
      !Number.isSafeInteger(snapshot.viewport.width) ||
      !Number.isSafeInteger(snapshot.viewport.height) ||
      snapshot.viewport.width < 1 ||
      snapshot.viewport.height < 1 ||
      !Number.isFinite(snapshot.viewport.device_scale_factor) ||
      snapshot.viewport.device_scale_factor <= 0 ||
      !(
        snapshot.screenshot === null ||
        snapshot.screenshot instanceof Uint8Array
      )
    )
      throw new Error("browser observation failed");
    if (
      url !== this.lastUrl ||
      pageId !== this.lastPageId ||
      snapshot.document_generation !== this.lastDocumentGeneration
    ) {
      this.documentVersion += 1;
      this.lastUrl = url;
      this.lastPageId = pageId;
      this.lastDocumentGeneration = snapshot.document_generation;
    }
    if (
      !this.lastViewport ||
      JSON.stringify(this.lastViewport) !== JSON.stringify(snapshot.viewport)
    ) {
      this.viewportVersion += 1;
      this.lastViewport = Object.freeze({ ...snapshot.viewport });
    }
    const [frame, frameTruncated] = boundedFrame(snapshot.screenshot);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          articleId,
          pageId,
          url,
          title,
          viewport: snapshot.viewport,
          generation: snapshot.document_generation,
          text: snapshot.text ?? "",
          elements: snapshot.elements ?? [],
          loading: snapshot.loading ?? false,
          partial: snapshot.partial ?? false,
          captureState,
          frameTruncated,
        }),
      )
      .update(frame ?? new Uint8Array())
      .digest("hex");
    if (this.current && digest === this.digest) return this.current;
    this.digest = digest;
    this.revision += 1;
    this.current = Object.freeze({
      ...(snapshot.document_generation === undefined
        ? {}
        : { document_generation: snapshot.document_generation }),
      article_id: articleId,
      page_id: pageId,
      revision: this.revision,
      document_version: this.documentVersion,
      viewport_version: this.viewportVersion,
      url,
      title,
      viewport: this.lastViewport,
      frame,
      frame_truncated: frameTruncated,
      page_state: pageState(title),
      capture_state: captureState,
      text: snapshot.text ?? "",
      elements: snapshot.elements ?? [],
      loading: snapshot.loading ?? false,
      partial: snapshot.partial ?? false,
    });
    return this.current;
  }

  currentObservation(): BrowserObservation | undefined {
    return this.current;
  }
}
