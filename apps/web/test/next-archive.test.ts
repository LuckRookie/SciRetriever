import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import type { Page } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { topicDraft } from "../../server/test/tag-fixture.js";
async function select(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
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
    await select(p, "材料状态", "有 PDF");
    await p
      .getByRole("checkbox", { name: "选择已加载的文献", exact: true })
      .focus();
    await p.keyboard.press("Space");
    const initial = w.env.parseCalls;
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "解析 PDF", exact: true })
      .click();
    const dialog = p.getByRole("dialog", { name: "解析 PDF", exact: true });
    await dialog.getByRole("button", { name: "确认启动", exact: true }).click();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => w.env.parseCalls).toBeGreaterThan(initial);
    await expect
      .poll(
        async () =>
          (await w.env.app.archive.status(missingId)).parts[0]?.raw_profiles
            .length,
      )
      .toBe(1);
    expect((await w.env.app.archive.status(missingId)).status).toBe(
      "ASSET_READY",
    );
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "建档／重试", exact: true })
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
      .getByRole("button", { name: "编辑字段、来源与锁定", exact: true })
      .click();
    await p.getByRole("button", { name: "编辑标题", exact: true }).click();
    await p
      .getByRole("textbox", { name: "标题", exact: true })
      .fill("Manually corrected title");
    await p.getByRole("button", { name: "保存并锁定", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await w.env.app.metadataFields.read(missingId)).literature.metadata
            .title,
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
    await p.getByRole("button", { name: "生成快照", exact: true }).click();
    await p.getByRole("heading", { name: "快照", exact: true }).waitFor();
    expect(
      (await w.env.app.snapshots.list({ after: null, limit: 10 })).items,
    ).toHaveLength(1);
    await p.getByRole("button", { name: /当前快照/ }).click();
    await p.getByRole("option", { name: /1 篇/ }).click();
    await select(p, "算子", "多篇综合");
    await p
      .getByRole("textbox", { name: "综合问题", exact: true })
      .fill("Compare the saved measurements.");
    await p.getByRole("button", { name: "确认启动", exact: true }).click();
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
    ).toContain("已提取 1");
    expect(
      await p.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("综合测量证据");
    expect(
      await p.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("存疑");
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
    await p.getByRole("button", { name: "编辑文献标签", exact: true }).click();
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
    const dialog = p.getByRole("dialog", { name: "校订区块对照", exact: true });
    await dialog.getByRole("button", { name: "人工修订", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "修订文字", exact: true })
      .fill("Manually corrected measurements");
    await dialog
      .getByRole("textbox", { name: "核对依据或原因", exact: true })
      .fill("已对照原 PDF 核对测量文字。");
    await dialog
      .getByRole("button", { name: "保存修订并锁定", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await w.env.app.processorRead!.byId(result_id))!.freshness?.state,
        { timeout: 10000 },
      )
      .toBe("stale");
    await dialog
      .getByRole("button", { name: "查看原始 PDF 区域", exact: true })
      .click();
    try {
      await expect
        .poll(() =>
          dialog
            .getByLabel("对应原始 PDF 区域", { exact: true })
            .evaluate(
              (canvas: HTMLCanvasElement) =>
                canvas.width > 0 &&
                canvas.height > 0 &&
                !!canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3],
            ),
        )
        .toBe(true);
    } catch (e) {
      throw new Error(
        JSON.stringify({ dialog: await dialog.innerText(), errors: w.errors }),
        { cause: e },
      );
    }
    await dialog
      .getByRole("button", { name: "在 PDF 中定位", exact: true })
      .click();
    await p.keyboard.press("Escape");
    await expect
      .poll(() => new URL(p.url()).searchParams.get("reader"))
      .toBe("pdf");
    expect(new URL(p.url()).searchParams.get("page")).toBe("1");
    await p.goto(`${w.origin}/?view=archive`);
    await p.getByRole("heading", { name: "建档问题", exact: true }).waitFor();
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
      selector: { kind: "literatures", literature_ids: [id] },
      mode: "full",
      from_step: "tags",
      idempotency_key: randomUUID(),
    });
    await expect
      .poll(async () => (await e.app.archive.status(id)).status)
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
  const w = await nextWorkspace();
  try {
    const e = w.env,
      id = e.parseRequest.literature_id;
    e.setModel((input) => ({
      outcome: "completed",
      title: "Synthetic summary",
      statements: Array.from({ length: 24 }, (_, index) => ({
        statement_id: `s${index + 1}`,
        category: "finding",
        epistemic: "reported",
        text: `第 ${index + 1} 项测量：合成材料用于验证总结排版、长文位置和证据核对，不代表实际研究结论。`,
        conditions: [],
        quantity: null,
        evidence_segment_ids: [input.segments![0]!.segment_id],
      })),
    }));
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
    await p.getByRole("tab", { name: "总结", exact: true }).click();
    await expect.poll(scroll).toBeGreaterThan(800);
    await summary.getByRole("button", { name: "[1.1]", exact: true }).click();
    await p
      .getByRole("button", { name: "在原文中核对", exact: true })
      .waitFor();
    await p.keyboard.press("Escape");
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
