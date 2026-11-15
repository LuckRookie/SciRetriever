/**
 * Browser measurements of the reading experience (spec "reading-experience"
 * 8.2), on the synthetic design sample library and the reader's test build.
 * Each check records numbers into a JSON report; a check fails the test only
 * when it is enforced (ENFORCED below, or SCIRETRIEVER_READER_ENFORCE=id,id|all);
 * `check.item` enforces one item of a check.
 * Until the new layout ships, the reading line follows spec section 10.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loginWorkbenchPage } from "../../server/test/workbench-auth-fixture.js";
import { designSamplePageCleanup } from "./design-samples-browser.js";
import { designSamplesAssets } from "./design-samples-assets.js";
import { startDesignSamples } from "./design-samples-fixture.js";

type CheckId =
  | "anchor"
  | "views"
  | "blank"
  | "background"
  | "downloads"
  | "zoom"
  | "transitions"
  | "spine"
  | "performance"
  | "typography"
  | "screenshots";
type Status = "pass" | "fail" | "no-object" | "unimplemented";
interface Item {
  id: string;
  label: string;
  criterion: string;
  status: Status;
  numbers: Record<string, unknown>;
  note?: string;
}
interface Check {
  title: string;
  criterion: string;
  status: Status;
  enforced: boolean | string[];
  items: Item[];
}
/** Checks (or `check.item`) every later block must keep passing; 03–06 add theirs as they land. */
const ENFORCED: readonly (CheckId | `${CheckId}.${string}`)[] = [
  "background",
  "downloads",
  "anchor",
  "views",
  "zoom",
  // 05 zoom and scroll, 06 view and tab switches: every frame has a picture.
  "blank",
];
const enforce = new Set<string>([
  ...ENFORCED,
  ...(process.env.SCIRETRIEVER_READER_ENFORCE ?? "").split(",").filter(Boolean),
]);
const TIMEOUT = 30_000;

const password = randomBytes(32).toString("base64url");
let samples: Awaited<ReturnType<typeof startDesignSamples>>;
let browser: Browser;
let reportFile = "";
let servedScripts = "";
const report = {
  created_at: new Date().toISOString(),
  synthetic: true,
  spec: "docs/architecture/web/reading-experience.md#82-浏览器检查",
  reading_line:
    "spec 4.1: 28% of the visible desk below the page header (section 10 where there is no header)",
  settled: "spec 8.2: no layout change for 200 ms, at most 2 s",
  viewport: { width: 1440, height: 900 },
  checks: {} as Partial<Record<CheckId, Check>>,
};
/** Shared numbers: several checks read one measured interaction. */
const shared: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  const directory =
    process.env.SCIRETRIEVER_READER_REPORT_DIR ??
    (await mkdtemp(join(tmpdir(), "sciretriever-reader-smoothness-")));
  await mkdir(directory, { recursive: true });
  reportFile = join(
    directory,
    `reader-smoothness-${process.env.SCIRETRIEVER_READER_REPORT_LABEL ?? report.created_at.replaceAll(":", "-")}.json`,
  );
  // An existing report (a recorded baseline) is never overwritten.
  await writeFile(reportFile, "{}\n", { flag: "wx" });
  const assets = await designSamplesAssets({ readerProbe: true });
  servedScripts = [...assets.values()]
    .filter((a) => a.contentType.startsWith("text/javascript"))
    .map((a) => Buffer.from(a.body).toString("utf8"))
    .join("\n");
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
  if (reportFile)
    process.stdout.write(`reader smoothness report: ${reportFile}\n`);
}, 0);

async function record(
  id: CheckId,
  title: string,
  criterion: string,
  items: Item[],
  unimplemented = false,
) {
  const statuses = items.map((i) => i.status);
  const status: Status = unimplemented
    ? "unimplemented"
    : statuses.includes("fail")
      ? "fail"
      : statuses.includes("pass")
        ? "pass"
        : "no-object";
  const whole = enforce.has(id) || enforce.has("all"),
    enforcedItems = items
      .map((i) => i.id)
      .filter((item) => whole || enforce.has(`${id}.${item}`));
  const enforced = whole || (enforcedItems.length ? enforcedItems : false);
  report.checks[id] = { title, criterion, status, enforced, items };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  if (enforcedItems.length && !unimplemented)
    expect(
      items.filter((i) => i.status === "fail" && enforcedItems.includes(i.id)),
      `${id} must pass`,
    ).toEqual([]);
}
const verdict = (ok: boolean | null): Status =>
  ok === null ? "fail" : ok ? "pass" : "fail";
const noObject = (id: string, label: string, criterion: string): Item => ({
  id,
  label,
  criterion,
  status: "no-object",
  numbers: {},
  note: "现有版面没有这个构件；新版面或后续块加入后测量。",
});

interface Anchor {
  mode: string;
  key: string;
  top: number;
  ratio: number;
  line: number;
  page: string | null;
  regionTop: number;
  scrollTop: number;
}
interface Frame {
  t: number;
  content: boolean;
  /** Every visible PDF page shows its drawn page or a bitmap of it (not a placeholder). */
  picture: boolean;
  /** The loading skeleton (spec 6.3) is on screen. */
  skeleton: boolean;
  painted: boolean;
  sharp: boolean;
  animations: string[];
}
interface Helpers {
  marked: Anchor | null;
  inputAt: number;
  firstRendered: number | null;
  frames: Frame[];
  sampling: boolean;
  body(): HTMLElement | null;
  line(b: HTMLElement): number;
  blocks(b: HTMLElement): HTMLElement[];
  anchor(): Anchor | null;
  element(mode: string, key: string): HTMLElement | null;
  mark(): Anchor | null;
  topOf(a: Anchor | null): number | null;
  frame(): Promise<number>;
  signature(): string;
  still(
    limit?: number,
  ): Promise<{ still: boolean; ms: number; frames: number }>;
  content(): boolean;
  picture(): boolean;
  painted(mode: string): boolean;
  sharp(width?: number): boolean;
  sample(mode?: string, width?: number): void;
  stop(): Frame[];
  until(test: () => boolean, limit?: number): Promise<number | null>;
  open(url: string): void;
}
/** In-page measurement helpers, installed before the application runs. */
function installHelpers() {
  const rs: Helpers = {
    firstRendered: null,
    marked: null as Anchor | null,
    inputAt: 0,
    body: () =>
      document.querySelector<HTMLElement>(".reader-engine-body:not([hidden])"),
    // Spec 4.1: 28% down the visible desk below the page header (none: the scroll area's top).
    line: (b: HTMLElement) => {
      const r = b.getBoundingClientRect(),
        header = b.querySelector<HTMLElement>(
          ".reader-view:not([hidden]) .reader-page-header",
        ),
        below = header?.getClientRects().length ? header.offsetHeight : 0;
      return r.top + below + (b.clientHeight - below) * 0.28;
    },
    blocks: (b: HTMLElement) =>
      [
        ...b.querySelectorAll<HTMLElement>(
          b.dataset.mode === "pdf"
            ? ".reading-pdf-page"
            : "article > section[data-byte-start]",
        ),
      ].filter((el) => el.getClientRects().length > 0),
    anchor() {
      const b = rs.body();
      if (!b) return null;
      const y = rs.line(b),
        list = rs.blocks(b);
      // The first block whose bottom is below the line: between two blocks, the lower one.
      let low = 0,
        high = list.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (list[mid]!.getBoundingClientRect().bottom > y) high = mid;
        else low = mid + 1;
      }
      const el = list[low];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        mode: b.dataset.mode ?? "",
        key:
          (b.dataset.mode === "pdf"
            ? el.dataset.pdfPage
            : el.dataset.byteStart) ?? "",
        top: r.top,
        ratio: (y - r.top) / Math.max(1, r.height),
        line: y,
        // The block's one-based PDF page (data-page); a PDF page is itself.
        page: el.dataset.page ?? el.dataset.pdfPage ?? null,
        regionTop: Number(el.dataset.region?.split(",")[1] ?? 0) / 1000,
        scrollTop: b.scrollTop,
      };
    },
    element: (mode: string, key: string) =>
      document.querySelector<HTMLElement>(
        mode === "pdf"
          ? `.reader-engine-body .reading-pdf-page[data-pdf-page="${key}"]`
          : `.reader-engine-body section[data-byte-start="${key}"]`,
      ),
    mark: () => (rs.marked = rs.anchor()),
    topOf: (a: Anchor | null) => {
      const el = a && rs.element(a.mode, a.key);
      return el ? el.getBoundingClientRect().top : null;
    },
    frame: () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => resolve(performance.now())),
      ),
    signature: () => {
      const b = rs.body();
      return JSON.stringify([
        b?.scrollTop,
        b?.scrollHeight,
        b?.clientWidth,
        b?.clientHeight,
        rs.topOf(rs.marked),
      ]);
    },
    /**
     * Spec 8.2 "still": no layout change for 200 ms, at most 2 s. Longer than
     * the reader's 80 ms relayout debounce, so a debounced relayout counts.
     * `ms` is when the layout last changed.
     */
    async still(limit = 2000) {
      const start = performance.now();
      let last = rs.signature(),
        changed = start,
        frames = 0;
      while (performance.now() - start < limit) {
        const t = await rs.frame();
        frames++;
        const now = rs.signature();
        if (now !== last) changed = t;
        last = now;
        if (t - changed >= 200)
          return { still: true, ms: changed - start, frames };
      }
      return { still: false, ms: changed - start, frames };
    },
    /** Spec 8.2 "has a picture": laid-out text, a drawn canvas or a skeleton in the content area. */
    content() {
      const surface = document.querySelector(".reader-surface");
      if (!surface) return false;
      const r = surface.getBoundingClientRect();
      for (const skeleton of surface.querySelectorAll(
        ".ui-skeleton, [class*='skeleton']",
      ))
        if (skeleton.getClientRects().length) return true;
      for (let i = 1; i <= 4; i++)
        for (let j = 1; j <= 4; j++) {
          const el = document.elementFromPoint(
            r.left + (r.width * i) / 5,
            r.top + ((r.height - 40) * j) / 5,
          );
          if (!el || !surface.contains(el)) continue;
          const page = el.closest<HTMLElement>(".reading-pdf-page");
          if (page) {
            const canvas = page.querySelector("canvas");
            if (canvas && canvas.width > 0 && page.dataset.rendered === "true")
              return true;
            const bitmap = page.querySelector("img");
            if (bitmap?.complete && bitmap.naturalWidth > 0) return true;
            // The page placeholder (skeleton colour), not a white sheet.
            const fill = getComputedStyle(page).backgroundColor;
            if (
              !canvas &&
              !["rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"].includes(fill)
            )
              return true;
            continue;
          }
          if (
            el.closest(
              "section[data-byte-start], .reading-document-title, .ui-empty, .reader-prose, .katex, img, .ui-skeleton",
            )
          )
            return true;
        }
      return false;
    },
    picture() {
      const b = rs.body();
      if (!b) return false;
      const box = b.getBoundingClientRect();
      return [...b.querySelectorAll<HTMLElement>(".reading-pdf-page")]
        .filter((p) => {
          const r = p.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        })
        .every((p) => {
          const canvas = p.querySelector("canvas"),
            bitmap = p.querySelector("img");
          return (
            (!!canvas && canvas.width > 0) ||
            (!!bitmap?.complete && bitmap.naturalWidth > 0)
          );
        });
    },
    /** The block at the reading line of the given view has been drawn. */
    painted(mode: string) {
      const b = rs.body();
      if (!b || b.dataset.mode !== mode) return false;
      const a = rs.anchor();
      if (!a) return false;
      const el = rs.element(a.mode, a.key);
      return mode === "pdf" ? el?.dataset.rendered === "true" : !!el;
    },
    /**
     * Visible PDF pages all drawn at the current size: the canvas box matches
     * its page and its pixels match that box (not stretched), optionally of a given width.
     */
    sharp(width) {
      const b = rs.body();
      if (!b) return false;
      const box = b.getBoundingClientRect();
      const visible = [
        ...b.querySelectorAll<HTMLElement>(".reading-pdf-page"),
      ].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      });
      return (
        visible.length > 0 &&
        visible.every((p) => {
          const canvas = p.querySelector("canvas");
          const box = p.getBoundingClientRect();
          return (
            (width === undefined || Math.abs(box.width - width) < 2) &&
            p.dataset.rendered === "true" &&
            !!canvas &&
            Math.abs(canvas.getBoundingClientRect().width - box.width) < 1 &&
            Math.abs(
              canvas.width -
                Math.ceil(box.width * Math.min(devicePixelRatio || 1, 2)),
            ) <= 2
          );
        })
      );
    },
    frames: [],
    sampling: false,
    sample(mode = "", width) {
      rs.frames = [];
      rs.sampling = true;
      const loop = (t: number) => {
        if (!rs.sampling) return;
        rs.frames.push({
          t,
          content: rs.content(),
          picture: mode === "pdf" ? rs.picture() : true,
          skeleton: !!document.querySelector(".reader-preparing"),
          painted: mode ? rs.painted(mode) : false,
          sharp: mode === "pdf" ? rs.sharp(width) : false,
          animations: document.getAnimations().flatMap((a) => {
            const css = a as Animation & {
              transitionProperty?: string;
              animationName?: string;
            };
            if (css.transitionProperty)
              return [`transition:${css.transitionProperty}`];
            const keyframes =
              a.effect && "getKeyframes" in a.effect
                ? (a.effect as KeyframeEffect).getKeyframes()
                : [];
            const properties = new Set(
              keyframes.flatMap((k) =>
                Object.keys(k).filter(
                  (p) =>
                    ![
                      "offset",
                      "easing",
                      "composite",
                      "computedOffset",
                    ].includes(p),
                ),
              ),
            );
            return [
              `${css.animationName ? `animation:${css.animationName}` : "animate"}:${[...properties].join("+")}`,
            ];
          }),
        });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    stop() {
      rs.sampling = false;
      return rs.frames;
    },
    async until(test: () => boolean, limit = 25_000) {
      const start = performance.now();
      while (performance.now() - start < limit) {
        if (test()) return performance.now();
        await rs.frame();
      }
      return null;
    },
    open(url: string) {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    },
  };
  // The input event that starts a change: the press or key that triggered it.
  for (const type of ["pointerdown", "keydown"])
    addEventListener(type, (event) => (rs.inputAt = event.timeStamp), true);
  // Long main-thread tasks, to see where a cold open waits.
  const longTasks: { start: number; ms: number }[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        longTasks.push({
          start: Math.round(e.startTime),
          ms: Math.round(e.duration),
        });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // Not every browser reports long tasks.
  }
  Object.assign(window, { __longTasks: longTasks });
  // The first drawn PDF page, timed from navigation start.
  const observer = new MutationObserver(() => {
    if (document.querySelector('.reading-pdf-page[data-rendered="true"]')) {
      rs.firstRendered = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-rendered"],
  });
  // Evaluate callbacks run in the page, where `rs()` is this global.
  Object.assign(window, { __rs: rs, rs: () => rs });
}
/** Typing only: page callbacks call the page's global `rs()` (installHelpers). */
declare const rs: () => Helpers;
type Probe = {
  engines: Record<string, number>;
  pdfRequests: Record<string, number>;
  pdfHashes: Record<string, number>;
  workersStarted: number;
  workersTerminated: number;
  workersPeak: number;
  canvasesCreated: number;
  canvasesReleased: number;
  canvasesPeak: number;
  objectUrlsCreated: number;
  objectUrlsRevoked: number;
  bitmapsCreated?: number;
  bitmapsReleased?: number;
  bitmapsPerPaperPeak?: number;
  bitmapBytesPerPaperPeak?: number;
};
const probe = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __sciretrieverReaderProbe?: Probe })
        .__sciretrieverReaderProbe ?? null,
  );
const engines = (p: Probe | null) =>
  Object.values(p?.engines ?? {}).reduce((sum, n) => sum + n, 0);

async function openReader(
  path: string,
  options: {
    width?: number;
    height?: number;
    reducedMotion?: "reduce" | "no-preference";
    /** Records a performance trace from navigation on; `profile` returns it. */
    profile?: boolean;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    reducedMotion: options.reducedMotion ?? "no-preference",
    serviceWorkers: "block",
    locale: "zh-CN",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const cleanup = designSamplePageCleanup(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === samples.origin)
      return route.continue();
    errors.push(`blocked ${route.request().url()}`);
    await route.abort("blockedbyclient");
  });
  await loginWorkbenchPage(page, samples.origin, password);
  await page.addInitScript(() => localStorage.clear());
  await page.addInitScript(installHelpers);
  // A performance trace (layout, style, scripts), as the browser's performance panel records it.
  if (options.profile)
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        // Which script forced each layout.
        "disabled-by-default-devtools.timeline.stack",
        "blink.user_timing",
        "loading",
      ],
    });
  await page.goto(samples.origin + path, { waitUntil: "domcontentloaded" });
  return {
    page,
    errors,
    profile: async () => (options.profile ? await browser.stopTracing() : null),
    close: async () => {
      try {
        await cleanup();
      } finally {
        await context.close();
      }
    },
  };
}
const readerUrl = (id: string, mode: "pdf" | "doc") =>
  `/?literature=${id}&reader=${mode}`;
const ready = (page: Page, id: string, mode: "pdf" | "doc") =>
  page
    .locator(
      `.reader-engine-body[data-literature-id="${id}"][data-mode="${mode}"] ${mode === "pdf" ? '.reading-pdf-page[data-rendered="true"]' : "section[data-byte-start]"}`,
    )
    .first()
    .waitFor();
const still = (page: Page) => page.evaluate(() => rs().still());
const mark = (page: Page) => page.evaluate(() => rs().mark());
const topOf = (page: Page, anchor: Anchor | null) =>
  page.evaluate((a) => rs().topOf(a), anchor);
async function scrollReader(page: Page, top: number) {
  await page.evaluate((value) => {
    rs().body()!.scrollTop = value;
  }, top);
  await still(page);
  await still(page);
}
/** Anchor movement across one change: the marked block's top before and after it settles. */
async function anchorMove(page: Page, change: () => Promise<void>) {
  const before = await mark(page);
  await change();
  const settled = await still(page);
  const after = await topOf(page, before);
  return {
    block: before ? `${before.mode}:${before.key}` : null,
    before: before?.top ?? null,
    after,
    move: before && after !== null ? Math.abs(after - before.top) : null,
    still: settled.still,
    settle_ms: Math.round(settled.ms),
  };
}
const within = (move: number | null, limit: number) =>
  move !== null && move <= limit;
async function pick(page: Page, field: RegExp | string, option: string) {
  await page.getByRole("button", { name: field }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
const viewTab = (page: Page, name: "PDF" | "全文") =>
  page.getByRole("tab", { name, exact: true });
/** Switch the view with per-frame sampling: blank frames and input-to-paint time. */
async function sampledSwitch(page: Page, id: string, to: "pdf" | "doc") {
  await page.evaluate((mode) => rs().sample(mode), to);
  await viewTab(page, to === "pdf" ? "PDF" : "全文").click();
  await ready(page, id, to);
  await still(page);
  const [frames, input] = await page.evaluate(
    () => [rs().stop(), rs().inputAt] as const,
  );
  return frameSummary(frames, input);
}
function frameSummary(frames: Frame[], input: number) {
  const after = frames.filter((f) => f.t >= input);
  let longestBlank = 0,
    longestGap = 0,
    blankSince: number | null = null;
  for (const [i, f] of after.entries()) {
    if (i) longestGap = Math.max(longestGap, f.t - after[i - 1]!.t);
    if (!f.content) blankSince ??= f.t;
    else if (blankSince !== null) {
      longestBlank = Math.max(longestBlank, f.t - blankSince);
      blankSince = null;
    }
  }
  if (blankSince !== null)
    longestBlank = Math.max(longestBlank, after.at(-1)!.t - blankSince);
  const painted = after.find((f) => f.painted);
  const sharp = after.find((f) => f.sharp);
  return {
    frames: after.length,
    blank_frames: after.filter((f) => !f.content).length,
    frames_without_picture: after.filter((f) => !f.picture).length,
    longest_blank_ms: Math.round(longestBlank),
    longest_frame_gap_ms: Math.round(longestGap),
    first_frame_has_picture: after[0]?.content ?? null,
    first_frame_pages_pictured: after[0]?.picture ?? null,
    skeleton_frames: after.filter((f) => f.skeleton).length,
    // Spec 6.2: content ready within 300 ms never shows the skeleton.
    first_skeleton_ms: (() => {
      const f = after.find((f) => f.skeleton);
      return f ? Math.round(f.t - input) : null;
    })(),
    input_to_paint_ms: painted ? Math.round(painted.t - input) : null,
    input_to_sharp_ms: sharp ? Math.round(sharp.t - input) : null,
  };
}

it("keeps the counters out of the production bundle and in the test build", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sciretriever-reader-production-"),
  );
  const names = [
    "__sciretrieverReaderProbe",
    "pdfRequests",
    "pdfHashes",
    "workersStarted",
    "canvasesCreated",
    "objectUrlsCreated",
  ];
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { buildReactAssets } from './scripts/build-react-assets.mjs'; await buildReactAssets(process.argv[1]);",
        directory,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const files = (await readdir(join(directory, "assets"))).filter((f) =>
      f.endsWith(".js"),
    );
    expect(files.length).toBeGreaterThan(0);
    const production = (
      await Promise.all(
        files.map((f) => readFile(join(directory, "assets", f), "utf8")),
      )
    ).join("\n");
    for (const name of names) expect(production, name).not.toContain(name);
    // The served test build does carry them, so the absence above is meaningful.
    for (const name of names) expect(servedScripts, name).toContain(name);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("anchor keeping (4.2)", async () => {
  const criterion = "锚点移动 ≤ 2 px；字号 20 → 24 → 20 往返后 ≤ 2 px";
  const items: Item[] = [];
  const id = samples.ids.longDocument;
  const r = await openReader(readerUrl(id, "doc"));
  try {
    await ready(r.page, id, "doc");
    await scrollReader(r.page, 6000);
    const start = await mark(r.page);
    const up = await anchorMove(r.page, () =>
      pick(r.page, /阅读字号/, "24 px"),
    );
    const down = await anchorMove(r.page, () =>
      pick(r.page, /阅读字号/, "20 px"),
    );
    const after = await topOf(r.page, start);
    const round = start && after !== null ? Math.abs(after - start.top) : null;
    items.push(
      {
        id: "font-size",
        label: "改字号 20 → 24",
        criterion: "≤ 2 px",
        status: verdict(within(up.move, 2)),
        numbers: up,
      },
      {
        id: "font-size-back",
        label: "改字号 24 → 20",
        criterion: "≤ 2 px",
        status: verdict(within(down.move, 2)),
        numbers: down,
      },
      {
        id: "font-size-round-trip",
        label: "字号 20 → 24 → 20 往返",
        criterion: "≤ 2 px",
        status: verdict(within(round, 2)),
        numbers: { move: round },
      },
    );
    for (const [key, label, toggle] of [
      [
        "information",
        "收起、打开信息栏",
        (n: number) =>
          r.page
            .getByRole("button", {
              name: n ? "显示信息" : "收起信息",
              exact: true,
            })
            .click(),
      ],
      [
        "find",
        "打开、关闭查找栏",
        // The same button opens and closes the find bar.
        () =>
          r.page
            .getByRole("button", { name: "文档内查找", exact: true })
            .click(),
      ],
      [
        "resize",
        "改变窗口大小 1440 → 1200 → 1440",
        (n: number) =>
          r.page.setViewportSize({ width: n ? 1440 : 1200, height: 900 }),
      ],
    ] as const) {
      const first = await anchorMove(r.page, () => toggle(0));
      const second = await anchorMove(r.page, () => toggle(1));
      const move = Math.max(first.move ?? Infinity, second.move ?? Infinity);
      items.push({
        id: `doc-${key}`,
        label: `原文 · ${label}`,
        criterion: "≤ 2 px",
        status: verdict(within(move, 2)),
        numbers: { first, second },
      });
    }
  } finally {
    await r.close();
  }
  // Images: the figure above the reading line decodes while the reader is still.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const image = await openReader(readerUrl(id, "doc"));
  try {
    await image.page.route(
      (url) => url.pathname === "/api/v1/query/document-resource-bytes",
      async (route) => {
        await gate;
        await route.continue().catch(() => undefined);
      },
    );
    await ready(image.page, id, "doc");
    await image.page.evaluate(() => {
      const b = rs().body()!;
      const figure = b.querySelector<HTMLElement>("[data-resource]")!;
      const line = rs().line(b);
      b.scrollTop += figure.getBoundingClientRect().bottom - (line - 80);
    });
    await still(image.page);
    await image.page
      .locator("[data-resource][aria-busy='true']")
      .first()
      .waitFor();
    const move = await anchorMove(image.page, async () => {
      release();
      await image.page
        .locator(".reader-engine-body [data-resource] img")
        .first()
        .waitFor();
    });
    items.push({
      id: "image-load",
      label: "原文 · 图片在阅读线上方载入",
      criterion: "≤ 2 px",
      status: verdict(within(move.move, 2)),
      numbers: move,
    });
  } finally {
    release();
    await image.close();
  }
  // Batches: the next part of the long text arrives below the reading line.
  let more!: () => void;
  const held = new Promise<void>((resolve) => (more = resolve));
  const batch = await openReader(readerUrl(id, "doc"));
  try {
    await ready(batch.page, id, "doc");
    await still(batch.page);
    let holding = false;
    await batch.page.route(
      (url) => url.pathname === "/api/v1/query/document-slice",
      async (route) => {
        holding = true;
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    const count = () =>
      batch.page
        .locator(".reader-engine-body section[data-byte-start]")
        .count();
    // Near the end of what is loaded, so the reader asks for the next part.
    await batch.page.evaluate(() => {
      const b = rs().body()!;
      b.scrollTop = b.scrollHeight - b.clientHeight * 2;
    });
    await expect.poll(() => holding, { timeout: TIMEOUT }).toBe(true);
    await still(batch.page);
    const before = await count();
    const move = await anchorMove(batch.page, async () => {
      more();
      await expect.poll(count, { timeout: TIMEOUT }).toBeGreaterThan(before);
    });
    items.push({
      id: "continuation",
      label: "原文 · 长文档续载（下一批在阅读线下方载入）",
      criterion: "≤ 2 px",
      status: verdict(within(move.move, 2)),
      numbers: { ...move, blocks_before: before, blocks_after: await count() },
    });
  } finally {
    more();
    await batch.close();
  }
  const pdfId = samples.ids.pdfOnly;
  const pdf = await openReader(readerUrl(pdfId, "pdf"));
  try {
    await ready(pdf.page, pdfId, "pdf");
    await scrollReader(pdf.page, 4000);
    for (const [key, label, toggle] of [
      [
        "information",
        "收起、打开信息栏",
        (n: number) =>
          pdf.page
            .getByRole("button", {
              name: n ? "显示信息" : "收起信息",
              exact: true,
            })
            .click(),
      ],
      [
        "resize",
        "改变窗口大小 1440 → 1200 → 1440",
        (n: number) =>
          pdf.page.setViewportSize({ width: n ? 1440 : 1200, height: 900 }),
      ],
    ] as const) {
      const first = await anchorMove(pdf.page, () => toggle(0));
      const second = await anchorMove(pdf.page, () => toggle(1));
      const move = Math.max(first.move ?? Infinity, second.move ?? Infinity);
      items.push({
        id: `pdf-${key}`,
        label: `PDF · ${label}`,
        criterion: "≤ 2 px",
        status: verdict(within(move, 2)),
        numbers: { first, second },
      });
    }
  } finally {
    await pdf.close();
  }
  items.push(
    {
      id: "view-switch",
      label: "切换视图",
      criterion: "见“视图之间的位置”",
      status: "no-object",
      numbers: {},
      note: "由“视图之间的位置”一项测量。",
    },
    {
      id: "background",
      label: "后台数据刷新",
      criterion: "见“后台刷新”",
      status: "no-object",
      numbers: {},
      note: "由“后台刷新”一项测量。",
    },
    noObject("dock", "打开、关闭、停靠或浮起侧栏（停靠与浮起）", "≤ 2 px"),
    noObject("lens", "打开或关闭镜头", "≤ 2 px"),
    noObject("focus", "进入或退出专注模式", "≤ 2 px"),
    noObject("annotation", "锚点上方的批注展开或收起", "≤ 2 px"),
  );
  await record("anchor", "锚点保持", criterion, items);
}, 240_000);

it("position shared between views (4.3)", async () => {
  const id = samples.ids.longDocument;
  const r = await openReader(readerUrl(id, "doc"));
  const items: Item[] = [];
  try {
    await ready(r.page, id, "doc");
    // Read on into the second PDF page's text, so the place in the PDF is reachable.
    for (let n = 0; n < 120; n++) {
      const page = await r.page.evaluate(() => rs().anchor()?.page ?? null);
      if (page && Number(page) >= 2) break;
      await r.page.evaluate(() => {
        const b = rs().body()!;
        b.scrollTop += b.clientHeight * 6;
      });
      await still(r.page);
    }
    await still(r.page);
    const start = await mark(r.page);
    const toPdf = await sampledSwitch(r.page, id, "pdf");
    const landed = await r.page.evaluate(
      ({ page, regionTop }) => {
        const h = rs();
        const a = h.anchor();
        const b = h.body()!;
        const line = h.line(b);
        const target = page
          ? b.querySelector<HTMLElement>(
              `.reading-pdf-page[data-pdf-page="${page}"]`,
            )
          : null;
        const box = target?.getBoundingClientRect();
        const offset = box ? box.top + regionTop * box.height - line : null;
        return {
          pdf_page_at_line: a?.key ?? null,
          expected_page: page,
          // The block cannot reach the line when the scroll is already at its end.
          clamped:
            offset !== null &&
            ((offset < 0 && b.scrollTop <= 0) ||
              (offset > 0 &&
                b.scrollTop >= b.scrollHeight - b.clientHeight - 1)),
          // The corresponding block's top: its page's top plus its region's top.
          expected_top_minus_line: box
            ? Math.round(box.top + regionTop * box.height - line)
            : null,
        };
      },
      { page: start?.page ?? null, regionTop: start?.regionTop ?? 0 },
    );
    const toDoc = await sampledSwitch(r.page, id, "doc");
    const after = await topOf(r.page, start);
    const round = start && after !== null ? Math.abs(after - start.top) : null;
    shared.viewSwitch = { doc_to_pdf: toPdf, pdf_to_doc: toDoc };
    const offset = landed.expected_top_minus_line;
    items.push(
      {
        id: "doc-to-pdf",
        label: "原文 → PDF",
        criterion: "对应块的顶边落在阅读线 ±24 px 内",
        status: verdict(
          offset !== null && (Math.abs(offset) <= 24 || landed.clamped),
        ),
        numbers: { from_block: start ? `${start.key}` : null, ...landed },
        note: "对应块的顶边 = 段落的页（data-page）的顶边 + 区域上沿（data-region）。02 基线时 data-page 比实际页大 1（04 块已修）。",
      },
      {
        id: "doc-pdf-doc",
        label: "原文 → PDF → 原文 往返（第一次交付：PDF 与全文共用位置）",
        criterion: "≤ 2 px",
        status: verdict(within(round, 2)),
        numbers: {
          block: start?.key ?? null,
          before: start?.top ?? null,
          after,
          move: round,
        },
      },
      noObject("doc-flow-doc", "原文 → 脉络 → 原文 往返", "≤ 2 px"),
    );
  } finally {
    await r.close();
  }
  await record(
    "views",
    "视图之间的位置",
    "原文 → PDF：对应块顶边在阅读线 ±24 px 内；原文 → 脉络 → 原文往返 ≤ 2 px",
    items,
  );
}, 120_000);

it("PDF zoom (5.3)", async () => {
  const id = samples.ids.pdfOnly;
  const r = await openReader(readerUrl(id, "pdf"));
  try {
    await ready(r.page, id, "pdf");
    await scrollReader(r.page, 4000);
    await r.page.getByRole("button", { name: "PDF 缩放" }).click();
    // The synthetic pages are 612 pt wide: 918 px at 150%.
    await r.page.evaluate(() => rs().sample("pdf", 918));
    await r.page.getByRole("option", { name: "150%", exact: true }).click();
    await r.page.waitForFunction(() => rs().sharp(918), undefined, {
      timeout: TIMEOUT,
    });
    await still(r.page);
    const [frames, input] = await r.page.evaluate(
      () => [rs().stop(), rs().inputAt] as const,
    );
    const summary = frameSummary(frames, input);
    shared.zoom = summary;
    const counters = await probe(r.page);
    const memory = {
      canvases_peak_live: counters?.canvasesPeak ?? null,
      bitmaps_peak: counters?.bitmapsPerPaperPeak ?? null,
      bitmap_bytes_peak: counters?.bitmapBytesPerPaperPeak ?? null,
    };
    await record(
      "zoom",
      "PDF 缩放",
      "缩放后的第一帧可见页都有画面；可见页清晰画面 500 ms 内替换完毕",
      [
        {
          id: "first-frame",
          label: "缩放后的第一帧有画面",
          criterion: "第一帧可见页都有画面（拉伸的旧画面）",
          status: verdict(
            summary.first_frame_pages_pictured === true &&
              summary.frames_without_picture === 0 &&
              summary.blank_frames === 0,
          ),
          numbers: summary,
        },
        {
          id: "sharp",
          label: "清晰画面替换完毕",
          criterion: "≤ 500 ms",
          status: verdict(
            summary.input_to_sharp_ms !== null &&
              summary.input_to_sharp_ms <= 500,
          ),
          numbers: { input_to_sharp_ms: summary.input_to_sharp_ms },
        },
        {
          id: "memory",
          label: "画布与位图的峰值（参考）",
          criterion:
            "画布：可见页 ±1 各至多两张；位图：每份资料 ≤ 40 页、48 MB",
          status: verdict(
            (memory.bitmaps_peak ?? 0) <= 40 &&
              (memory.bitmap_bytes_peak ?? 0) <= 48 * 1024 * 1024,
          ),
          numbers: memory,
        },
      ],
    );
  } finally {
    await r.close();
  }
}, 120_000);

it("no blank frames (6.2)", async () => {
  const items: Item[] = [];
  const views = shared.viewSwitch as
    | Record<string, ReturnType<typeof frameSummary>>
    | undefined;
  // Spec 6.2: the old picture until the new one, the skeleton only past 300 ms.
  const early = (s: ReturnType<typeof frameSummary>) =>
    s.first_skeleton_ms === null || s.first_skeleton_ms >= 250;
  for (const [key, label] of [
    ["doc_to_pdf", "切换视图 原文 → PDF"],
    ["pdf_to_doc", "切换视图 PDF → 原文"],
  ] as const) {
    const s = views?.[key];
    items.push({
      id: key,
      label,
      criterion: "0 个无画面帧；骨架不早于 300 ms 出现",
      status: verdict(s ? s.blank_frames === 0 && early(s) : null),
      numbers: s ?? {},
    });
  }
  const zoom = shared.zoom as ReturnType<typeof frameSummary> | undefined;
  items.push({
    id: "zoom",
    label: "PDF 缩放 适宽 → 150%",
    criterion: "0 个无画面帧；可见页不退回占位（5.3：任何时候都不先清空画面）",
    status: verdict(
      zoom
        ? zoom.blank_frames === 0 && zoom.frames_without_picture === 0
        : null,
    ),
    numbers: zoom ?? {},
  });
  // Fast scrolling through the 100-page PDF and back over the same pages (5.3).
  const pdfId = samples.ids.pdfOnly;
  const scroller = await openReader(readerUrl(pdfId, "pdf"));
  try {
    await ready(scroller.page, pdfId, "pdf");
    await still(scroller.page);
    const pass = async (step: number, frames: number) => {
      await scroller.page.evaluate(() => rs().sample("pdf"));
      const input = await scroller.page.evaluate(
        async ({ step, frames }) => {
          const h = rs(),
            b = h.body()!,
            start = performance.now();
          for (let n = 0; n < frames; n++) {
            b.scrollTop += step * b.clientHeight;
            await h.frame();
          }
          return start;
        },
        { step, frames },
      );
      await still(scroller.page);
      const shown = await scroller.page.evaluate(() => {
        const b = rs().body()!;
        return {
          bitmaps: b.querySelectorAll(".reading-pdf-page > img").length,
          canvases: b.querySelectorAll(".reading-pdf-page canvas").length,
        };
      });
      const sampled = await scroller.page.evaluate(() => rs().stop());
      return { ...frameSummary(sampled, input), ...shown };
    };
    // Down 40 screens in 40 frames, then back up the same way.
    const down = await pass(1, 40);
    const up = await pass(-1, 40);
    const counters = await probe(scroller.page);
    items.push({
      id: "scroll",
      label: "快速滚动 PDF（向下 40 屏再回到原处）",
      criterion: "0 个无画面帧（画面、位图或页面占位）",
      status: verdict(down.blank_frames === 0 && up.blank_frames === 0),
      numbers: {
        down,
        up,
        bitmaps_peak: counters?.bitmapsPerPaperPeak ?? null,
        bitmap_bytes_peak: counters?.bitmapBytesPerPaperPeak ?? null,
      },
      note: "向上一程经过的页刚离开渲染范围，应以低清晰度位图显示；frames_without_picture 记录仍显示占位的帧。",
    });
  } finally {
    await scroller.close();
  }
  // Tab switch between two open papers.
  const first = samples.ids.literature,
    second = samples.ids.longDocument;
  const r = await openReader(readerUrl(first, "pdf"));
  try {
    await ready(r.page, first, "pdf");
    await r.page.evaluate((url) => rs().open(url), readerUrl(second, "pdf"));
    await ready(r.page, second, "pdf");
    await still(r.page);
    await r.page.evaluate(() => rs().sample("pdf"));
    await r.page.locator(".paper-tab").first().click();
    await ready(r.page, first, "pdf");
    await still(r.page);
    const [frames, input] = await r.page.evaluate(
      () => [rs().stop(), rs().inputAt] as const,
    );
    const s = frameSummary(frames, input);
    shared.tabSwitch = s;
    items.push({
      id: "tab-switch",
      label: "切换标签页（两份资料）",
      criterion: "0 个无画面帧；骨架不早于 300 ms 出现",
      status: verdict(s.blank_frames === 0 && early(s)),
      numbers: s,
    });
  } finally {
    await r.close();
  }
  await record(
    "blank",
    "不出现空白画面",
    "视图切换、标签页切换、PDF 缩放期间逐帧采样，纸页上没有一帧既无文字、无画面也无骨架",
    items,
  );
}, 120_000);

it("no repeated downloads (5.1)", async () => {
  const papers = [samples.ids.literature, samples.ids.longDocument];
  const r = await openReader(readerUrl(papers[0]!, "pdf"));
  try {
    await ready(r.page, papers[0]!, "pdf");
    await r.page.evaluate(
      (url) => rs().open(url),
      readerUrl(papers[1]!, "pdf"),
    );
    await ready(r.page, papers[1]!, "pdf");
    let peakCanvases = 0;
    for (let n = 0; n < 10; n++) {
      const index = n % 2;
      await r.page.locator(".paper-tab").nth(index).click();
      await ready(r.page, papers[index]!, "pdf");
    }
    // The tab loop ends on the long document; switch its views ten times.
    for (let n = 0; n < 10; n++) {
      const to = n % 2 ? "pdf" : "doc";
      await viewTab(r.page, to === "pdf" ? "PDF" : "全文").click();
      await ready(r.page, papers[1]!, to);
      peakCanvases = Math.max(
        peakCanvases,
        await r.page.locator(".reading-pdf-page canvas").count(),
      );
    }
    const during = await probe(r.page);
    while (await r.page.getByRole("button", { name: /^关闭文献 / }).count())
      await r.page
        .getByRole("button", { name: /^关闭文献 / })
        .first()
        .click();
    await r.page.waitForFunction(
      () => !document.querySelector(".reader-engine-body .reading-pdf-page"),
    );
    await still(r.page);
    const closed = await probe(r.page);
    if (!during || !closed)
      throw new Error("The reader test build exposes no counters");
    const max = (m: Record<string, number>) => Math.max(0, ...Object.values(m));
    await record(
      "downloads",
      "不重复下载",
      "每个 PDF 资产只请求一次，sha256 只计算一次；worker 同时不超过两个；关闭全部标签页后 worker 与对象 URL 为 0",
      [
        {
          id: "requests",
          label: "每个 PDF 资产的请求次数",
          criterion: "每个资产 1 次",
          status: verdict(max(during.pdfRequests) <= 1),
          numbers: { per_asset: during.pdfRequests },
        },
        {
          id: "sha256",
          label: "每个 PDF 资产的 sha256 计算次数",
          criterion: "每个资产 1 次",
          status: verdict(max(during.pdfHashes) <= 1),
          numbers: { per_asset: during.pdfHashes },
        },
        {
          id: "engines",
          label: "引擎构建次数（参考）",
          criterion: "切换视图与标签页不重建引擎",
          status: verdict(engines(during) <= papers.length),
          numbers: { engines: during.engines, total: engines(during) },
        },
        {
          id: "workers",
          label: "PDF worker 同时存在的最大数",
          criterion: "≤ 2",
          status: verdict(during.workersPeak <= 2),
          numbers: {
            peak: during.workersPeak,
            started: during.workersStarted,
            terminated: during.workersTerminated,
          },
        },
        {
          id: "canvases",
          label: "画布（参考）",
          criterion: "可见页及前后各一页",
          status: "pass",
          numbers: {
            peak_live: during.canvasesPeak,
            peak_in_dom: peakCanvases,
            created: during.canvasesCreated,
            released: during.canvasesReleased,
          },
        },
        {
          id: "closed",
          label: "关闭全部标签页后",
          criterion: "worker 0，对象 URL 0",
          status: verdict(
            closed.workersStarted - closed.workersTerminated === 0 &&
              closed.objectUrlsCreated - closed.objectUrlsRevoked === 0 &&
              (closed.bitmapsCreated ?? 0) - (closed.bitmapsReleased ?? 0) ===
                0,
          ),
          numbers: {
            workers: closed.workersStarted - closed.workersTerminated,
            object_urls: closed.objectUrlsCreated - closed.objectUrlsRevoked,
            canvases: closed.canvasesCreated - closed.canvasesReleased,
            bitmaps:
              (closed.bitmapsCreated ?? 0) - (closed.bitmapsReleased ?? 0),
          },
        },
      ],
    );
  } finally {
    await r.close();
  }
}, 240_000);

it("background refresh (5.2)", async () => {
  const app = samples.env.app;
  const id = samples.ids.longDocument;
  const asset = (await app.library.detail(id)).primary_pdf!.asset;
  const r = await openReader(readerUrl(id, "doc"));
  let polls = 0;
  r.page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/tasks") polls++;
  });
  const jobs: string[] = [];
  try {
    await ready(r.page, id, "doc");
    await scrollReader(r.page, 6000);
    const before = await probe(r.page);
    const start = await mark(r.page);
    // Every 5 s for 60 s: a task appears or ends, and the paper's metadata changes.
    for (let tick = 0; tick < 12; tick++) {
      if (tick % 2 === 0) {
        const job = await app.processingTasks!.submit({
          schema_version: 1,
          idempotency_key: `reader-smoothness-background-${tick}-${Date.now()}`,
          operations: [
            {
              operation: "parse-documents",
              request: {
                literature_id: id,
                asset_id: asset.asset_id,
                asset_sha256: asset.sha256,
                profiles: ["vlm-engine"],
                force: false,
              },
            },
          ],
        });
        jobs.push(job.job_id);
      } else await app.processingTasks!.control(jobs.at(-1)!, "cancel");
      const state = await app.metadataFields.read(id);
      await app.metadataFields.edit({
        literature_id: id,
        expected_revision: state.metadata_revision,
        set: [
          {
            field: "article_kind",
            value: tick % 2 ? "research-article" : "correction-or-editorial",
          },
        ],
        unlock: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await still(r.page);
    const after = await probe(r.page);
    const now = await r.page.evaluate(() => rs().body()!.scrollTop);
    const top = await topOf(r.page, start);
    const built = engines(after) - engines(before) + 1;
    const scroll = start ? Math.abs(now - start.scrollTop) : null;
    const move = start && top !== null ? Math.abs(top - start.top) : null;
    await record(
      "background",
      "后台刷新",
      "任务状态每 5 秒变化、持续 60 秒：阅读引擎只构建一次，滚动位置变化为 0",
      [
        {
          id: "engine",
          label: "阅读引擎构建次数",
          criterion: "1 次",
          status: verdict(built === 1),
          numbers: {
            builds: built,
            by_mode_after: after?.engines ?? null,
            task_polls: polls,
          },
        },
        {
          id: "scroll",
          label: "滚动位置变化",
          criterion: "0 px",
          status: verdict(scroll === 0),
          numbers: {
            before: start?.scrollTop ?? null,
            after: now,
            change: scroll,
          },
        },
        {
          id: "anchor",
          label: "锚点移动（4.2 后台数据刷新）",
          criterion: "≤ 2 px",
          status: verdict(within(move, 2)),
          numbers: { block: start?.key ?? null, move },
        },
      ],
    );
  } finally {
    for (const job of jobs)
      await app.processingTasks!.control(job, "cancel").catch(() => undefined);
    await r.close();
  }
}, 180_000);

it("transitions (6.1)", async () => {
  const items: Item[] = [];
  const views = shared.viewSwitch as
    | Record<string, ReturnType<typeof frameSummary>>
    | undefined;
  for (const [key, label] of [
    ["doc_to_pdf", "视图切换 原文 → PDF"],
    ["pdf_to_doc", "视图切换 PDF → 原文"],
  ] as const) {
    const ms = views?.[key]?.input_to_paint_ms ?? null;
    items.push({
      id: key,
      label,
      criterion: "≤ 200 ms（输入到目标视图锚点段落第一次绘制）",
      status: verdict(ms !== null && ms <= 200),
      numbers: { input_to_paint_ms: ms },
    });
  }
  const id = samples.ids.literature;
  for (const motion of ["no-preference", "reduce"] as const) {
    const r = await openReader(readerUrl(id, "doc"), { reducedMotion: motion });
    try {
      await ready(r.page, id, "doc");
      await still(r.page);
      const animations = new Set<string>();
      const panel = async (name: string) => {
        await r.page.evaluate(() => rs().sample());
        await r.page.getByRole("button", { name, exact: true }).click();
        // The panel's box per frame: a slide changes it over several frames.
        const settled = await r.page.evaluate(async () => {
          const h = rs();
          const box = () => {
            const r = document
              .querySelector(".reader-information")
              ?.getBoundingClientRect();
            return r ? `${Math.round(r.left)},${Math.round(r.width)}` : "none";
          };
          let last = box(),
            same = 0,
            changing = 0,
            changed = h.inputAt;
          while (same < 2 && performance.now() - h.inputAt < 2000) {
            const t = await h.frame();
            const now = box();
            if (now !== last) {
              changing++;
              changed = t;
            }
            same = now === last ? same + 1 : 0;
            last = now;
          }
          return {
            ms: Math.round(changed - h.inputAt),
            changing_frames: changing,
          };
        });
        for (const f of await r.page.evaluate(() => rs().stop()))
          for (const a of f.animations) animations.add(a);
        return settled;
      };
      const close = await panel("收起信息");
      const open = await panel("显示信息");
      await r.page.evaluate(() => rs().sample());
      await viewTab(r.page, "PDF").click();
      await ready(r.page, id, "pdf");
      await viewTab(r.page, "全文").click();
      await ready(r.page, id, "doc");
      for (const f of await r.page.evaluate(() => rs().stop()))
        for (const a of f.animations) animations.add(a);
      const list = [...animations];
      const moving = list.filter((a) =>
        /transform|translate|scale|rotate|clip-path|inset|left|top|width|height|margin/.test(
          a,
        ),
      );
      const colour = list.filter((a) =>
        /opacity|color|background|filter/.test(a),
      );
      if (motion === "no-preference")
        items.push({
          id: "side-panel",
          label: "信息栏收起、打开",
          criterion: "≤ 240 ms，从右侧滑入滑出",
          status: verdict(
            [close, open].every((m) => m.ms <= 240 && m.changing_frames >= 2),
          ),
          numbers: { close, open, animations: list },
          note: "要求信息栏的位置或宽度在多帧中逐步变化（滑动）并在 240 ms 内结束；一帧内跳变没有过渡，不算通过。",
        });
      else
        items.push({
          id: "reduced-motion",
          label: "减少动效",
          criterion: "没有位移与缩放的动画；颜色与透明度的过渡仍在",
          status: verdict(moving.length === 0 && colour.length > 0),
          numbers: { moving, colour, all: list },
        });
    } finally {
      await r.close();
    }
  }
  await record(
    "transitions",
    "过渡",
    "视图切换 ≤ 200 ms；侧栏 240 ms；减少动效时没有位移与缩放的动画，颜色过渡仍在",
    items,
  );
}, 180_000);

it("performance (100-page synthetic text PDF)", async () => {
  const id = samples.ids.pdfOnly;
  const profiling = process.env.SCIRETRIEVER_READER_PROFILE === "1";
  const r = await openReader(readerUrl(id, "pdf"), { profile: profiling });
  try {
    // Cold: a new browser context, from navigation start to the first drawn page.
    const cold = await r.page.evaluate(async () => {
      const h = rs();
      await h.until(() => h.firstRendered !== null);
      return h.firstRendered;
    });
    // SCIRETRIEVER_READER_PROFILE=1: the cold open's performance trace beside the report.
    const profile = await r.profile();
    if (profile)
      await writeFile(
        reportFile.replace(/\.json$/u, "-cold.trace.json"),
        profile,
      );
    // Where the cold open spends its time: navigation, requests and the reader's own marks.
    const coldParts = await r.page.evaluate(() => {
      const nav = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      const round = (n: number) => Math.round(n);
      const first = rs().firstRendered ?? Infinity;
      return {
        long_tasks: (
          window as unknown as { __longTasks: { start: number; ms: number }[] }
        ).__longTasks.filter((t) => t.start <= first),
        dom_content_loaded: nav ? round(nav.domContentLoadedEventEnd) : null,
        load: nav ? round(nav.loadEventEnd) : null,
        requests: (
          performance.getEntriesByType(
            "resource",
          ) as PerformanceResourceTiming[]
        )
          .filter((e) => e.startTime <= (rs().firstRendered ?? Infinity))
          .map((e) => {
            const u = new URL(e.name);
            return {
              path:
                u.pathname +
                (u.pathname.startsWith("/api") ? u.search.slice(0, 60) : ""),
              start: round(e.startTime),
              end: round(e.responseEnd),
            };
          }),
        marks: performance
          .getEntriesByType("measure")
          .concat(performance.getEntriesByType("mark"))
          .filter((e) => e.name.startsWith("sciretriever"))
          .map((e) => ({
            name: e.name,
            start: round(e.startTime),
            end: round(e.startTime + e.duration),
          })),
      };
    });
    await still(r.page);
    // Warm: leave for the library and come back in the same session.
    await r.page.evaluate(() => rs().open("/?view=lib"));
    await r.page.locator(".paper-row").first().waitFor();
    const warm = await r.page.evaluate(
      async (url) => {
        const h = rs();
        const start = performance.now();
        h.open(url);
        const end = await h.until(
          () =>
            !!document.querySelector('.reading-pdf-page[data-rendered="true"]'),
        );
        return end === null ? null : end - start;
      },
      readerUrl(id, "pdf"),
    );
    await still(r.page);
    const turn = await r.page.evaluate(async () => {
      const h = rs();
      const current = Number(h.anchor()?.key ?? 1);
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.getAttribute("aria-label") === "下一页")!;
      const start = performance.now();
      button.click();
      const end = await h.until(
        () =>
          document.querySelector<HTMLElement>(
            `.reading-pdf-page[data-pdf-page="${current + 1}"]`,
          )?.dataset.rendered === "true" &&
          h.anchor()?.key === String(current + 1),
      );
      return end === null ? null : end - start;
    });
    await r.page
      .getByRole("button", { name: "文档内查找", exact: true })
      .click();
    const search = r.page.getByRole("searchbox", {
      name: "文档内查找",
      exact: true,
    });
    await search.fill("page 60");
    await r.page.evaluate(() => rs().sample());
    await search.press("Enter");
    const find = await r.page.evaluate(async () => {
      const h = rs();
      const end = await h.until(
        () =>
          !!document.querySelector(".pdf-search-current") &&
          h.anchor()?.key === "60",
      );
      h.stop();
      return end === null ? null : end - h.inputAt;
    });
    const zoom =
      (shared.zoom as { input_to_sharp_ms?: number | null } | undefined)
        ?.input_to_sharp_ms ?? null;
    const ms = (n: number | null) => (n === null ? null : Math.round(n));
    await record(
      "performance",
      "性能",
      "100 页合成文本 PDF：冷开 ≤ 2 s，热开 ≤ 1 s；翻页、缩放、查找 ≤ 500 ms",
      [
        {
          id: "cold",
          label: "冷开（新的浏览器会话，导航开始到第一页画出）",
          criterion: "≤ 2000 ms",
          status: verdict(cold !== null && cold <= 2000),
          numbers: { ms: ms(cold), parts: coldParts },
        },
        {
          id: "warm",
          label: "热开（同一会话离开后再打开）",
          criterion: "≤ 1000 ms",
          status: verdict(warm !== null && warm <= 1000),
          numbers: { ms: ms(warm) },
        },
        {
          id: "page",
          label: "翻页（下一页画出并到达阅读线）",
          criterion: "≤ 500 ms",
          status: verdict(turn !== null && turn <= 500),
          numbers: { ms: ms(turn) },
        },
        {
          id: "zoom",
          label: "缩放（适宽 → 150%，可见页清晰）",
          criterion: "≤ 500 ms",
          status: verdict(zoom !== null && zoom <= 500),
          numbers: { ms: zoom },
        },
        {
          id: "find",
          label: "查找（第 60 页的命中到达阅读线）",
          criterion: "≤ 500 ms",
          status: verdict(find !== null && find <= 500),
          numbers: { ms: ms(find) },
        },
      ],
    );
  } finally {
    await r.close();
  }
}, 180_000);

it("checks of the second delivery are listed, not skipped", async () => {
  await record(
    "spine",
    "书脊",
    "位于纸页右边缘外 8 px；侧栏停靠时仍贴着纸页；窄窗口的悬停提示开向左侧且完整可见",
    [],
    true,
  );
  await record(
    "typography",
    "排版",
    "阅读区内只出现第 2.1 节表中的字号；作者文字用衬线体；--reader-check-fail 对比度 ≥ 4.5:1",
    [],
    true,
  );
  await record(
    "screenshots",
    "截图",
    "阅读页各视图在 1440×900、1024×768、390 宽度与两种主题下截图",
    [],
    true,
  );
  expect(report.checks.screenshots?.status).toBe("unimplemented");
});
