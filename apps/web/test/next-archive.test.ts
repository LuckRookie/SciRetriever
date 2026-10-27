import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import type { Page } from "playwright";
import {
  libraryStatus,
  nextWorkspace,
  runFromSnapshot,
} from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { topicDraft } from "../../server/test/tag-fixture.js";
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
it("keeps manual parsing separate from archiving, then exposes ready state and metadata locks", async () => {
  const w = await nextWorkspace({
    setup: async (e) => {
      await e.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: workbenchPdf("10.1000/unparsed"),
      });
    },
  });
  try {
    const p = w.page;
    await libraryStatus(p, "有 PDF");
    await p.getByRole("checkbox", { name: "全选已加载", exact: true }).focus();
    await p.keyboard.press("Space");
    const initial = w.env.parseCalls;
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "更多", exact: true })
      .click();
    await p.getByRole("menuitem", { name: "解析 PDF", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "解析 PDF", exact: true });
    await dialog.getByRole("button", { name: "确认启动", exact: true }).click();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(() => w.env.parseCalls, { timeout: 15000 })
      .toBeGreaterThan(initial);
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.archive.status(missingId)).parts[0]?.raw_profiles
            .length,
        { timeout: 15000 },
      )
      .toBe(1);
    expect((await w.env.app.archive.status(missingId)).status).toBe(
      "ASSET_READY",
    );
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: /^建档 \d+$/ })
      .click();
    const build = p.getByRole("dialog", { name: "建立文献档案", exact: true });
    await build.getByRole("button", { name: "确认启动", exact: true }).click();
    await build.getByRole("button", { name: "关闭", exact: true }).click();
    await expect
      .poll(async () => (await w.env.app.archive.status(missingId)).status, {
        timeout: 15000,
      })
      .toBe("READY");
    await p.goto(`${w.origin}/?literature=${missingId}&reader=doc`);
    await p
      .getByRole("button", { name: "字段、来源与锁定", exact: true })
      .click();
    await p.getByRole("button", { name: "编辑标题", exact: true }).click();
    await p
      .getByRole("textbox", { name: "标题", exact: true })
      .fill("Manually corrected title");
    await p.getByRole("button", { name: "保存并锁定", exact: true }).click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.metadataFields.read(missingId)).literature.metadata
            .title,
        { timeout: 15000 },
      )
      .toBe("Manually corrected title");
    expect(
      (await w.env.app.metadataFields.read(missingId)).field_states.find(
        (s) => s.field === "title",
      )?.locked,
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("creates a snapshot and runs mapped DSH summaries and synthesis with clickable evidence", async () => {
  const w = await nextWorkspace();
  try {
    w.env.setModel((input) =>
      input.purpose
        ? {
            outcome: "completed",
            title: "Synthetic summary",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "合成文献报告测量结果。",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [input.segments![0]!.segment_id],
              },
            ],
          }
        : {
            claims: [
              {
                text: "综合测量证据。",
                source_ids: (input.candidates as { id: string }[]).map(
                  (c) => c.id,
                ),
              },
            ],
          },
    );
    const p = w.page;
    await p.getByRole("button", { name: "用当前结果", exact: true }).click();
    await p.getByRole("menuitem", { name: "生成快照", exact: true }).click();
    // Generating a snapshot opens it directly.
    await p.getByRole("heading", { name: /1 篇/ }).waitFor();
    expect(
      (await w.env.app.snapshots.list({ after: null, limit: 10 })).items,
    ).toHaveLength(1);
    await runFromSnapshot(p, "多篇综合", (dialog) =>
      dialog
        .getByRole("textbox", { name: "综合问题", exact: true })
        .fill("Compare the saved measurements."),
    );
    await expect
      .poll(
        async () =>
          (await w.env.app.processorRead!.list()).items.filter(
            (i) => i.processor_id === "knowledge-synthesis",
          ).length,
        { timeout: 15000 },
      )
      .toBe(1);
    const result = (await w.env.app.processorRead!.list()).items.find(
      (i) => i.processor_id === "knowledge-synthesis",
    )!;
    await p.goto(
      `${w.origin}/?view=ext&result=${result.result_id}&resultHash=${result.content_sha256}`,
    );
    await p.getByRole("region", { name: "结果覆盖与版本" }).waitFor();
    expect(
      await p.getByRole("region", { name: "结果覆盖与版本" }).textContent(),
    ).toContain("有结果 1 篇");
    expect(
      await p.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("综合测量证据");
    expect(
      await p.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("综合值");
    await p
      .getByRole("table", { name: "提取结果" })
      .getByRole("button", { name: "综合测量证据。", exact: true })
      .first()
      .click();
    const evidence = p.getByRole("dialog", { name: "字段证据", exact: true });
    await evidence
      .getByRole("button", { name: "在 PDF 中核对区域", exact: true })
      .first()
      .click();
    await p.getByLabel("证据对应区域", { exact: true }).waitFor();
    await p.reload();
    await p.getByLabel("证据对应区域", { exact: true }).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("previews undo dependencies before reverting a vocabulary change", async () => {
  const w = await nextWorkspace();
  try {
    const tags = w.env.app.tags;
    await tags.change({
      mutation: { op: "create", tag: topicDraft("Extra topic") },
      expected_version: (await tags.state()).version,
      reason: "synthetic vocabulary",
    });
    const tag = (await tags.list({ query: "Extra topic" })).items[0]!;
    const changed = await tags.change(
      {
        mutation: {
          op: "edit-definition",
          tag_id: tag.tag_id,
          definition: { includes: "Changed definition", excludes: "" },
        },
        expected_version: (await tags.state()).version,
        reason: "consolidation fixture",
      },
      "consolidation",
    );
    const p = w.page;
    await p.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    await p.getByRole("button", { name: "编辑标签", exact: true }).click();
    await select(p, "要添加的标签", "Extra topic");
    await p.getByRole("button", { name: /支持该标签的原文片段/ }).click();
    await p.getByRole("option", { name: /片段 1 ·/ }).click();
    await p
      .getByRole("textbox", { name: "标签理由", exact: true })
      .fill("Manually checked synthetic evidence");
    await p.getByRole("button", { name: "添加并锁定", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await tags.assignment(w.env.parseRequest.literature_id))?.items.find(
            (i) => i.tag_id === tag.tag_id,
          )?.locked,
      )
      .toBe(true);
    await p.getByRole("button", { name: "词表", exact: true }).click();
    await p.getByRole("heading", { name: "标签词表", exact: true }).waitFor();
    await p.getByRole("button", { name: "词表变更日志", exact: true }).click();
    await p
      .getByRole("article", { name: `词表变更 ${changed.version}` })
      .getByRole("button", { name: "查看撤销影响", exact: true })
      .click();
    const dialog = p.getByRole("dialog", {
      name: "确认撤销词表变更",
      exact: true,
    });
    await dialog.getByText(/没有后续依赖/).waitFor();
    await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect
      .poll(async () => (await tags.get(tag.tag_id))!.tag.definition.includes)
      .toBe("Extra topic");
    await p.getByRole("button", { name: "Extra topic", exact: true }).click();
    await p.getByRole("button", { name: "编辑标签", exact: true }).click();
    expect(
      await p
        .getByRole("textbox", { name: "纳入定义", exact: true })
        .inputValue(),
    ).toBe("Extra topic");
    w.env.setModel((input) =>
      input.task === "backfill"
        ? {
            decisions: (
              input.input as {
                materials: {
                  literature_id: string;
                  assignment: { items: { tag_id: string }[] };
                }[];
              }
            ).materials.map((m) => ({
              literature_id: m.literature_id,
              tag_ids: m.assignment.items.map((i) => i.tag_id),
              reason: "Keep checked assignment",
            })),
          }
        : {},
    );
    await p.getByRole("button", { name: "预估回溯", exact: true }).click();
    await p.getByText(/预计模型调用/).waitFor();
    await p
      .getByRole("button", { name: "确认并启动回溯", exact: true })
      .click();
    await expect
      .poll(() => new URL(p.url()).searchParams.get("view"))
      .toBe("task");
    const task = new URL(p.url()).searchParams.get("task")!;
    await expect
      .poll(
        async () => (await w.env.app.processingTasks!.read(task)).job.status,
        { timeout: 10000 },
      )
      .toBe("completed");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("locks an edited block, marks its summary stale and locates the fixed PDF region", async () => {
  const w = await nextWorkspace();
  try {
    const id = w.env.parseRequest.literature_id;
    w.env.setModel((input) => ({
      outcome: "completed",
      title: "Synthetic summary",
      statements: [
        {
          statement_id: "s1",
          category: "finding",
          epistemic: "reported",
          text: "测量证据。",
          conditions: [],
          quantity: null,
          evidence_segment_ids: [input.segments![0]!.segment_id],
        },
      ],
    }));
    const run = await w.env.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "reader-summary",
      name: "reader-summary",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [{ kind: "literature", literature_id: id }],
    });
    expect(run.failures).toEqual([]);
    const result_id = (run.results[0] as { result: { result_id: string } })
      .result.result_id;
    const p = w.page;
    await p.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await p.getByRole("button", { name: "显示核对依据", exact: true }).click();
    await p
      .getByRole("button", { name: /查看区块来源/ })
      .first()
      .click();
    const editor = p.getByRole("region", { name: "校订稿编辑", exact: true });
    const field = editor.getByRole("textbox", {
      name: "第 1 页校订稿",
      exact: true,
    });
    await field.waitFor();
    const original = await field.inputValue();
    await field.fill(original + "\n\nManually corrected measurements\n\n");
    await editor.getByRole("button", { name: "保存修订", exact: true }).click();
    await p
      .getByText("修订已保存，全文、结构与引用已重建。", { exact: true })
      .waitFor();
    expect(
      (await w.env.app.processorRead!.byId(result_id))!.freshness?.state,
    ).toBe("stale");
    await expect
      .poll(() =>
        p
          .locator(".reading-pdf-page canvas")
          .first()
          .evaluate(
            (canvas: HTMLCanvasElement) =>
              canvas.width > 0 && canvas.height > 0,
          ),
      )
      .toBe(true);
    expect(new URL(p.url()).searchParams.get("reader")).toBe("edit");
    expect(new URL(p.url()).searchParams.get("page")).toBe("1");
    const pdfBox = await p.locator(".reader-surface").boundingBox(),
      editorBox = await editor.boundingBox();
    expect(editorBox!.x).toBeGreaterThanOrEqual(pdfBox!.x + pdfBox!.width);
    await p.goto(`${w.origin}/?view=archive`);
    await p.getByRole("heading", { name: "需处理", exact: true }).waitFor();
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/archive-desktop.png",
    });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/archive-mobile.png",
    });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("recovers archive issues and keeps an unparsed supplement non-blocking in the reader", async () => {
  const w = await nextWorkspace();
  try {
    const e = w.env,
      id = e.parseRequest.literature_id,
      bytes = workbenchPdf("10.1000/extra"),
      stage = await e.app.files.stage({ maxBytes: bytes.length });
    await stage.write(bytes);
    await e.app.files.publish(stage, "objects/extra.pdf");
    await stage.discard();
    const asset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path: "objects/extra.pdf",
    });
    await e.app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: id,
      asset,
      role: "supplementary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-10-20T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    const failed = vi.spyOn(e.app.tags, "build").mockRejectedValueOnce(
      Object.assign(new Error("synthetic tags failure"), {
        code: "tags-failed",
      }),
    );
    await e.app.archive.build({
      schema_version: 2,
      selector: { kind: "literatures", literature_ids: [id] },
      mode: "full",
      from_step: "tags",
      idempotency_key: randomUUID(),
    });
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(async () => (await e.app.archive.status(id)).status, {
        timeout: 15000,
      })
      .toBe("ARCHIVE_FAILED");
    failed.mockRestore();
    const p = w.page;
    await p.goto(`${w.origin}/?view=archive`);
    await p.getByRole("button", { name: "编辑文献标签", exact: true }).click();
    await p
      .getByRole("region", { name: "文献标签编辑", exact: true })
      .waitFor();
    await p
      .getByRole("button", { name: "继续建档", exact: true })
      .first()
      .click();
    await expect
      .poll(async () => (await e.app.archive.status(id)).status, {
        timeout: 15000,
      })
      .toBe("READY");
    expect(
      (await e.app.archive.status(id)).issues.some(
        (i) => i.part === "supplementary" && !i.affects_readiness,
      ),
    ).toBe(true);
    await p.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await select(p, "阅读部分", "补充材料 1");
    await expect
      .poll(() => new URL(p.url()).searchParams.get("asset"))
      .toBe(asset.asset_id);
    await p.getByRole("button", { name: /缩放/ }).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await w.close();
  }
}, 60000);

it("preserves summary reading position and presents evidence on demand across screen sizes", async () => {
  const w = await nextWorkspace({
    setup: async (e) => {
      e.setText(
        "# Measurements\nThe reagent $\\mathrm{SnBu}_4$ was measured at 4.2 eV. " +
          "Additional cited context and experimental procedure. ".repeat(50) +
          "\n\n## Context\nA separate discussion.\n",
      );
    },
  });
  try {
    const e = w.env,
      id = e.parseRequest.literature_id;
    let citedSegment = "";
    const experimentId = "00000000-0000-0000-0000-000000009999";
    e.setModel((input) => {
      citedSegment = input.segments!.find((s) =>
        s.text.includes("SnBu"),
      )!.segment_id;
      return {
        outcome: "completed",
        title: "Synthetic summary",
        statements: Array.from({ length: 24 }, (_, index) => ({
          statement_id: `s${index + 1}`,
          category: "finding",
          epistemic: "reported",
          text: `第 ${index + 1} 项测量：合成材料用于验证总结排版、长文位置和证据核对，不代表实际研究结论。【${citedSegment}】实验编号【${experimentId}】。`,
          conditions: [],
          quantity: null,
          evidence_segment_ids: [citedSegment],
        })),
      };
    });
    await e.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "summary-layout",
      name: "summary-layout",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [{ kind: "literature", literature_id: id }],
    });
    const p = w.page;
    await p.goto(`${w.origin}/?literature=${id}&reader=know`);
    const summary = p.getByRole("region", { name: "文献总结", exact: true });
    await summary
      .getByRole("region", { name: "总结条目 24", exact: true })
      .waitFor();
    const prose = await summary.locator(".reader-prose").first().innerText();
    expect(prose).not.toContain(citedSegment);
    expect(prose).toContain(`实验编号【${experimentId}】`);
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/reader-desktop.png",
    });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/reader-mobile.png",
    });
    await p.setViewportSize({ width: 1440, height: 1000 });
    const scroll = () =>
      summary.evaluate(
        (el) => el.closest<HTMLElement>(".reading-scroll")!.scrollTop,
      );
    await summary.evaluate((el) => {
      el.closest<HTMLElement>(".reading-scroll")!.scrollTop = 900;
    });
    await expect.poll(scroll).toBeGreaterThan(800);
    await p.getByRole("tab", { name: "全文", exact: true }).click();
    await p.getByRole("tab", { name: "结果", exact: true }).click();
    await p.getByRole("button", { name: "阅读总结", exact: true }).click();
    await expect.poll(scroll).toBeGreaterThan(800);
    await summary.getByRole("button", { name: "[1.1]", exact: true }).click();
    await p
      .getByRole("button", { name: "在原文中核对", exact: true })
      .waitFor();
    await p.keyboard.press("Escape");
    const firstClaim = summary.getByRole("region", {
      name: "总结条目 1",
      exact: true,
    });
    expect(
      await firstClaim.locator(".reader-value-check").getAttribute("open"),
    ).toBeNull();
    await firstClaim.locator(".reader-value-check > summary").click();
    expect(await firstClaim.innerText()).not.toMatch(
      /At least one|corrected fragment|verification-not-configured/,
    );
    await firstClaim
      .getByRole("button", { name: "查看对应原文", exact: true })
      .first()
      .click();
    await p
      .getByRole("button", { name: "在原文中核对", exact: true })
      .waitFor();
    await p.keyboard.press("Escape");
    for (const width of [1440, 390]) {
      await p.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const citation = summary.getByRole("button", {
        name: "[1.1]",
        exact: true,
      });
      await citation.scrollIntoViewIfNeeded();
      await p.evaluate(() => new Promise(requestAnimationFrame));
      await citation.click();
      const preview = p.getByRole("dialog", { name: "证据 1.1", exact: true });
      await preview
        .getByRole("button", { name: "在原文中核对", exact: true })
        .waitFor();
      expect(await preview.locator(".katex").count()).toBeGreaterThan(0);
      await expect
        .poll(async () => {
          const popup = await p.locator(".ui-evidence-popover").boundingBox();
          const area = await p.locator(".reader-surface").boundingBox();
          return (
            !!popup &&
            !!area &&
            popup.x >= area.x - 1 &&
            popup.x + popup.width <= area.x + area.width + 1 &&
            popup.y >= Math.max(0, area.y) - 1 &&
            popup.y + popup.height <=
              Math.min(width === 390 ? 844 : 1000, area.y + area.height) + 1
          );
        })
        .toBe(true);
      await p.keyboard.press("Escape");
    }
    await p.getByRole("tab", { name: "全文", exact: true }).click();
    await p.getByRole("button", { name: "显示核对依据", exact: true }).click();
    await p
      .getByRole("tablist", { name: "全文模式", exact: true })
      .getByRole("tab", { name: "编辑", exact: true })
      .click();
    const editor = p.getByRole("region", { name: "校订稿编辑", exact: true });
    await editor.getByRole("tab", { name: "预览", exact: true }).click();
    await editor.locator(".katex").first().waitFor();
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.getByRole("button", { name: "词表", exact: true }).click();
    await p.getByRole("button", { name: "Spectroscopy", exact: true }).click();
    await p
      .getByRole("heading", { name: "Spectroscopy", exact: true })
      .waitFor();
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/tags-desktop.png",
    });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({
      path: "/tmp/sciretriever-archive-implementation-yzz1ycub/tags-mobile.png",
    });
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("shows all states and styled ranked tags on a cold library entry", async () => {
  const w = await nextWorkspace({
    setup: async (e) => {
      await e.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: workbenchPdf("10.1000/unparsed"),
      });
    },
  });
  try {
    const p = w.page;
    // No archive, vocabulary or reader route has been loaded in this browser.
    await expect.poll(() => p.locator(".paper-row").count()).toBe(2);
    await p.getByText("Unparsed source", { exact: true }).waitFor();
    expect(
      await p
        .locator(".paper-status small")
        .first()
        .evaluate((el) => getComputedStyle(el).display),
    ).toBe("block");
    const tags = p.locator(".paper-tags").first();
    await tags.waitFor();
    expect(await tags.evaluate((el) => getComputedStyle(el).display)).toBe(
      "flex",
    );
    expect(
      await tags.evaluate((el) => parseFloat(getComputedStyle(el).columnGap)),
    ).toBeGreaterThan(0);
    const primary = tags.locator(".paper-tag.primary");
    expect(
      await primary.evaluate((el) => Number(getComputedStyle(el).fontWeight)),
    ).toBeGreaterThanOrEqual(500);
    // Ranked tags are told apart by a tinted fill, not a border.
    expect(
      await primary.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await libraryStatus(p, "已就绪");
    await expect.poll(() => p.locator(".paper-row").count()).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
