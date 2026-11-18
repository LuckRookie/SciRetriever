import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
 * level and readable text contrast in all seven themes, and one colour per
 * status (rule 5) across the pages.
 */
// Design core “主题”: 纸墨 first, as the pages open in it.
const themes = [
  "light",
  "oldbook",
  "xuan",
  "bean",
  "eink",
  "dark",
  "candle",
] as const;
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
    // The loading skeleton's title is the paper's own title, set as its text will be.
    ".reading-pdf-page, .reader-view[data-view='doc'], .reader-preparing-title, .reading-markdown, .katex, .proofread-source, .agent-raw, pre, code, .ui-tech-details, svg";
  const sizes = new Set([13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]);
  const families = ['"IBM Plex Sans"', '"Source Serif 4"', "SFMono-Regular"];
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
 * Runs in the page: the full text's sheet (reading-experience 2.1, 2.4). Its
 * sizes are multiples of the reading size from spec 2.1's table, or the
 * margin's fixed sizes; the author's words are serif, the rest sans-serif.
 */
function collectReadingViolations(): Violation[] {
  const sheet = document.querySelector<HTMLElement>(
    ".reader-engine:not([hidden]) .reader-view:not([hidden])[data-view='doc']",
  );
  const article = sheet?.querySelector<HTMLElement>(".reading-article");
  if (!sheet || !article) return [];
  const base = parseFloat(getComputedStyle(article).fontSize);
  // Spec 2.1: title 1.8, headings 1.5, 1.2, 1.05, abstract title 1.15, text 1,
  // Latin text 0.975, table and footnote 0.8, captions 0.775 (a Latin caption
  // or table paragraph multiplies by 0.975).
  const factors = [1.8, 1.5, 1.2, 1.15, 1.05, 1, 0.975, 0.8, 0.775];
  const allowed = [
    ...factors.flatMap((f) => [f * base, f * 0.975 * base]),
    // Fixed, not scaled: margin notes, margin numbers, the page header and its line.
    11,
    11.5,
    12,
    12.5,
    13,
  ];
  const out: Violation[] = [];
  for (const el of sheet.querySelectorAll("*")) {
    if (el.closest(".katex, pre, code, svg, .reading-block-source")) continue;
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
    );
    const box = el.getBoundingClientRect();
    if (!ownText || !box.width || !box.height) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    if (!allowed.some((a) => Math.abs(a - size) <= 0.51))
      out.push({
        rule: "reading-scale",
        detail: `${size.toFixed(1)}px at ${base}px ${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`,
      });
    const author =
      el.closest("[data-origin]")?.getAttribute("data-origin") === "author";
    const serif = style.fontFamily.startsWith('"Source Serif 4"');
    if (author !== serif)
      out.push({
        rule: author ? "author-serif" : "machine-sans",
        detail: `${style.fontFamily.split(",")[0]} ${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
      });
  }
  return out;
}

/**
 * Runs in the page: puts a theme on the root and finishes the colour
 * transitions it starts, so the computed colours are the theme's own.
 */
async function wearTheme(theme: string) {
  // Colour transitions (kept under reduced motion) would be caught half
  // way; for the check they take no time.
  const instant = "sciretrieverInstantColours";
  const root = document as Document & Record<string, unknown>;
  if (!root[instant]) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    root[instant] = true;
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.getBoundingClientRect();
  for (const animation of document.getAnimations())
    if (animation instanceof CSSTransition) animation.finish();
  await new Promise(requestAnimationFrame);
}

interface StatusColour {
  tone: string;
  colour: string;
}
/** Runs in the page: the colours each visible status label and status fill wears. */
function collectStatusColours(): StatusColour[] {
  const out: StatusColour[] = [];
  for (const el of document.querySelectorAll(
    ":is(.ui-badge, .paper-status, .value-check, .ui-tone-fill)[data-tone]",
  )) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(el);
    const fill = el.classList.contains("ui-tone-fill");
    out.push({
      tone: `${fill ? "fill" : "label"} ${el.getAttribute("data-tone")}`,
      colour: fill
        ? style.backgroundColor
        : `${style.color} on ${style.backgroundColor}`,
    });
  }
  return out;
}
const statusColours = new Map<string, Map<string, Set<string>>>();

/**
 * Known page-level violations scheduled in plan 14 block 05. Each entry must be
 * removed in the same change that fixes it; new violations fail the test.
 */
const pending: string[] = [];

async function violations(page: Page, entryId: string) {
  // Colours still easing in (an action enabled a moment ago) settle first.
  await page.evaluate(wearTheme, "light");
  const found = await page.evaluate(collectViolations);
  // Contrast and status colours in every theme (design core “主题”).
  for (const theme of themes) {
    if (theme !== "light") {
      await page.evaluate(wearTheme, theme);
      for (const v of await page.evaluate(collectViolations))
        if (v.rule === "contrast")
          found.push({ rule: `contrast@${theme}`, detail: v.detail });
    }
    const seen = statusColours.get(theme) ?? new Map<string, Set<string>>();
    statusColours.set(theme, seen);
    for (const { tone, colour } of await page.evaluate(collectStatusColours))
      seen.set(tone, (seen.get(tone) ?? new Set()).add(colour));
  }
  await page.evaluate(wearTheme, "light");
  // The full text at reading sizes 16, 20 and 32 px (design core “检查”).
  for (const size of [16, 20, 32]) {
    await page.evaluate((size) => {
      for (const el of document.querySelectorAll<HTMLElement>(
        ".reader-engine-body",
      ))
        el.style.setProperty("--reading-font-size", `${size}px`);
    }, size);
    found.push(...(await page.evaluate(collectReadingViolations)));
  }
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
    // Rule 5: in each theme a status has one colour on every page.
    const mixed = [...statusColours].flatMap(([theme, tones]) =>
      [...tones]
        .filter(([, colours]) => colours.size > 1)
        .map(
          ([tone, colours]) => `${theme} ${tone}: ${[...colours].join(" | ")}`,
        ),
    );
    expect(mixed).toEqual([]);
    expect(statusColours.get("light")?.size ?? 0).toBeGreaterThan(4);
  },
);

it("keeps --reader-check-fail readable on the sheet in all seven themes (spec 8.2 排版)", async () => {
  const tokens = await readFile(
    new URL("../src/app/styles/tokens.css", import.meta.url),
    "utf8",
  );
  const block = (theme: string) => {
    const at = tokens.indexOf(`[data-theme-preview="${theme}"] {`);
    expect(at).toBeGreaterThan(0);
    return tokens.slice(at, tokens.indexOf("}", at));
  };
  const value = (css: string, name: string): string => {
    const found = new RegExp(`\\s${name}:\\s*([^;]+);`, "u").exec(css)?.[1];
    expect(found, name).toBeDefined();
    return found!.trim();
  };
  const hex = (color: string) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color);
    if (!m) throw new Error(`not a hex colour: ${color}`);
    const digits =
      m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join("") : m[1]!;
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  };
  const lum = (rgb: number[]) =>
    rgb
      .map((v) => v / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  // The sheet is the theme's paper (`--reader-sheet: var(--bg)`).
  expect(tokens).toMatch(/--reader-sheet:\s*var\(--bg\);/u);
  for (const theme of themes) {
    const css = block(theme);
    const fail = value(css, "--reader-check-fail");
    const sheet = value(css, "--bg");
    const [a, b] = [lum(hex(fail)), lum(hex(sheet))].sort((x, y) => y - x);
    expect((a! + 0.05) / (b! + 0.05), theme).toBeGreaterThanOrEqual(4.5);
  }
});
