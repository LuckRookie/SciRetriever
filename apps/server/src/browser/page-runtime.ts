import { HumanizedBrowserInput } from "./human-input.js";
import {
  parseOperatorInput,
  type OperatorInput,
} from "@sciretriever/contracts";
import type { ElementHandle, Page } from "playwright";
import type { BrowserPageSnapshot } from "./observation.js";

export interface BrowserElement {
  readonly element_id: string;
  readonly role: string;
  readonly name: string;
  readonly editable: boolean;
}
export class BrowserPageRuntimeError extends Error {
  readonly code = "browser-page-runtime";
  constructor() {
    super("browser page operation failed");
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
  ) {
    this.human = humanized ? new HumanizedBrowserInput(page) : undefined;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.generation++;
    });
  }
  documentGeneration(): number {
    return this.generation;
  }
  async snapshot(): Promise<BrowserPageSnapshot> {
    await this.page.bringToFront();
    await this.page.waitForFunction(
      () => window.innerWidth > 0 && window.innerHeight > 0,
      null,
      { timeout: 5000 },
    );
    const generation = this.generation;
    const viewport =
      this.page.viewportSize() ??
      (await this.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })));
    this.viewport = viewport;
    if (!viewport) throw new BrowserPageRuntimeError();
    const document = await this.page.evaluate(() => {
      const clone = window.document.body.cloneNode(true) as HTMLElement;
      for (const node of clone.querySelectorAll(
        "script,style,input,textarea,select,[contenteditable]",
      ))
        node.remove();
      return {
        text: (clone.textContent ?? "").slice(0, 16000),
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
        'a,button,input:not([type="file"]),textarea,select,[role="button"]',
      )
      .elementHandles();
    const elements: BrowserElement[] = [];
    for (const [index, element] of candidates.entries()) {
      if (index >= 100) {
        await element.dispose();
        continue;
      }
      const summary = await element.evaluate((node) => {
        if (!(node instanceof Element))
          return { visible: false, role: "", name: "", editable: false };
        const rect = node.getBoundingClientRect();
        const tag = node.tagName.toLowerCase();
        return {
          visible: rect.width > 0 && rect.height > 0,
          role: node.getAttribute("role") ?? tag,
          name: node.getAttribute("aria-label") ?? node.textContent ?? "",
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
    const screenshot = await this.page.screenshot({
      type: "jpeg",
      quality: 65,
      timeout: 5000,
      mask: [
        this.page.locator(
          'input[type="password"],input[autocomplete="one-time-code"]',
        ),
      ],
    });
    if (generation !== this.generation) throw new BrowserPageRuntimeError();
    return {
      url: this.page.url(),
      title: redact(await this.page.title(), 4096),
      viewport: {
        width: viewport.width,
        height: viewport.height,
        device_scale_factor: document.scale,
      },
      screenshot: new Uint8Array(screenshot),
      document_generation: generation,
      text: redact(document.text, 16000),
      elements,
      loading: document.loading,
      partial: candidates.length > 100,
    };
  }
  async apply(
    value: OperatorInput,
    expectedGeneration: number,
    current: () => boolean,
  ): Promise<void> {
    const input = parseOperatorInput(value);
    const check = () => {
      if (
        !current() ||
        this.page.isClosed() ||
        expectedGeneration !== this.generation
      )
        throw new BrowserPageRuntimeError();
    };
    check();
    switch (input.kind) {
      case "stop":
        return;
      case "wait-for-change":
        for (let elapsed = 0; elapsed < input.timeout_ms; elapsed += 50) {
          if (!current() || this.page.isClosed())
            throw new BrowserPageRuntimeError();
          if (this.generation !== expectedGeneration) break;
          await this.page.waitForTimeout(
            Math.min(50, input.timeout_ms - elapsed),
          );
        }
        return;
      case "go-back":
        await this.page.goBack({ waitUntil: "commit", timeout: 5000 });
        return;
      case "scroll-surface":
        if (this.human)
          await this.human.scroll(input.delta_x, input.delta_y, check);
        else await this.page.mouse.wheel(input.delta_x, input.delta_y);
        return;
      case "press-key":
        if (this.human) await this.human.key(input.key, check);
        else await this.page.keyboard.press(input.key);
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
            return {
              forbidden:
                !node ||
                !!node.closest('input[type="file"]') ||
                (label instanceof HTMLLabelElement &&
                  label.control instanceof HTMLInputElement &&
                  label.control.type === "file"),
              download:
                anchor instanceof HTMLAnchorElement ? anchor.href : null,
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
        if (this.human) await this.human.click(input.x, input.y, check);
        else await this.page.mouse.click(input.x, input.y);
        return;
      }
      case "click-element":
      case "type-text": {
        const element = this.elements.get(input.element_id);
        if (!element) throw new BrowserPageRuntimeError();
        const box = await element.boundingBox();
        const viewport = this.viewport;
        const allowed = await element.evaluate(
          (node) =>
            node instanceof Element &&
            node.isConnected &&
            node.getAttribute("type") !== "file",
        );
        if (
          !allowed ||
          !box ||
          !viewport ||
          box.x < 0 ||
          box.y < 0 ||
          box.x + box.width > viewport.width ||
          box.y + box.height > viewport.height
        )
          throw new BrowserPageRuntimeError();
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
        return;
      }
    }
  }
}
