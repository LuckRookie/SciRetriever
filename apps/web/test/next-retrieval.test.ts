import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import {
  motionOptions,
  nextAssets,
  nextWorkspace,
} from "./next-workspace-fixture.js";
import { retrievalStrings } from "../src/app/strings.js";
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
  page.setDefaultTimeout(20_000);
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
    origin: server.origin,
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
      ? "仅全文"
      : kind === "knowledge"
        ? "仅知识"
        : "全文与知识",
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
  // Hits are counted on the status line; no hits show the empty state instead.
  await expect
    .poll(
      async () =>
        `${await page.locator('[data-testid="retrieval-status"]').textContent()}${await page.getByRole("region", { name: "检索结果" }).textContent()}`,
    )
    .toMatch(/条结果|没有找到与/u);
}

/** The kind of every shown hit: source, metadata, knowledge or synthesis. */
const kindsOf = (page: Page) =>
  page
    .locator('[data-testid="retrieval-result"]')
    .evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.kind),
    );
/** A paper shows three hits at first; open the rest of every group. */
async function expandAll(page: Page) {
  for (const more of await page
    .getByRole("button", { name: /^展开另外 \d+ 条$/u })
    .all())
    await more.click();
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
    await expandAll(w.page);
    expect(await kindsOf(w.page)).toEqual(
      expect.arrayContaining(["source", "knowledge"]),
    );
    // Page specs “全文检索”: each text hit names its version's level.
    const kinds = await kindsOf(w.page);
    expect(
      await w.page.locator('[data-testid="retrieval-level"]').allTextContents(),
    ).toEqual(
      kinds.filter((kind) => kind === "source").map(() => "全文 · 已校对"),
    );
    await search(w.page, "nanocrystal", "source");
    expect(w.requests.at(-1)?.kinds).toEqual(["metadata", "document"]);
    expect(await kindsOf(w.page)).not.toContain("knowledge");
    await choose(w.page, "每页结果", "5 条");
    await search(w.page, "nanocrystal", "source");
    await expandAll(w.page);
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(5);
    await w.page.getByRole("button", { name: "继续查找", exact: true }).click();
    await expect
      .poll(async () => {
        await expandAll(w.page);
        return w.page.locator('[data-testid="retrieval-result"]').count();
      })
      .toBeGreaterThan(5);
    expect(w.requests.at(-1)?.continuation).toBeTruthy();
    await search(w.page, "纳米晶", "knowledge");
    expect(await w.page.locator('[role="note"]').isVisible()).toBe(true);
    expect(await w.page.locator('[role="note"]').textContent()).toContain(
      retrievalStrings.hanNote,
    );
    expect(
      await w.page
        .locator('input[placeholder="输入要查找的问题或关键词"]')
        .inputValue(),
    ).toBe("纳米晶");
    expect(await kindsOf(w.page)).toEqual(["knowledge"]);
    // Chinese is searched by character (technical 04 §9.7): a word inside a
    // longer run of characters is found too.
    await search(w.page, "纳米晶", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-text"]').allTextContents(),
    ).toEqual(["纳米晶 合成 nanocrystal.", "钙钛矿纳米晶合成"]);
    await search(w.page, "钙钛矿", "source");
    expect(
      await w.page.locator('[data-testid="retrieval-text"]').allTextContents(),
    ).toEqual(["钙钛矿纳米晶合成"]);
    await search(w.page, "石墨烯", "source");
    // No hits: one sentence and one suggestion, in the results' own place.
    await expect
      .poll(() =>
        w.page.getByRole("region", { name: "检索结果" }).textContent(),
      )
      .toBe(
        "没有找到与“石墨烯”匹配的片段。可以换成全文里的用词，或在高级检索选项里放宽范围。",
      );
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(0);
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

it("groups hits by paper with their place in it, folds after three, opens the context column with the first chosen hit, and says one thing when nothing matches", async () => {
  const w = await workspace();
  try {
    const context = w.page.getByRole("complementary", { name: "上下文" });
    await search(w.page, "observation", "source");
    // One paper, one group: its title and its bibliography line.
    const groups = w.page.getByTestId("retrieval-group");
    expect(await groups.count()).toBe(1);
    expect(
      await groups.first().getByTestId("retrieval-citation").textContent(),
    ).toMatch(/ · .+ · /u);
    // Every hit names where it sits: the section it is in.
    const locations = await w.page
      .getByTestId("retrieval-location")
      .allTextContents();
    expect(locations.length).toBe(3);
    for (const location of locations) expect(location).toMatch(/^Study \d/u);
    // The hit's text does not repeat the heading its location already names.
    for (const text of await w.page
      .getByTestId("retrieval-text")
      .allTextContents())
      expect(text).not.toMatch(/^Study \d/u);
    // More than three hits in one paper: the rest wait behind one button.
    const more = w.page.getByRole("button", { name: /^展开另外 (\d+) 条$/u });
    const hidden = Number(/\d+/u.exec((await more.textContent())!)![0]);
    const total = Number(
      /^(\d+) 条结果/u.exec(
        (await w.page.getByTestId("retrieval-status").textContent())!,
      )![1],
    );
    expect(hidden).toBe(total - 3);
    await more.click();
    expect(await w.page.getByTestId("retrieval-result").count()).toBe(
      3 + hidden,
    );
    // Notes in the secondary colour, actions in the pen's.
    const first = w.page.getByTestId("retrieval-result").first();
    const [note, action] = await Promise.all([
      first
        .getByTestId("retrieval-location")
        .evaluate((el) => getComputedStyle(el).color),
      first
        .getByRole("button", { name: "在全文中查看", exact: true })
        .evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(note).not.toBe(action);
    expect(
      await first
        .getByRole("button", { name: "记下出处", exact: true })
        .count(),
    ).toBe(1);
    expect(await first.getByRole("button", { name: "固定来源" }).count()).toBe(
      0,
    );
    // No context column until a hit is chosen.
    expect(await context.count()).toBe(0);
    await first.getByTestId("retrieval-basket").click();
    await context.waitFor();
    expect(await context.textContent()).toContain("已选择 1 条片段");
    await first
      .getByRole("button", { name: "移出上下文", exact: true })
      .click();
    await context.waitFor({ state: "detached" });
    // Nothing found: one sentence and one suggestion, nothing else.
    await search(w.page, "nonexistentfixtureword", "source");
    await expect
      .poll(() =>
        w.page.getByRole("region", { name: "检索结果" }).textContent(),
      )
      .toBe(
        "没有找到与“nonexistentfixtureword”匹配的片段。可以换成全文里的用词，或在高级检索选项里放宽范围。",
      );
    expect(
      (await w.page.getByTestId("retrieval-status").textContent())!.trim(),
    ).toBe("");
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
      .and(w.page.locator('[data-kind="synthesis"]'))
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
        // Mark the interception before the real search answers: the server can
        // take longer than the poll below allows on a loaded machine.
        intercepted = true;
        const response = await route.fetch();
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
    expect(await kindsOf(w.page)).toEqual(["knowledge"]);
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
        timeout: 20_000,
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
        { timeout: 20_000 },
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
    ).toContain("仅全文");
    expect(
      await w.page.locator('[data-testid="retrieval-result"]').count(),
    ).toBe(count);
    expect(await w.page.locator(".context-basket li").count()).toBe(1);
    await w.page.goto(knowledgeUrl);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 20_000 })
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("result")).toBe(
      w.knowledge.ref.result_id,
    );
    const tampered = new URL(fixedUrl);
    tampered.searchParams.set("representation", "0".repeat(64));
    await w.page.goto(tampered.href);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 20_000 })
      .toContain("不匹配");
    expect(await w.page.locator(".reading-article").count()).toBe(0);
    const materialReads: string[] = [];
    w.page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/v1/query/material-bytes"))
        materialReads.push(path);
    });
    const pdfUrl = new URL(fixedUrl);
    pdfUrl.searchParams.set("reader", "pdf");
    pdfUrl.searchParams.set("assetHash", "0".repeat(64));
    await w.page.goto(pdfUrl.href);
    await expect
      .poll(() => w.page.locator("main").textContent(), { timeout: 20_000 })
      .toContain("未使用默认材料替代");
    expect(materialReads).toEqual([]);
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    pdfUrl.searchParams.set("assetHash", w.env.asset.sha256);
    await w.page.goto(pdfUrl.href);
    await w.page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    // Only the fixed material, by its content address (ranges of one GET route).
    expect(materialReads.length).toBeGreaterThan(0);
    expect(new Set(materialReads)).toEqual(
      new Set([
        `/api/v1/query/material-bytes/${w.env.parseRequest.literature_id}/${w.env.asset.asset_id}/${w.env.asset.sha256}`,
      ]),
    );
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
    expect(await kindsOf(w.page)).toEqual(["knowledge"]);
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

const SHOTS = process.env.SCIRETRIEVER_TRANSLATION_SHOTS;
it("marks a hit on the library's translation, shows that translation in sans and keeps the original's place to open, note and collect (technical 04 §9.7)", async () => {
  const w = await workspace();
  try {
    const page = w.page;
    // The service gives the first source hit as matched in its translation.
    await page.route(
      (url) => url.pathname.endsWith("/query/knowledge-context"),
      async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        const first = (
          value.result.items as { kind: string; text: string }[]
        ).find((item) => item.kind === "source-text");
        if (first)
          Object.assign(first, {
            text: "纳米晶的合成与原始观测。",
            matched: "translation",
            language: "zh-Hans",
          });
        // The bundle states its own size in bytes, as the service does.
        const result = value.result as { usage: { bytes: number } };
        for (let i = 0, last = -1; i < 10 && last !== result.usage.bytes; i++) {
          last = result.usage.bytes;
          result.usage.bytes = Buffer.byteLength(JSON.stringify(result));
        }
        await route.fulfill({ response, json: value });
      },
    );
    // The line under the box says how matching goes now.
    await page
      .locator('input[placeholder="输入要查找的问题或关键词"]')
      .fill("纳米晶");
    await expect
      .poll(() => page.locator('[role="note"]').textContent())
      .toBe(retrievalStrings.hanNote);
    await search(page, "nanocrystal", "source");
    const results = page.getByTestId("retrieval-result");
    const translated = results.filter({
      has: page.getByTestId("retrieval-translated"),
    });
    expect(await translated.count()).toBe(1);
    expect(
      await translated.getByTestId("retrieval-translated").textContent(),
    ).toBe("译文");
    const style = (locator: typeof translated) =>
      locator.getByTestId("retrieval-text").evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--fg2)";
        document.body.append(probe);
        const fg2 = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(el);
        return {
          origin: el.getAttribute("data-origin"),
          family: s.fontFamily.split(",")[0]!.replace(/"/gu, "").trim(),
          secondary: s.color === fg2,
        };
      });
    const machine = await style(translated);
    expect(machine.origin).toBe("machine");
    expect(machine.secondary).toBe(true);
    const original = await style(
      results
        .filter({ hasNot: page.getByTestId("retrieval-translated") })
        .first(),
    );
    expect(original.origin).toBe("author");
    expect(original.family).not.toBe(machine.family);
    expect(await translated.getByTestId("retrieval-text").textContent()).toBe(
      "纳米晶的合成与原始观测。",
    );
    if (SHOTS)
      await page.screenshot({
        path: join(SHOTS, "retrieval-translation-hit.png"),
      });
    // 记下出处 reads the original's fixed range, not the translation.
    await translated.getByRole("button", { name: "记下出处" }).click();
    await expect
      .poll(() => translated.locator(".fixed-quote").textContent())
      .toContain("nanocrystal");
    // 加入上下文 keeps the original's reference and evidence.
    await translated.getByTestId("retrieval-basket").click();
    const collected = await page.evaluate(
      () => document.querySelector(".context-basket")?.textContent ?? "",
    );
    expect(collected).toContain("纳米晶的合成与原始观测");
    const basket = page.getByRole("complementary", { name: "上下文" });
    expect(await basket.getByTestId("basket-translated").textContent()).toBe(
      "译文",
    );
    // The copy says it is a machine translation; its source is the original's.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: w.origin,
      });
    await basket.getByRole("button", { name: "复制为 Markdown" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(retrievalStrings.translatedNote("zh-Hans"));
    const markdown = await page.evaluate(() => navigator.clipboard.readText());
    expect(retrievalStrings.translatedNote("zh-Hans")).toBe(
      "译文（机器翻译，简体中文）；引用请以出处的原文为准。",
    );
    expect(markdown).toMatch(
      /^译文（机器翻译，简体中文）；引用请以出处的原文为准。\n\n纳米晶的合成与原始观测。\n\n来源：`\{"kind":"document"/u,
    );
    // 在全文中查看 opens the original's passage in the full text view, its
    // reading left as chosen.
    await translated.getByTestId("retrieval-source").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("reader"))
      .toBe("doc");
    expect(new URL(page.url()).searchParams.get("document")).toBeTruthy();
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          "sciretriever:react:sciretriever:reader:text-mode:v1",
        ),
      ),
    ).toBeNull();
  } finally {
    await w.close();
  }
}, 90000);

it("says when the index's rule or translation language is older and when the library search rule is, and rebuilds or rewrites only when asked (technical 04 §9.7)", async () => {
  const w = await nextWorkspace({
    path: "/?view=ask",
    ready: 'input[placeholder="输入要查找的问题或关键词"]',
  });
  try {
    const page = w.page;
    const fake: Record<string, unknown> = {
      rule_current: false,
      rule_reason: "text-rule",
      library_search_rule_current: true,
    };
    let status: Record<string, unknown> | null = null;
    await page.route(
      (url) => url.pathname === "/api/v1/query/index-status",
      async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        status = {
          ...value.result,
          status: "idle",
          index_state: "ready",
          operation: null,
          progress: null,
          ...fake,
        };
        await route.fulfill({ response, json: { ...value, result: status } });
      },
    );
    const asked: { path: string; body: unknown }[] = [];
    for (const operation of ["rebuild-index", "rebuild-library-search"])
      await page.route(
        (url) => url.pathname === `/api/v1/maintenance/${operation}`,
        async (route) => {
          asked.push({
            path: operation,
            body: route.request().postDataJSON(),
          });
          await route.fulfill({
            json: {
              protocol_version: 1,
              result:
                operation === "rebuild-index"
                  ? { ...status, status: "scheduled", operation: "rebuild" }
                  : { literatures: 2 },
            },
          });
        },
      );
    const line = page.getByTestId("retrieval-index"),
      library = page.getByTestId("retrieval-library-index");
    // An older text rule: not current, with the rebuild to ask for.
    await page.reload();
    await expect
      .poll(() => line.textContent())
      .toContain(retrievalStrings.ruleOld);
    expect(await library.count()).toBe(0);
    // The translation language changed.
    fake.rule_reason = "translation-language";
    await page.reload();
    await expect
      .poll(() => line.textContent())
      .toContain(retrievalStrings.languageChanged);
    // The library search rule is older too: a line of its own.
    fake.library_search_rule_current = false;
    await page.reload();
    await expect
      .poll(() => library.textContent())
      .toContain(retrievalStrings.libraryOld);
    if (SHOTS)
      await page.screenshot({
        path: join(SHOTS, "retrieval-index-rebuild.png"),
      });
    // Nothing runs until asked.
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);
    await line.getByRole("button", { name: "重建索引" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "重建索引", exact: true })
      .click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toEqual({
      path: "rebuild-index",
      body: {
        protocol_version: 1,
        request: { kind: "rebuild", background: true },
      },
    });
    await library.getByRole("button", { name: "重写书目检索" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "重写书目检索", exact: true })
      .click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toEqual({
      path: "rebuild-library-search",
      body: { protocol_version: 1, request: { kind: "rebuild" } },
    });
    await expect
      .poll(() => library.textContent())
      .toContain(retrievalStrings.libraryRewritten(2));
    // Everything current: no line at all.
    Object.assign(fake, {
      rule_current: true,
      rule_reason: null,
      library_search_rule_current: true,
    });
    await page.reload();
    await page
      .locator('input[placeholder="输入要查找的问题或关键词"]')
      .waitFor();
    await page.waitForTimeout(500);
    expect(await line.count()).toBe(0);
    expect(await library.count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
