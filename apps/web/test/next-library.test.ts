import {
  openFilterConditions,
  openSavedViews,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  parseFolderNode,
  parseLiterature,
} from "@sciretriever/contracts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nextWorkspace } from "./next-workspace-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../server/src/workbench/synthetic-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import {
  finishIntake,
  startIntake,
} from "../../server/src/literature/intake.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";
import { readerToLibrary } from "./reader-controls.js";

it("paginates a 30,000-record library, bounds rendered rows, restores scroll and selection, and explains over-limit actions", async () => {
  const started = Date.now();
  const w = await nextWorkspace({
    setup: async (env) => {
      // This fixture measures reads/rendering, not 30,000 single-record commits.
      // Populate only its fresh synthetic catalog in one transaction, with the
      // same metadata hash and FTS columns used by the public writer.
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        db.exec(
          "PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON",
        );
        const meta = db.prepare(
          "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
        );
        const literature = db.prepare(
          "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?)",
        );
        const metadata = db.prepare(
          "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        const fts = db.prepare(
          "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,'','','','',?,?,?,?,?,'')",
        );
        for (let i = 0; i < 30000; i++) {
          const id = `00000000-0000-0000-0030-${String(i).padStart(12, "0")}`,
            mid = `00000000-0000-0000-0031-${String(i).padStart(12, "0")}`,
            m = {
              ...FIXTURE_LITERATURE.metadata,
              title: `Paper ${String(i).padStart(5, "0")}: &lt;i&gt;S&lt;/i&gt; &amp; spectra`,
              identifiers: [],
            };
          meta.run(mid, id);
          literature.run(id, mid, FIXTURE_LITERATURE.version_role);
          metadata.run(
            id,
            createHash("sha256").update(canonicalJsonBytes(m)).digest("hex"),
            m.title,
            m.abstract,
            m.publication_date,
            m.publication_year,
            m.publication_form,
            m.article_kind,
            m.language,
            m.venue,
            m.publisher,
            m.volume,
            m.issue,
            m.pages,
          );
          fts.run(
            id,
            m.title,
            m.abstract,
            m.venue,
            m.publisher,
            m.volume,
            m.issue,
            m.pages,
          );
        }
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
  });
  try {
    const p = w.page;
    await showAllLibraryStatuses(p);
    await expect
      .poll(() => p.locator(".library-list-heading").textContent())
      .toContain("30,002");
    expect(await p.locator(".library-list-heading").textContent()).toContain(
      "30,002",
    );
    // Over the 1,000-paper limit, running and exporting explain the limit instead of acting.
    await p.getByRole("button", { name: "批量操作", exact: true }).click();
    expect(await p.getByRole("menu").textContent()).toContain(
      "超过 1,000 篇上限",
    );
    expect(
      await p
        .getByRole("menuitem", { name: "运行算子…", exact: true })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await p.keyboard.press("Escape");
    await p.mouse.move(0, 0);
    expect(await p.locator(".paper-row").count()).toBeLessThan(30);
    const requests: string[] = [];
    p.on("request", (request) => {
      if (request.url().includes("/query/search")) requests.push(request.url());
    });
    // Observe a full set of SSE heartbeats without any catalog mutation.
    await p.waitForTimeout(1700);
    expect(requests).toHaveLength(0);
    // The library scrolls with the page; the shared main container owns scrollTop.
    const list = p.locator(".workspace-content");
    for (let i = 0; i < 3; i++) {
      await list.evaluate(async (el) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => p.locator(".library-list-heading").textContent(), {
          timeout: 20_000,
        })
        .toContain(`${100 + 50 * i} /`);
    }
    await list.evaluate((el) => {
      // Follow the rendered row height so the target stays inside the window.
      const row = el.querySelector(".paper-row")!.getBoundingClientRect();
      el.scrollTop = 40 * row.height;
    });
    // Await the requested scroll range, not an arbitrary row from the previous
    // range that is about to be recycled by the virtualizer.
    const title = "Paper 00040: S & spectra";
    const row = p.getByRole("article", { name: title, exact: true });
    const check = row.getByRole("checkbox");
    await check.focus();
    await check.press("Space");
    expect(await check.isChecked()).toBe(true);
    expect(
      await p
        .getByRole("checkbox", { name: "全选已加载", exact: true })
        .evaluate((el) => (el as HTMLInputElement).indeterminate),
    ).toBe(true);
    const before = await list.evaluate((el) => el.scrollTop);
    await row.locator(".paper-open").click();
    await p.locator(".reader-workspace").waitFor();
    await p.goBack();
    await list.waitFor();
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeCloseTo(before, -1);
    expect(
      await p
        .getByRole("checkbox", { name: `选择 ${title}`, exact: true })
        .isChecked(),
    ).toBe(true);
    // The scrolling benchmark starts after the preceding reader-to-library
    // transition finishes; route cleanup and steady scrolling are separate work.
    await p.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
    const profiling =
      output && process.env.SCIRETRIEVER_WEB_PROFILE === "1"
        ? await p.context().newCDPSession(p)
        : null;
    const trace: unknown[] = [];
    if (profiling) {
      profiling.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) =>
        trace.push(...value),
      );
      await profiling.send("Profiler.enable");
      await profiling.send("Profiler.start");
      await profiling.send("Tracing.start", {
        categories:
          "devtools.timeline,v8,disabled-by-default-devtools.timeline",
        transferMode: "ReportEvents",
      });
    }
    // Measure steady scrolling in already-loaded pages, excluding network/build startup.
    const timings = await list.evaluate(async (el) => {
      const entries: { start: number; duration: number; name: string }[] = [];
      const observer = new PerformanceObserver((list) =>
        entries.push(
          ...list.getEntries().map((entry) => ({
            start: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          })),
        ),
      );
      observer.observe({ type: "longtask" });
      for (let i = 0; i < 90; i++) {
        el.scrollTop = 4000 + i * 24;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      observer.disconnect();
      return {
        longTasks: entries,
        max: Math.max(0, ...entries.map((entry) => entry.duration)),
      };
    });
    if (profiling && output) {
      const { profile } = await profiling.send("Profiler.stop");
      const complete = new Promise<void>((resolve) =>
        profiling.once("Tracing.tracingComplete", () => resolve()),
      );
      await profiling.send("Tracing.end");
      await complete;
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, "library.cpuprofile"),
        JSON.stringify(profile),
      );
      await writeFile(
        join(output, "library-trace.json"),
        JSON.stringify({ traceEvents: trace }),
      );
      await profiling.detach();
    }
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, "library-performance.json"),
        JSON.stringify(
          {
            records: 30002,
            fixtureAndBootMs: Date.now() - started,
            renderedRows: await p.locator(".paper-row").count(),
            ...timings,
          },
          null,
          2,
        ),
      );
    }
    // The 50 ms plan benchmark is measured in an isolated run, not a new
    // environment-dependent global CI gate. Full always checks bounded DOM.
    if (process.env.SCIRETRIEVER_WEB_PERFORMANCE === "1")
      expect(timings.max).toBeLessThanOrEqual(50);
    expect(await p.locator(".paper-row").count()).toBeLessThan(30);
    await (await openSavedViews(p))
      .getByRole("menuitem", { name: "保存当前筛选…", exact: true })
      .click();
    const dialog = p.getByRole("dialog", { name: "保存筛选" });
    await dialog.getByRole("textbox", { name: "筛选名称" }).fill("My library");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    // Saved by the service (user organization 9.1): the dialog closes once it is.
    await dialog.waitFor({ state: "detached" });
    await p.reload();
    await (await openSavedViews(p))
      .getByRole("menuitem", { name: "My library", exact: true })
      .waitFor();
    await p.keyboard.press("Escape");
    await p.getByRole("searchbox", { name: "搜索文献" }).fill("Paper 00001");
    await expect
      .poll(() => p.locator(".library-list-heading").textContent())
      .toContain("1 / 共 1");
    await p.getByRole("button", { name: /移除搜索：Paper 00001/ }).click();
    await expect
      .poll(() => p.locator(".library-list-heading").textContent())
      .toContain("30,002");
    expect(w.errors).toEqual([]);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 180000);

it("opens a paper from its row in the view it has: remembered, else full text, PDF alone, or the bibliography with its panel (spec 6.4, 3.9)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  const openRow = async (title: string) => {
    // The reader page has no site sidebar: the library is in its navigation drawer.
    if (
      await w.page
        .getByRole("navigation", { name: "阅读标签", exact: true })
        .count()
    )
      await readerToLibrary(w.page);
    else
      await w.page
        .getByRole("navigation", { name: "工作区与阅读标签" })
        .getByRole("button", { name: "文献库", exact: true })
        .click();
    await w.page
      .getByRole("article", { name: title, exact: true })
      .locator(".paper-open")
      .click();
  };
  const view = () => new URL(w.page.url()).searchParams.get("reader");
  try {
    await w.page.goto(w.origin);
    await showAllLibraryStatuses(w.page);
    // Only a bibliography: the empty full text, the panel open on 信息, what is missing.
    await openRow("Unparsed source");
    await w.page
      .locator(".reader-surface .ui-empty")
      .getByText("这份资料只有书目信息。", { exact: true })
      .waitFor();
    expect(view()).toBe("doc");
    expect(await w.page.locator(".reader-information").isVisible()).toBe(true);
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    // A paper with text opens its full text.
    await openRow("Synthetic literature workbench");
    await w.page
      .locator(
        '.reader-view[data-view="doc"]:not([hidden]) section[data-byte-start]',
      )
      .first()
      .waitFor();
    expect(view()).toBe("doc");
    // Read in the PDF view, and the next open from the row comes back to it.
    await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
    await w.page
      .locator(
        '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    await openRow("Synthetic literature workbench");
    await expect.poll(view).toBe("pdf");
    await w.page
      .locator(
        '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("opens a PDF without text in the PDF view, and its full text says what is missing (spec 6.4, 3.9)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(3),
      });
    },
  });
  try {
    await w.page.goto(w.origin);
    await showAllLibraryStatuses(w.page);
    await w.page
      .getByRole("article", { name: "Unparsed source", exact: true })
      .locator(".paper-open")
      .click();
    await w.page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(new URL(w.page.url()).searchParams.get("reader")).toBe("pdf");
    await w.page.getByRole("tab", { name: "原文", exact: true }).click();
    const empty = w.page.locator(".reader-surface .ui-empty");
    await empty
      .getByText("这份资料还没有可读的文本。", { exact: true })
      .waitFor();
    // A secondary button: one primary per screen at most.
    expect(
      await empty
        .getByRole("button", { name: "生成全文", exact: true })
        .getAttribute("data-variant"),
    ).not.toBe("primary");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

const fullTextId = (n: number) =>
  `00000000-0000-0000-0019-${String(n).padStart(12, "0")}`;
/**
 * Papers for the full-text line: one in two versions (the preprint without
 * a PDF, the published version with one), an excluded paper with its PDF and
 * an exhausted one, beside the fixture's ready paper and its paper without a
 * PDF; a folder and an intake batch over some of them.
 */
async function seedFullText(w: Awaited<ReturnType<typeof nextWorkspace>>) {
  const id = fullTextId;
  const app = w.env.app;
  const paper = async (
    n: number,
    meta: number,
    title: string,
    patch: Record<string, unknown> = {},
  ) =>
    app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(n),
        meta_literature_id: id(meta),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title,
          identifiers: [],
        },
        ...patch,
      }),
    );
  // One paper in two versions: the preprint without a PDF, the published
  // version with one; an excluded paper with its PDF; an exhausted one.
  await paper(1, 101, "Full text two versions", { version_role: "preprint" });
  await paper(2, 101, "Full text two versions");
  await paper(3, 103, "Full text excluded", {
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Full text excluded",
      identifiers: [],
      article_kind: "correction-or-editorial",
    },
  });
  await paper(4, 104, "Full text exhausted");
  for (const n of [2, 3])
    await app.maintenance!.ingestPdf({
      literature_id: id(n),
      bytes: Buffer.from(workbenchPdf(`10.5555/full-text-${n}`)),
    });
  await app.database.setAutomaticPdfExhaustion(id(4));
  const folder = parseFolderNode(
    await app.folders.manage({
      operation: "create",
      request: { name: "全文范围" },
    }),
  ).folder_id;
  await app.folders.manage({
    operation: "add",
    request: { folder_id: folder, literature_ids: [id(2), id(4)] },
  });
  const batch = await startIntake(app.database, "topic", "全文批次", {}, "web");
  for (const n of [3, 4])
    await app.database.writeIntake({
      operation: "member",
      member: {
        batch_id: batch,
        literature_id: id(n),
        disposition: "matched",
      },
    });
  await finishIntake(app.database, batch, "completed");
  return { folder, batch };
}

it("shows the scope's full text by paper above the list, each number applying its quick filter, without fetching anything (page specs “文献库”)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const id = fullTextId;
    const { folder, batch } = await seedFullText(w);
    // Anything that would fetch, parse or spend.
    const started: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() !== "GET" &&
        (path.startsWith("/api/tasks") ||
          path.startsWith("/api/discovery") ||
          path.includes("acquire"))
      )
        started.push(path);
    });
    await page.reload();
    const line = page.getByLabel("全文取得情况");
    // Library: 5 papers of 6 versions; the fixture's ready paper, the two
    // versions and the excluded one have their full text.
    await expect
      .poll(() => line.textContent())
      .toBe("全文已取得 3 / 总数 5，未取得 2（其中自动途径已试完 1）");
    // The quick filters count versions, as the list does, in categories
    // that do not overlap: they add up to 全部 (page specs “界面用词”).
    const chip = (name: string) =>
      page
        .locator(".library-status-filters")
        .getByRole("button", { name: new RegExp(`^${name}`) });
    const quick = await page
      .locator(".library-status-filters .ui-filter")
      .allTextContents();
    await page.getByRole("button", { name: "更多状态", exact: true }).click();
    const more = await page.getByRole("menuitem").allTextContents();
    await page.keyboard.press("Escape");
    const number = (text: string) =>
      Number(text.replace(/^\D+/u, "").replace(/,/gu, ""));
    const all = quick.find((text) => text.startsWith("全部"))!;
    expect(
      [...quick.filter((text) => !text.startsWith("全部")), ...more]
        .map(number)
        .reduce((a, b) => a + b, 0),
    ).toBe(number(all));
    expect(quick.map((text) => text.replace(/ [\d,]+$/u, ""))).toEqual(
      expect.arrayContaining(["全部", "有全文", "有 PDF", "只有书目"]),
    );
    expect(more.map((text) => text.replace(/ [\d,]+$/u, ""))).toEqual(
      expect.arrayContaining(["没找到 PDF"]),
    );
    expect(number(all)).toBe(6);
    // Switching quick filters keeps the line as it is.
    await chip("有全文").click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(await line.textContent()).toBe(
      "全文已取得 3 / 总数 5，未取得 2（其中自动途径已试完 1）",
    );
    // “已取得” is “有 PDF”: whatever came after, excluded included.
    const rowIds = () =>
      page
        .locator(".paper-row")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-literature-id")).sort(),
        );
    await line.getByRole("button", { name: "已取得 3 篇" }).click();
    await expect
      .poll(rowIds)
      .toEqual([FIXTURE_LITERATURE.literature_id, id(2), id(3)].sort());
    const query = () =>
      JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}");
    expect(query()).toMatchObject({ has_primary_pdf: true, statuses: [] });
    // “未取得” is its complement, by version: the preprint is listed.
    await line.getByRole("button", { name: "未取得 2 篇" }).click();
    await expect.poll(rowIds).toEqual([missingId, id(1), id(4)].sort());
    expect(query().has_primary_pdf).toBe(false);
    await line.getByRole("button", { name: "已试完 1 篇" }).click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(query()).toMatchObject({ needs_manual_pdf: true });
    expect(query().has_primary_pdf).toBeUndefined();
    await line.getByRole("button", { name: "总数 5 篇" }).click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(6);
    // An intake batch narrows it to its papers.
    await page
      .getByRole("group", { name: "最近入库" })
      .getByRole("button", { name: /^全文批次/u })
      .click();
    await expect
      .poll(() => line.textContent())
      .toBe("全文已取得 1 / 总数 2，未取得 1（其中自动途径已试完 1）");
    expect(query().intake_batch_ids).toEqual([batch]);
    // A folder narrows it; a link there keeps the folder.
    await page
      .getByRole("group", { name: "文献文件夹", exact: true })
      .getByRole("button", { name: /^全文范围/u })
      .click();
    await expect
      .poll(() => line.textContent())
      .toBe("全文已取得 1 / 总数 2，未取得 1（其中自动途径已试完 1）");
    await line.getByRole("button", { name: "已取得 1 篇" }).click();
    await expect.poll(() => query().has_primary_pdf).toBe(true);
    expect(query().folder).toMatchObject({ id: folder });
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    // A search narrows it too; with nothing exhausted, no parentheses.
    await page
      .getByRole("searchbox", { name: "搜索文献" })
      .fill("Full text two versions");
    await expect
      .poll(() => line.textContent())
      .toBe("全文已取得 1 / 总数 1，未取得 0");
    expect(query()).toMatchObject({
      has_primary_pdf: true,
      folder: { id: folder },
    });
    // An empty scope has no line.
    await page
      .getByRole("searchbox", { name: "搜索文献" })
      .fill("nothing-at-all");
    await expect.poll(() => line.count()).toBe(0);
    expect(started).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows the full-text line for the whole library, an intake batch and a folder (plan 25 block 19 screenshots)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_FULLTEXT_SHOTS;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await seedFullText(w);
    await page.reload();
    const line = page.getByLabel("全文取得情况");
    const shot = (name: string) =>
      page.screenshot({ path: join(output, `${name}.png`) });
    await expect.poll(() => line.textContent()).toContain("总数 5");
    await shot("full-text-library");
    await page
      .getByRole("group", { name: "最近入库" })
      .getByRole("button", { name: /^全文批次/u })
      .click();
    await expect.poll(() => line.textContent()).toContain("总数 2");
    await page.locator(".paper-row").first().waitFor();
    await shot("full-text-batch");
    await page
      .getByRole("group", { name: "文献文件夹", exact: true })
      .getByRole("button", { name: /^全文范围/u })
      .click();
    await page.getByRole("heading", { name: "全文范围" }).waitFor();
    await expect.poll(() => line.textContent()).toContain("总数 2");
    await shot("full-text-folder");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("filters the papers whose bibliography is still to complete and marks their rows (literature materials 8.4)", async () => {
  const w = await nextWorkspace({
    setup: async (env) => {
      // The paper without a PDF was taken in without being recognized.
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        db.prepare(
          "INSERT INTO literature_needs_metadata VALUES(?,?,NULL)",
        ).run(missingId, "2026-11-17T00:00:00.000Z");
      } finally {
        db.close();
      }
    },
  });
  try {
    const page = w.page;
    const rows = page.locator(".paper-row");
    await expect.poll(() => rows.count()).toBe(2);
    // The mark ends the bibliography line, on that row only.
    const marked = page.locator(
      `.paper-row[data-literature-id="${missingId}"]`,
    );
    expect(await marked.locator(".paper-citation").textContent()).toMatch(
      / · 书目不全$/u,
    );
    expect(await page.locator(".paper-needs-metadata").count()).toBe(1);
    // The filter sends needs_metadata: true and keeps the other conditions.
    const searches: unknown[] = [];
    page.on("request", (request) => {
      if (
        ["/api/v1/query/search", "/api/library/search"].includes(
          new URL(request.url()).pathname,
        )
      )
        searches.push(request.postDataJSON());
    });
    await openFilterConditions(page);
    await page
      .locator(".library-filters")
      .getByText("书目不全", { exact: true })
      .click();
    expect(
      await page
        .getByRole("checkbox", { name: "书目不全", exact: true })
        .isChecked(),
    ).toBe(true);
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getAttribute("data-literature-id")).toBe(
      missingId,
    );
    const query = () =>
      JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}");
    expect(query().needs_metadata).toBe(true);
    expect(JSON.stringify(searches)).toContain('"needs_metadata":true');
    // Its condition reads as such and clears to no field at all.
    const chip = page
      .locator(".library-applied")
      .getByRole("button", { name: "书目不全：是", exact: true });
    await chip.waitFor();
    await chip.click();
    await expect.poll(() => rows.count()).toBe(2);
    expect(Object.hasOwn(query(), "needs_metadata")).toBe(false);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
