import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startDesignSamples } from "./design-samples-fixture.js";
import {
  designSamplePages,
  reachDesignSample,
} from "./design-samples-pages.js";
import { designSamplesAssets } from "./design-samples-assets.js";
import { loginWorkbenchPage } from "../../server/test/workbench-auth-fixture.js";

/**
 * Checks the design-core rules on every design-sample page: the fixed type
 * scale, token font families, one primary action per surface, a single tab
 * level and readable text contrast.
 */
let samples: Awaited<ReturnType<typeof startDesignSamples>>;
let browser: Browser;
const password = randomBytes(32).toString("base64url");
beforeAll(async () => {
  const assets = await designSamplesAssets();
  samples = await startDesignSamples({ assets, password });
  browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
}, 0);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await samples?.close();
  }
}, 0);

interface Violation {
  rule: string;
  detail: string;
}

/** Runs in the page; reports rule violations for visible, non-content UI. */
function collectViolations(): Violation[] {
  // Literature content keeps its own relative sizes and fonts.
  const content =
    ".reading-pdf-page, .reading-article, .reading-markdown, .katex, .proofread-source, .agent-raw, pre, code, .ui-tech-details, svg";
  const sizes = new Set([13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]);
  const families = ['"Source Sans 3"', '"Source Serif 4"', "SFMono-Regular"];
  const out: Violation[] = [];
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0
    );
  };
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
  const parse = (color: string) => {
    const m = color.match(/rgba?\(([^)]+)\)/u);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1]!
      .split(/[ ,/]+/u)
      .filter(Boolean)
      .map(Number);
    return [r!, g!, b!, a] as const;
  };
  const background = (el: Element) => {
    const layers: (readonly [number, number, number, number])[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let [r, g, b] = [255, 255, 255];
    for (const [lr, lg, lb, la] of layers.reverse()) {
      r = lr * la + r * (1 - la);
      g = lg * la + g * (1 - la);
      b = lb * la + b * (1 - la);
    }
    return [r, g, b] as const;
  };
  const luminance = ([r, g, b]: readonly number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(content)) continue;
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
    );
    if (!ownText || !visible(el)) continue;
    const style = getComputedStyle(el);
    const size = Math.round(parseFloat(style.fontSize));
    if (!sizes.has(size))
      out.push({ rule: "type-scale", detail: `${size}px ${describe(el)}` });
    if (!families.some((f) => style.fontFamily.startsWith(f)))
      out.push({
        rule: "font-family",
        detail: `${style.fontFamily.split(",")[0]} ${describe(el)}`,
      });
    const disabled = el.closest(
      '[data-disabled], [aria-disabled="true"], :disabled, [inert]',
    );
    const fg = parse(style.color);
    if (!disabled && fg && fg[3] > 0) {
      const bg = background(el);
      const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
      const [l1, l2] = [luminance(mixed), luminance(bg)].sort((a, b) => b - a);
      const ratio = (l1! + 0.05) / (l2! + 0.05);
      if (ratio < 4.5)
        out.push({
          rule: "contrast",
          detail: `${ratio.toFixed(2)} ${describe(el)}`,
        });
    }
  }
  const surfaces = [
    ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
  ];
  const primaries = [
    ...document.querySelectorAll('.ui-button[data-variant="primary"]'),
  ].filter(visible);
  const count = new Map<Element | null, number>();
  for (const button of primaries) {
    const surface = surfaces.find((s) => s.contains(button)) ?? null;
    count.set(surface, (count.get(surface) ?? 0) + 1);
  }
  for (const [surface, n] of count)
    if (n > 1)
      out.push({
        rule: "one-primary",
        detail: `${n} on ${surface ? "dialog" : "page"}`,
      });
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    if (list.closest(".ui-segmented") || !visible(list)) continue;
    const outer = list.parentElement?.closest('[role="tabpanel"]');
    if (outer && !outer.closest(".ui-segmented"))
      out.push({ rule: "nested-tabs", detail: describe(list) });
  }
  return out;
}

/**
 * Known page-level violations scheduled in plan 14 block 05. Each entry must be
 * removed in the same change that fixes it; new violations fail the test.
 */
const pending: string[] = [];

async function violations(page: Page, entryId: string) {
  const found = await page.evaluate(collectViolations);
  // One line per distinct problem keeps the report readable.
  return [...new Set(found.map((v) => `${entryId} ${v.rule} ${v.detail}`))];
}

it(
  "keeps every design-sample page within the design-core rules",
  { timeout: 0 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const anonymous = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const report: string[] = [];
    try {
      const login = await context.newPage();
      await loginWorkbenchPage(login, samples.origin, password);
      await login.close();
      for (const entry of designSamplePages) {
        const page = await (entry.anonymous ? anonymous : context).newPage();
        page.setDefaultTimeout(30000);
        try {
          await reachDesignSample(page, samples.origin, samples.ids, entry);
          report.push(...(await violations(page, entry.id)));
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
      await anonymous.close();
    }
    if (process.env.SCIRETRIEVER_DESIGN_RULES_OUTPUT)
      await writeFile(
        process.env.SCIRETRIEVER_DESIGN_RULES_OUTPUT,
        report.join("\n") + "\n",
      );
    expect([...report].sort()).toEqual([...pending].sort());
  },
);
