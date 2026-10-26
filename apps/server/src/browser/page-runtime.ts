import { waitForBrowserAgentCooldown } from "./pacing.js";
import { HumanizedBrowserInput } from "./human-input.js";
import {
  parseOperatorInput,
  type OperatorInput,
} from "@sciretriever/contracts";
import type { ElementHandle, Frame, Page } from "playwright";
import type { BrowserPageSnapshot } from "./observation.js";

export interface BrowserElement {
  readonly element_id: string;
  readonly role: string;
  readonly name: string;
  readonly editable: boolean;
}
export interface BrowserPageApplyResult {
  /** Actual CSS-pixel click target, captured from the executing runtime. */
  readonly point?: { readonly x: number; readonly y: number };
  readonly label?: string;
  /** The click landed on a visible PDF/download surface. */
  readonly likely_pdf?: boolean;
  readonly no_history?: boolean;
  readonly feedback?: string;
  /** A completed wait is not itself evidence that the page made progress. */
  readonly wait_outcome?: "changed" | "timeout";
  readonly wait_elapsed_ms?: number;
}
export class BrowserPageRuntimeError extends Error {
  readonly code: string = "browser-page-runtime";
  constructor() {
    super("browser page operation failed");
  }
}
export class BrowserPageNavigationError extends BrowserPageRuntimeError {
  override readonly code = "browser-navigation-failed";
}
export class BrowserPageClosedError extends BrowserPageRuntimeError {
  override readonly code = "browser-page-closed";
  constructor() {
    super();
    this.name = "BrowserPageClosedError";
  }
}
export class BrowserPageCrashedError extends BrowserPageRuntimeError {
  override readonly code = "browser-page-crashed";
  constructor() {
    super();
    this.name = "BrowserPageCrashedError";
  }
}
/** A real server throttle is distinct from a challenge or missing PDF. */
export class BrowserPageRateLimitError extends BrowserPageRuntimeError {
  override readonly code = "browser-rate-limited";
}
/** The action was prepared for an older document and was rejected before I/O. */
export class BrowserPageStaleActionError extends BrowserPageRuntimeError {
  override readonly code = "browser-page-stale-action" as const;
  constructor() {
    super();
    this.name = "BrowserPageStaleActionError";
  }
}
/** A previously observed control is no longer actionable; no input was sent. */
export class BrowserElementUnavailableError extends BrowserPageRuntimeError {
  override readonly code = "browser-element-unavailable";
  constructor(
    readonly reason:
      | "element-missing"
      | "element-detached"
      | "element-not-visible"
      | "element-outside-viewport",
  ) {
    super();
    this.name = "BrowserElementUnavailableError";
  }
}
/** A document changed while a snapshot was settling; the caller should re-observe. */
export class BrowserPageTransitionError extends BrowserPageRuntimeError {
  override readonly code = "browser-page-transition" as const;
  constructor() {
    super();
    this.name = "BrowserPageTransitionError";
  }
}
const sensitive =
  /(?:api[_ -]?key|access[_ -]?token|authorization|bearer|cookie|password|secret|token|signature)\s*[:=]/iu;
function redact(value: string, max: number): string {
  return sensitive.test(value) ? "[redacted]" : value.slice(0, max);
}

/** Playwright objects and server-issued element references stay inside Browser. */
export class BrowserPageRuntime {
  private generation = 0;
  private crashed = false;
  private observedFeedback: string | null = null;
  private rateLimited = false;
  private navigationStatus: number | undefined;
  private retryAt: number | null = null;
  private rateLimitRetried = false;
  private revision = 0;
  private structure = "";
  private readonly elementIndices = new Map<number, string>();
  private readonly elements = new Map<string, ElementHandle>();
  private readonly human: HumanizedBrowserInput | undefined;
  private viewport: { width: number; height: number } | undefined;
  constructor(
    private readonly page: Page,
    humanized = false,
    private readonly beforeDownload?: (url: string) => Promise<void>,
    private readonly coordinateInput?: <T>(
      operation: () => Promise<T>,
    ) => Promise<T>,
    private readonly networkDocumentGeneration?: () => number,
  ) {
    page.on("crash", () => {
      this.crashed = true;
    });
    page.on("response", (response) => {
      const request = response.request();
      let topLevel = false;
      try {
        topLevel = request.frame() === page.mainFrame();
      } catch {
        return;
      }
      if (request.isNavigationRequest() && topLevel) {
        this.navigationStatus = response.status();
        this.rateLimited = this.navigationStatus === 429;
        this.retryAt = null;
        const value = response.headers()["retry-after"];
        if (this.rateLimited && request.method() === "GET" && value) {
          const timestamp = /^\d+$/u.test(value.trim())
            ? Date.now() + Number(value.trim()) * 1000
            : Date.parse(value);
          if (Number.isSafeInteger(timestamp))
            this.retryAt = Math.max(Date.now(), timestamp);
        }
      }
    });
    this.human = humanized ? new HumanizedBrowserInput(page) : undefined;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.generation++;
    });
  }
  /** One idempotent retry only when the server supplies a usable Retry-After. */
  async retryRateLimit(
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<boolean> {
    if (
      !this.rateLimited ||
      this.rateLimitRetried ||
      this.retryAt === null ||
      this.retryAt + 1000 >= deadlineAt ||
      signal.aborted
    )
      return false;
    this.rateLimitRetried = true;
    if (
      !(await waitForBrowserAgentCooldown(
        Math.max(750, this.retryAt - Date.now()),
        signal,
      ))
    )
      return false;
    if (Date.now() >= deadlineAt || signal.aborted) return false;
    await this.page.reload({
      waitUntil: "commit",
      timeout: Math.max(1, deadlineAt - Date.now()),
    });
    return true;
  }
  documentGeneration(): number {
    return this.networkDocumentGeneration?.() ?? this.generation;
  }
  async snapshot(retry = 0): Promise<BrowserPageSnapshot> {
    try {
      if (this.crashed) throw new BrowserPageCrashedError();
      return await this.snapshotDocument(retry);
    } catch (error) {
      if (this.crashed) throw new BrowserPageCrashedError();
      if (
        error instanceof Error &&
        /Execution context was destroyed|Cannot find context|frame was detached/iu.test(
          error.message,
        )
      )
        throw new BrowserPageTransitionError();
      throw error;
    }
  }
  private async snapshotDocument(retry: number): Promise<BrowserPageSnapshot> {
    if (this.coordinateInput) await this.coordinateInput(async () => {});
    else await this.page.bringToFront();
    if (this.rateLimited) throw new BrowserPageRateLimitError();
    if (!/^https?:/u.test(this.page.url()))
      throw new BrowserPageNavigationError();
    const generation = this.documentGeneration();
    const viewport =
      this.page.viewportSize() ??
      (await this.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })));
    if (!viewport || viewport.width < 1 || viewport.height < 1) {
      // A committed document may precede creation of its visible surface. This is
      // a page transition, not an invalid observation or a resource-load barrier.
      await this.page.waitForTimeout(100);
      throw new BrowserPageTransitionError();
    }
    this.viewport = viewport;
    const document = await this.page.evaluate(() => {
      const body = window.document.body;
      if (!body)
        return { text: "", loading: true, scale: window.devicePixelRatio || 1 };
      const walker = window.document.createTreeWalker(
        body,
        NodeFilter.SHOW_TEXT,
      );
      let text = "";
      while (walker.nextNode() && text.length < 16000) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            "script,style,noscript,input,textarea,select,[contenteditable]",
          ) ||
          parent.getClientRects().length === 0 ||
          window.getComputedStyle(parent).visibility !== "visible"
        )
          continue;
        const value = node.textContent?.trim();
        if (value) text += `${value}\n`;
      }
      return {
        text: text.slice(0, 16000),
        loading: window.document.readyState !== "complete",
        scale: window.devicePixelRatio || 1,
      };
    });
    const structure = JSON.stringify({
      generation,
      viewport,
      text: document.text,
      loading: document.loading,
    });
    if (structure !== this.structure) {
      for (const element of this.elements.values()) await element.dispose();
      this.elements.clear();
      this.elementIndices.clear();
      this.structure = structure;
    }
    const previous = new Map(this.elements);
    const nextIndices = new Map<number, string>();
    const candidates = await this.page
      .locator(
        'a:has-text("PDF"),button:has-text("PDF"),[role="button"]:has-text("PDF"),[role="link"]:has-text("PDF"),[role="tab"]:has-text("PDF"),[role="menuitem"]:has-text("PDF"),[aria-label*="pdf" i],[data-test*="pdf" i],[data-testid*="pdf" i],a:has-text("Download"),button:has-text("Download"),[role="tab"]:has-text("Download"),[role="menuitem"]:has-text("Download"),a,button,input:not([type="file"]),textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[aria-expanded],[aria-haspopup],[onclick],[tabindex]:not([tabindex="-1"]),[href*=".pdf" i],[href*="/pdf" i],[data-test*="download" i]',
      )
      .elementHandles();
    const prioritized = await Promise.all(
      candidates.map(async (element, index) => ({
        element,
        index,
        priority: await element.evaluate((node) => {
          if (!(node instanceof Element)) return 0;
          const value = `${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${node.getAttribute("href") ?? ""} ${node.textContent ?? ""}`;
          return /(?:download|\bpdf\b|\.pdf(?:$|[?#]))/iu.test(value) ? 1 : 0;
        }),
      })),
    );
    prioritized.sort(
      (left, right) =>
        right.priority - left.priority || left.index - right.index,
    );
    const elements: BrowserElement[] = [];
    let truncated = false;
    for (const { element, index } of prioritized) {
      if (elements.length >= 100) {
        truncated = true;
        await element.dispose();
        continue;
      }
      const summary = await element.evaluate((node) => {
        if (!(node instanceof Element))
          return { visible: false, role: "", name: "", editable: false };
        const rect = node.getBoundingClientRect();
        const tag = node.tagName.toLowerCase();
        return {
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.right <= window.innerWidth &&
            rect.bottom <= window.innerHeight &&
            window.getComputedStyle(node).visibility === "visible" &&
            window.getComputedStyle(node).display !== "none",
          role: node.getAttribute("role") ?? tag,
          name:
            node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            (node instanceof HTMLElement ? node.innerText : node.textContent) ||
            node.querySelector("img[alt]")?.getAttribute("alt") ||
            "",
          editable: tag === "input" || tag === "textarea",
        };
      });
      if (!summary.visible) {
        await element.dispose();
        continue;
      }
      const priorId = this.elementIndices.get(index);
      const prior = priorId ? previous.get(priorId) : undefined;
      const same =
        prior &&
        (await element
          .evaluate((node, old) => node === old, prior)
          .catch(() => false));
      const elementId = same ? priorId! : `element-${++this.revision}`;
      if (same) {
        await element.dispose();
        previous.delete(elementId);
      } else this.elements.set(elementId, element);
      nextIndices.set(index, elementId);
      elements.push({
        element_id: elementId,
        role: summary.role,
        name: redact(summary.name.trim(), 120),
        editable: summary.editable,
      });
    }
    for (const [id, element] of previous) {
      this.elements.delete(id);
      await element.dispose();
    }
    this.elementIndices.clear();
    for (const [index, id] of nextIndices) this.elementIndices.set(index, id);
    this.observedFeedback = await this.feedback();
    const screenshot = await this.captureScreenshot();
    if (generation !== this.documentGeneration()) {
      if (retry >= 2) throw new BrowserPageTransitionError();
      await this.page.waitForTimeout(150);
      return this.snapshot(retry + 1);
    }
    return {
      url: this.page.url(),
      ...(this.navigationStatus !== undefined
        ? { http_status: this.navigationStatus }
        : {}),
      title: redact(await this.page.title(), 4096),
      viewport: {
        width: viewport.width,
        height: viewport.height,
        device_scale_factor: document.scale,
      },
      screenshot,
      document_generation: generation,
      text: redact(document.text, 16000),
      elements,
      loading: document.loading,
      partial: truncated,
    };
  }

  /**
   * Playwright waits for every document font before taking a screenshot. Publisher
   * pages often leave a third-party font pending while their article document is
   * already usable, which would make the Agent lose the hand-off after a challenge
   * navigation. Keep the normal masked screenshot first; for a page without sensitive
   * inputs, fall back to Chromium's surface capture so observation can continue.
   */
  private async captureScreenshot(): Promise<Uint8Array | null> {
    if (this.coordinateInput)
      return this.coordinateInput(() => this.captureScreenshotInternal());
    return this.captureScreenshotInternal();
  }
  private async captureScreenshotInternal(): Promise<Uint8Array | null> {
    const masked = [
      this.page.locator(
        'input[type="password"],input[autocomplete="one-time-code"]',
      ),
    ];
    try {
      return new Uint8Array(
        await this.page.screenshot({
          type: "jpeg",
          quality: 65,
          timeout: 5000,
          mask: masked,
        }),
      );
    } catch {
      const sensitiveCount = await this.page
        .locator('input[type="password"],input[autocomplete="one-time-code"]')
        .count()
        .catch(() => 1);
      if (sensitiveCount > 0) return null;
      const session = await this.page.context().newCDPSession(this.page);
      try {
        const captured = await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 65,
          fromSurface: true,
        });
        return new Uint8Array(Buffer.from(captured.data, "base64"));
      } finally {
        await session.detach().catch(() => undefined);
      }
    }
  }
  private async feedback(): Promise<string | null> {
    // Read each visible frame through Playwright, including cross-origin frames.
    // Compare semantics, not pixels, CSS classes or continuously moving bounds:
    // a spinner's animation must not masquerade as a newly available control.
    const surfaces: string[] = [];
    const visit = async (frame: Frame): Promise<void> => {
      if (frame !== this.page.mainFrame()) {
        const element = await frame.frameElement();
        try {
          const visible = await element.evaluate((node) => {
            if (!(node instanceof Element)) return false;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              node.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }) &&
              style.display !== "none" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < innerHeight &&
              rect.left < innerWidth
            );
          });
          if (!visible) return;
        } finally {
          await element.dispose();
        }
      }
      surfaces.push(
        await frame.evaluate(() => {
          const visible = (node: Element): boolean => {
            const rect = node.getBoundingClientRect();
            return (
              node.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }) &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < innerHeight &&
              rect.left < innerWidth
            );
          };
          const walker = document.createTreeWalker(
            document.body ?? document,
            NodeFilter.SHOW_TEXT,
          );
          let text = "";
          while (walker.nextNode() && text.length < 16000) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            if (
              !parent ||
              parent.closest(
                "script,style,noscript,input,textarea,select,[contenteditable]",
              ) ||
              !visible(parent)
            )
              continue;
            const value = node.textContent?.trim();
            if (value) text += `${value}\n`;
          }
          const controls = Array.from(
            document.querySelectorAll(
              "a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable]",
            ),
          )
            .filter(visible)
            .slice(0, 100)
            .map((node) => ({
              tag: node.tagName,
              role: node.getAttribute("role"),
              name:
                node.getAttribute("aria-label") ?? node.getAttribute("title"),
              disabled:
                node.matches(":disabled") ||
                node.getAttribute("aria-disabled") === "true",
              checked:
                node.matches(":checked") || node.getAttribute("aria-checked"),
              expanded: node.getAttribute("aria-expanded"),
            }));
          // Values, URLs and DOM content never leave this private comparison.
          return JSON.stringify({
            text: text.slice(0, 16000),
            controls,
            state: document.readyState,
            title: document.title,
          });
        }),
      );
      for (const child of frame.childFrames()) await visit(child);
    };
    try {
      await visit(this.page.mainFrame());
      return JSON.stringify(surfaces);
    } catch (error) {
      if (
        error instanceof Error &&
        /Execution context was destroyed|Cannot find context|frame was detached|Frame has been detached|Target page, context or browser has been closed/iu.test(
          error.message,
        )
      )
        return null; // An unreadable sample is not observed progress.
      throw error;
    }
  }
  private async dispatch(
    check: () => void,
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = async () => {
      check();
      const viewport =
        this.page.viewportSize() ??
        (await this.page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        })));
      if (
        this.viewport &&
        (viewport.width !== this.viewport.width ||
          viewport.height !== this.viewport.height)
      )
        throw new BrowserPageStaleActionError();
      check();
      await operation();
    };
    if (this.coordinateInput) await this.coordinateInput(run);
    else await run();
  }
  private elementReadFailed(error: unknown): never {
    if (this.crashed) throw new BrowserPageCrashedError();
    if (this.page.isClosed()) throw new BrowserPageClosedError();
    if (error instanceof Error) {
      if (
        /Execution context was destroyed|Cannot find context|frame was detached/iu.test(
          error.message,
        )
      )
        throw new BrowserPageTransitionError();
      if (
        /JSHandle is disposed|Element is not attached to the DOM/iu.test(
          error.message,
        )
      )
        throw new BrowserElementUnavailableError("element-detached");
    }
    throw error;
  }
  async apply(
    value: OperatorInput,
    expectedGeneration: number,
    current: () => boolean,
  ): Promise<BrowserPageApplyResult | void> {
    const input = parseOperatorInput(value);
    const check = () => {
      if (!current()) throw new BrowserPageRuntimeError();
      if (this.crashed) throw new BrowserPageCrashedError();
      if (this.page.isClosed()) throw new BrowserPageClosedError();
      if (
        input.kind !== "wait-for-change" &&
        expectedGeneration !== this.documentGeneration()
      )
        throw new BrowserPageStaleActionError();
    };
    check();
    switch (input.kind) {
      case "stop":
        return;
      case "wait-for-change": {
        const started = performance.now();
        let baseline = this.observedFeedback ?? (await this.feedback());
        const deadline = started + input.timeout_ms;
        const result = (
          outcome: "changed" | "timeout",
        ): BrowserPageApplyResult => ({
          wait_outcome: outcome,
          wait_elapsed_ms: Math.max(0, performance.now() - started),
        });
        while (performance.now() < deadline) {
          check();
          if (this.rateLimited) throw new BrowserPageRateLimitError();
          if (this.documentGeneration() !== expectedGeneration)
            return result("changed");
          const feedback = await this.feedback();
          check();
          if (feedback !== null && baseline !== null && feedback !== baseline)
            return result("changed");
          baseline ??= feedback;
          try {
            await this.page.waitForTimeout(
              Math.min(250, Math.max(1, deadline - performance.now())),
            );
          } catch (error) {
            check();
            throw error;
          }
        }
        check();
        return result("timeout");
      }
      case "go-back": {
        const before = this.page.url();
        const response = await this.page.goBack({
          waitUntil: "commit",
          timeout: 0,
        });
        return { no_history: response === null && this.page.url() === before };
      }
      case "scroll-surface":
        await this.dispatch(check, async () => {
          if (this.human)
            await this.human.scroll(input.delta_x, input.delta_y, check);
          else await this.page.mouse.wheel(input.delta_x, input.delta_y);
        });
        return;
      case "press-key":
        await this.dispatch(check, async () => {
          if (this.human) await this.human.key(input.key, check);
          else await this.page.keyboard.press(input.key);
        });
        return;
      case "click-point": {
        const viewport = this.viewport;
        if (
          !viewport ||
          input.x >= viewport.width ||
          input.y >= viewport.height
        )
          throw new BrowserPageRuntimeError();
        const hit = await this.page.evaluate(
          ({ x, y }) => {
            const node = document.elementFromPoint(x, y);
            const anchor = node?.closest("a[download]");
            const label = node?.closest("label");
            const surface = node?.closest(
              'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"]',
            );
            const surfaceText = `${surface?.getAttribute("aria-label") ?? ""} ${surface?.textContent ?? ""} ${surface?.getAttribute("href") ?? ""}`;
            return {
              forbidden:
                !node ||
                !!node.closest('input[type="file"]') ||
                (label instanceof HTMLLabelElement &&
                  label.control instanceof HTMLInputElement &&
                  label.control.type === "file"),
              download:
                anchor instanceof HTMLAnchorElement ? anchor.href : null,
              likelyPdf: /(?:\bpdf\b|download)/iu.test(surfaceText),
              tag: node?.tagName.toLowerCase() ?? "unknown",
              semanticControl: surface !== null,
              label:
                surface?.getAttribute("aria-label") ||
                surface?.getAttribute("title") ||
                (surface instanceof HTMLElement
                  ? surface.innerText
                  : surface?.textContent) ||
                surface?.querySelector("img[alt]")?.getAttribute("alt") ||
                "",
            };
          },
          { x: input.x, y: input.y },
        );
        check();
        if (hit.forbidden) throw new BrowserPageRuntimeError();
        if (hit.download) {
          if (!this.beforeDownload) throw new BrowserPageRuntimeError();
          await this.beforeDownload(hit.download);
          check();
        }
        await this.dispatch(check, async () => {
          if (this.human) await this.human.click(input.x, input.y, check);
          else await this.page.mouse.click(input.x, input.y);
        });
        return {
          point: { x: input.x, y: input.y },
          label: redact(hit.label, 512),
          likely_pdf: hit.likelyPdf,
          ...(!hit.semanticControl
            ? {
                feedback: `ClickPoint hit a ${hit.tag} element without an enclosing semantic link/button. If the page did not change, inspect the actual visible controls before clicking again.`,
              }
            : {}),
        };
      }
      case "click-element":
      case "type-text": {
        const element = this.elements.get(input.element_id);
        if (!element)
          throw new BrowserElementUnavailableError("element-missing");
        const box = await element
          .boundingBox()
          .catch((error: unknown) => this.elementReadFailed(error));
        const viewport = this.viewport;
        const allowed = await element
          .evaluate((node) => ({
            connected: node instanceof Element && node.isConnected,
            forbidden:
              node instanceof Element && node.getAttribute("type") === "file",
            visible:
              node instanceof Element &&
              getComputedStyle(node).visibility === "visible" &&
              getComputedStyle(node).display !== "none",
          }))
          .catch((error: unknown) => this.elementReadFailed(error));
        if (allowed.forbidden) throw new BrowserPageRuntimeError();
        if (!allowed.connected)
          throw new BrowserElementUnavailableError("element-detached");
        if (!box || !allowed.visible)
          throw new BrowserElementUnavailableError("element-not-visible");
        if (!viewport) throw new BrowserPageRuntimeError();
        if (
          box.x < 0 ||
          box.y < 0 ||
          box.x + box.width > viewport.width ||
          box.y + box.height > viewport.height
        )
          throw new BrowserElementUnavailableError("element-outside-viewport");
        if (input.kind === "type-text") {
          const editable = await element.evaluate(
            (node) =>
              node instanceof HTMLElement &&
              ["INPUT", "TEXTAREA"].includes(node.tagName) &&
              !(node as HTMLInputElement).disabled &&
              !(node as HTMLInputElement).readOnly,
          );
          if (!editable) throw new BrowserPageRuntimeError();
        }
        const clickLabel =
          input.kind === "click-element"
            ? await element.evaluate(
                (node) =>
                  (node instanceof Element
                    ? node.getAttribute("aria-label")
                    : null) ||
                  (node instanceof Element
                    ? node.getAttribute("title")
                    : null) ||
                  (node instanceof HTMLElement
                    ? node.innerText
                    : node.textContent) ||
                  (node instanceof Element
                    ? node.querySelector("img[alt]")?.getAttribute("alt")
                    : null) ||
                  "",
              )
            : undefined;
        if (input.kind === "click-element") {
          const download = await element.evaluate((node) => {
            const anchor =
              node instanceof Element ? node.closest("a[download]") : null;
            return anchor instanceof HTMLAnchorElement ? anchor.href : null;
          });
          if (download) {
            if (!this.beforeDownload) throw new BrowserPageRuntimeError();
            await this.beforeDownload(download);
          }
        }
        check();
        await this.dispatch(check, async () => {
          if (this.human)
            await this.human.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
              check,
            );
          else
            await this.page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          if (input.kind === "type-text") {
            check();
            if (this.human) await this.human.text(input.text, check);
            else await this.page.keyboard.insertText(input.text);
          }
        });
        return {
          ...(input.kind === "click-element"
            ? {
                point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                label: redact(clickLabel ?? "", 512),
              }
            : {}),
          likely_pdf:
            input.kind === "click-element" &&
            (await element
              .evaluate((node) => {
                const element = node instanceof Element ? node : null;
                return /(?:\bpdf\b|download)/iu.test(
                  `${element?.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""} ${element?.getAttribute("href") ?? ""}`,
                );
              })
              .catch(() => false)),
        };
      }
    }
  }
}
