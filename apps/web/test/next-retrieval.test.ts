import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { motionOptions, nextAssets } from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium, type Page } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseLiterature,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { processorFixture } from "../../server/test/processor-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import {
  taskHttpAdapters,
  processorHttpAdapters,
} from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

async function workspace(withSynthesis = false, indexes = true) {
  const env = await processorFixture();
  await env.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: "00000000-0000-0000-0000-000000005001",
      meta_literature_id: "00000000-0000-0000-0000-000000005002",
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Unparsed source",
        identifiers: [],
      },
    }),
  );
  env.setText(
    "# Results\n" +
      Array.from(
        { length: 7 },
        (_, i) =>
          `\n## Study ${i + 1}\nnanocrystal synthesis original observation ${i + 1}.\n`,
      ).join("") +
      "\n## 中文\n纳米晶 合成 nanocrystal.\n\n钙钛矿纳米晶合成\n",
  );
  const parsed = await env.build(env.parseRequest);
  env.setModel((request) => ({
    outcome: "completed",
    title: "Nanocrystal overview",
    statements: [
      {
        statement_id: "finding-1",
        category: "finding",
        epistemic: "reported",
        text: "nanocrystal 纳米晶 合成 observation",
        conditions: [],
        quantity: null,
        evidence_segment_ids: [
          request.segments!.find((s) => s.text.includes("observation"))!
            .segment_id,
        ],
      },
    ],
  }));
  const run = async (processor: string, inputs: unknown[], spec: unknown) => {
    const job = await env.app.processors!.submit({
      schema_version: 1,
      idempotency_key: processor,
      name: processor,
      processor: { id: processor, version: "2" },
      spec,
      inputs,
    });
    await env.app.processingTasks!.run(job.job_id);
    const state = await env.app.processingTasks!.read(job.job_id);
    expect(state.failures).toEqual([]);
    return (await env.app.processorRead!.byId(
      (state.results[0] as { result: { result_id: string } }).result.result_id,
    ))!;
  };
  const knowledge = await run(
    "summary",
    [{ kind: "literature", literature_id: env.parseRequest.literature_id }],
    { purpose: "overview", question: null },
  );
  if (withSynthesis) {
    const snapshot = await env.app.snapshots.create({
      kind: "literatures",
      literature_ids: [env.parseRequest.literature_id],
    });
    env.setModel((request) => ({
      claims: [
        {
          text: "nanocrystal 纳米晶 合成 synthesis",
          source_ids: (request.candidates as { id: string }[]).map((c) => c.id),
        },
      ],
    }));
    await run(
      "knowledge-synthesis",
      [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      { question: "Compare nanocrystal evidence", policy: "require-all" },
    );
  }
  if (indexes) await env.app.maintenance!.rebuildIndex();
  else {
    // Document publication creates a material index; explicitly remove its
    // active pointer to exercise an unavailable index in this synthetic home.
    const db = new DatabaseSync(
      env.app.configuration.paths.catalog_path ??
        join(env.home, "catalog.sqlite"),
    );
    try {
      db.exec("DELETE FROM retrieval_active_generation");
    } finally {
      db.close();
    }
  }
  const query = await createQueryApplication(env.home);
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("unexpected browser action");
  });
  const assets = new Map<string, WorkbenchStaticAsset>(await readingAssets());
  for (const [path, asset] of await nextAssets()) assets.set(path, asset);
  const server = await startWorkbenchHttp({
    access: workbenchTestAccess,
    ...taskHttpAdapters(env.app),
    ...processorHttpAdapters(env.app),
    session,
    query: { application: query, maintenance: env.app.maintenance! },
    library: {
      queries: env.app.library,
      artifacts: env.app.literatureArtifacts,
    },
    assets,
  });
  const browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  const page = await browser.newPage({
    ...motionOptions(),
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: KnowledgeContextRequest[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/query/knowledge-context"))
      requests.push(
        (request.postDataJSON() as { request: KnowledgeContextRequest })
          .request,
      );
  });
  await loginWorkbenchPage(page, server.origin);
  await page.goto(`${server.origin}/?view=ask`);
  await page.locator('input[placeholder="输入要查找的问题或关键词"]').waitFor();
  const calls = { model: env.modelCalls, parse: env.parseCalls };
  let jobs = await env.app.jobs!.listJobs(10);
  return {
    env,
    page,
    requests,
    parsed,
    knowledge,
    async recordSetup() {
      jobs = await env.app.jobs!.listJobs(10);
    },
    async close() {
      try {
        expect(errors).toEqual([]);
        expect(env.modelCalls).toBe(calls.model);
        expect(await env.app.jobs!.listJobs(10)).toEqual(jobs);
      } finally {
        await browser.close();
        await server.close();
        await session.close();
        await query.close();
        await env.close();
      }
    },
  };
}

async function search(page: Page, query: string, kind = "all") {
  await page
    .locator('input[placeholder="输入要查找的问题或关键词"]')
    .fill(query);
  await choose(
    page,
    "内容",
    kind === "source"
      ? "仅原文"
      : kind === "knowledge"
        ? "仅知识"
        : "原文与知识",
  );
  await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/query/knowledge-context"),
    ),
    page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click(),
  ]);
  await expect
    .poll(() => page.locator('[data-testid="retrieval-status"]').textContent())
    .toMatch(/条结果/u);
}

async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole("button", { name: new RegExp(label) });
  if (!(await trigger.isVisible()))
    await page
      .getByRole("button", { name: "高级检索选项", exact: true })
      .click();
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
it("searches source and knowledge in all three modes, paginates, and explains Chinese lexical matching without blocking it", async () => {
  const w = await workspace();
  try {
    await search(w.page, "nanocrystal");
    expect(w.requests.at(-1)?.kinds).toEqual([
      "metadata",
      "document",
      "knowledge",
    ]);
    expect(
      await w.page.locator('[data-testid="retrieval-kind"]').allTextContents(),
    ).toEqual(expect.arrayContaining(["原文", "知识"]));
    await search(w.page, "nanocrystal", "source");
    expect(w.requests.at(-1)?.kinds).toEqual(["metadata", "document"]);
    expect(
      await w.page.locator('[data-testid="retrieval-kind"]').allTextContents(),
    ).not.toContain("知识");
    await choose(w.page, "每页结果", "5 条");
    await search(w.page, "nanocrystal", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(5);
    await w.page.getByRole("button", { name: "继续查找", exact: true }).click();
    await expect
      .poll(() => w.page.locator('[data-testid="retrieval-result"]').count())
      .toBeGreaterThan(5);
    expect(w.requests.at(-1)?.continuation).toBeTruthy();
    await search(w.page, "纳米晶", "knowledge");
    expect(await w.page.locator('[role="note"]').isVisible()).toBe(true);
    expect(await w.page.locator('[role="note"]').textContent()).toContain(
      "不会自动跨语言",
    );
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("纳米晶");
    expect(
      await w.page.locator('[data-testid="retrieval-kind"]').allTextContents(),
    ).toEqual(["知识"]);
    await search(w.page, "纳米晶", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-text"]').allTextContents(),
    ).toEqual(["纳米晶 合成 nanocrystal."]);
    await search(w.page, "钙钛矿", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(0);
    expect(
      await w.page.locator('[data-testid="retrieval-status"]').textContent(),
    ).toContain("关键词");
    await search(w.page, "钙钛矿纳米晶合成", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(1);
    await search(w.page, "纳米晶 nanocrystal", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(1);
    expect(w.env.parseCalls).toBe(2);
  } finally {
    await w.close();
  }
}, 60000);

it("opens a synthesis hit as its own fixed artifact and returns to the same query", async () => {
  const w = await workspace(true);
  try {
    await search(w.page, "nanocrystal", "knowledge");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(2);
    await w.page
      .locator('[data-testid="retrieval-result"]')
      .filter({
        has: w.page.getByTestId("retrieval-kind").filter({ hasText: "综合" }),
      })
      .locator('[data-testid="retrieval-source"]')
      .click();
    expect(new URL(w.page.url()).searchParams.get("view")).toBe("ext");
    await expect
      .poll(() => w.page.locator(".result-text").textContent())
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("result")).toBeTruthy();
    await w.page.reload();
    await expect
      .poll(() => w.page.locator(".result-text").textContent())
      .toContain("nanocrystal 纳米晶");
    // Reloaded links retain source identity; in-session return restores the query without re-querying.
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    await search(w.page, "nanocrystal", "knowledge");
    const before = w.requests.length;
    await w.page.locator('[data-testid="retrieval-source"]').last().click();
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("nanocrystal");
    expect(w.requests.length).toBe(before);
    expect(w.env.parseCalls).toBe(2);
  } finally {
    await w.close();
  }
}, 60000);

it("keeps late or failed searches from replacing a newer page and permits an explicit retry", async () => {
  const w = await workspace();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const handled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let intercepted = false;
  try {
    await w.page.route(
      "**/api/v1/query/knowledge-context?*",
      async (route) => {
        const response = await route.fetch();
        intercepted = true;
        await gate;
        await route.fulfill({ response });
        completed();
      },
      { times: 1 },
    );
    await w.page
      .locator('input[placeholder="输入要查找的问题或关键词"]')
      .fill("observation");
    await w.page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect.poll(() => intercepted).toBe(true);
    await w.page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await w.page
      .getByLabel("主导航")
      .getByRole("button", { name: "全文检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.getByTestId("retrieval-status").textContent())
      .toContain("已中止");
    await search(w.page, "纳米晶", "knowledge");
    release();
    await handled;
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("纳米晶");
    expect(
      await w.page.locator('[data-testid="retrieval-kind"]').allTextContents(),
    ).toEqual(["知识"]);
    await w.page.route(
      "**/api/v1/query/knowledge-context?*",
      async (route) => {
        await route.fulfill({
          status: 503,
          json: { protocol_version: 1, code: "knowledge-index-unavailable" },
        });
      },
      { times: 2 },
    );
    await w.page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.getByRole("alert").textContent())
      .toContain("知识检索索引不可用");
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("纳米晶");
    await search(w.page, "nanocrystal", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBeGreaterThan(1);
    expect(w.env.parseCalls).toBe(2);
  } finally {
    release();
    await w.close();
  }
}, 60000);

// Each poll follows a full page navigation, which can take more than the
// default second to boot and render on a loaded machine.
it("opens the fixed hit after a new default is published and restores the query and basket on return", async () => {
  const w = await workspace();
  try {
    await search(w.page, "纳米晶", "knowledge");
    await w.page.locator('[data-testid="retrieval-source"]').first().click();
    await expect
      .poll(() => w.page.locator(".result-text").textContent(), {
        timeout: 5000,
      })
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("result")).toBe(
      w.knowledge.ref.result_id,
    );
    const knowledgeUrl = w.page.url();
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("纳米晶");
    await search(w.page, "observation", "source");
    await w.page.locator('[data-testid="retrieval-basket"]').first().click();
    const count = await w.page
      .locator('[data-testid="retrieval-result"]')
      .count();
    w.env.setText(
      "# Revised\nA newer version that must not replace an old search hit.\n",
    );
    await w.env.build(w.env.parseRequest);
    const parseCallsAfterSetup = w.env.parseCalls;
    await w.recordSetup();
    await w.page.locator('[data-testid="retrieval-source"]').first().click();
    // A same-source refresh may clear the body after a prior ready observation.
    // Read readiness and verified text together, without a gap between commands.
    await expect
      .poll(
        () =>
          w.page
            .locator(
              '.react-reader[data-reading-ready="true"] .reading-article',
            )
            .textContent(),
        { timeout: 5000 },
      )
      .toContain("original observation");
    expect(new URL(w.page.url()).searchParams.get("document")).toBe(
      w.parsed.document.document_version_id,
    );
    const fixedUrl = w.page.url();
    await w.page.goBack();
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("observation");
    await w.page.getByRole("button", { name: "高级检索选项" }).click();
    expect(
      await w.page.getByRole("button", { name: /内容/ }).textContent(),
    ).toContain("仅原文");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(count);
    expect(await w.page.locator(".context-basket li").count()).toBe(1);
    await w.page.goto(knowledgeUrl);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 5000 })
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("result")).toBe(
      w.knowledge.ref.result_id,
    );
    const tampered = new URL(fixedUrl);
    tampered.searchParams.set("representation", "0".repeat(64));
    await w.page.goto(tampered.href);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 5000 })
      .toContain("不匹配");
    expect(await w.page.locator(".reading-article").count()).toBe(0);
    const materialReads: unknown[] = [];
    w.page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/query/material-bytes"))
        materialReads.push(request.postDataJSON());
    });
    const pdfUrl = new URL(fixedUrl);
    pdfUrl.searchParams.set("reader", "pdf");
    pdfUrl.searchParams.set("assetHash", "0".repeat(64));
    await w.page.goto(pdfUrl.href);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 5000 })
      .toContain("未使用默认材料替代");
    expect(materialReads).toEqual([]);
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    pdfUrl.searchParams.set("assetHash", w.env.asset.sha256);
    await w.page.goto(pdfUrl.href);
    await w.page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(materialReads).toEqual([
      {
        protocol_version: 1,
        request: {
          literature_id: w.env.parseRequest.literature_id,
          asset_id: w.env.asset.asset_id,
          asset_sha256: w.env.asset.sha256,
        },
      },
    ]);
    expect(w.env.parseCalls).toBe(parseCallsAfterSetup);
  } finally {
    await w.close();
  }
}, 60000);

it("explains an unavailable material index while retaining result searches without starting maintenance", async () => {
  const w = await workspace(false, false);
  try {
    for (const kind of ["all", "source"]) {
      await search(w.page, "nanocrystal", kind);
      // The index line explains the missing index; the result line only
      // counts results and never suggests rewording against no index.
      await expect
        .poll(() =>
          w.page.locator('[data-testid="retrieval-index"]').textContent(),
        )
        .toContain("还没有全文索引");
      expect(
        await w.page.locator('[data-testid="retrieval-status"]').textContent(),
      ).not.toContain("未匹配当前关键词");
    }
    await search(w.page, "nanocrystal", "knowledge");
    expect(
      await w.page.locator('[data-testid="retrieval-status"]').textContent(),
    ).toBe("1 条结果");
    expect(
      await w.page.locator('[data-testid="retrieval-kind"]').allTextContents(),
    ).toEqual(["知识"]);
  } finally {
    await w.close();
  }
}, 60000);

it("releases grants on repeated reloads and permits WebAssembly without JavaScript eval", async () => {
  const w = await workspace();
  const failedGrants: number[] = [];
  w.page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/clients" &&
      response.status() !== 201
    )
      failedGrants.push(response.status());
  });
  try {
    for (let index = 0; index < 20; index++) {
      await w.page.reload();
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .waitFor();
    }
    expect(failedGrants).toEqual([]);
    await w.page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    const box = w.page.locator('.paper-row input[type="checkbox"]').first();
    await box.waitFor();
    const original = await box.elementHandle();
    await box.focus();
    await box.press("Space");
    expect(
      await original!.evaluate(
        (el) =>
          el instanceof HTMLInputElement &&
          el.isConnected &&
          el.checked &&
          document.activeElement === el,
      ),
    ).toBe(true);
    expect(
      await w.page.evaluate(async () => {
        await WebAssembly.compile(
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        );
        try {
          Reflect.construct(Function, ["return 1"]);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  } finally {
    await w.close();
  }
}, 60000);
