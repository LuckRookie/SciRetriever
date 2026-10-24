import {
  openSavedViews,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";
import { expect, it } from "vitest";
import { canonicalJsonBytes } from "@sciretriever/contracts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

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
    await p.getByRole("button", { name: "用当前结果", exact: true }).click();
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
          timeout: 5000,
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
