import { readingAssets } from "./reading-assets-fixture.js";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import {
  createInputManifest,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeSynthesisRequest,
  parseLiterature,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import { taskHttpAdapters } from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

async function workspace(withSynthesis = false, indexes = true) {
  const env = await coreProcessingFixture();
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
      "\n## 中文\n纳米晶 合成 nanocrystal\n\n钙钛矿纳米晶合成\n",
  );
  const parsed = await env.app.documentProcessing.parseDocuments(
    env.parseRequest,
  );
  const material = await env.app.documentRead.materialEvidence({
    literature_id: env.parseRequest.literature_id,
    asset_id: env.asset.asset_id,
  });
  if (material.evidence.target_kind !== "material")
    throw new Error("invalid fixture");
  const described = await env.app.documentRead.describe({
    document_version_id: parsed.document.document_version_id,
  });
  const input = await createInputManifest([
    {
      input_id: "source-1",
      literature_id: env.parseRequest.literature_id,
      material: material.evidence.material,
      document: described.document,
      capabilities: [
        "material-file-v1",
        "document-text-v1",
        "document-segment-v1",
      ],
      gaps: [],
    },
  ]);
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
  const knowledge = await env.app.knowledgeAnalysis.analyze(
    await parseKnowledgeAnalysisRequest({
      schema_version: 1,
      input,
      purpose: "overview",
      question: null,
      default_update: null,
    }),
  );
  if (withSynthesis) {
    const prepared = await env.app.synthesisPreparation!.prepare({
      policy: "require-all",
      inputs: [
        {
          kind: "knowledge",
          input_id: "overview",
          source_artifact_id: knowledge.artifact!.artifact_id,
        },
      ],
    });
    env.setModel((request) => {
      const candidates = request.candidates as {
        id: string;
        text: string;
        category: string;
        epistemic: string;
        conditions: string[];
        quantity: unknown;
      }[];
      return {
        title: "Synthetic synthesis",
        statements: candidates.map((candidate, index) => ({
          statement_id: `synth-${index}`,
          category: candidate.category,
          epistemic: candidate.epistemic,
          relation: "single-source",
          conflict_group_id: null,
          text: candidate.text,
          conditions: candidate.conditions,
          quantity: candidate.quantity,
          source_ids: [candidate.id],
        })),
      };
    });
    await env.app.maintenance!.synthesize!(
      await parseKnowledgeSynthesisRequest({
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "Compare nanocrystal evidence",
        policy: "require-all",
      }),
    );
  }
  if (indexes) {
    await env.app.maintenance!.rebuildIndex();
    await env.app.maintenance!.rebuildKnowledgeIndex!();
  }
  const query = await createQueryApplication(env.home);
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("unexpected browser action");
  });
  const assets = new Map<string, WorkbenchStaticAsset>(await readingAssets());
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
    ["/workspace.css", "workspace.css", "text/css"],
  ] as const)
    assets.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const bundle = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  assets.set("/live.js", {
    contentType: "text/javascript",
    body: bundle.outputFiles[0]!.contents,
  });
  const server = await startWorkbenchHttp({
    ...taskHttpAdapters(env.app),
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
  await page.goto(`${server.origin}/?view=ask`);
  await page.locator("#askIn").waitFor();
  const calls = { model: env.modelCalls, parse: env.parseCalls };
  return {
    env,
    page,
    requests,
    parsed,
    knowledge,
    async close() {
      try {
        expect(errors).toEqual([]);
        expect(env.modelCalls).toBe(calls.model);
        expect(await env.app.jobs!.listJobs(10)).toEqual([]);
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
  await page.locator("#askIn").fill(query);
  await page.locator("#askKinds").selectOption(kind);
  await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/query/knowledge-context"),
    ),
    page.locator("#askGo").click(),
  ]);
  await expect
    .poll(() => page.locator("#ask-status").textContent())
    .toMatch(/条结果/u);
}

it("searches source and knowledge in all three modes, paginates, and explains Chinese lexical matching without blocking it", async () => {
  const w = await workspace();
  try {
    await search(w.page, "nanocrystal");
    expect(w.requests.at(-1)?.knowledge?.purposes).toEqual([
      "overview",
      "detailed",
      "question",
      "synthesis",
    ]);
    expect(await w.page.locator("#ask-results .tag").allTextContents()).toEqual(
      expect.arrayContaining(["原文", "知识"]),
    );
    await search(w.page, "nanocrystal", "source");
    expect(w.requests.at(-1)?.knowledge).toBeNull();
    expect(
      await w.page.locator("#ask-results .tag").allTextContents(),
    ).not.toContain("知识");
    await w.page.locator("#askCount").selectOption("5");
    await search(w.page, "nanocrystal", "source");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(5);
    await w.page.locator("#ask-more").click();
    await expect
      .poll(() => w.page.locator("#ask-results .blk").count())
      .toBeGreaterThan(5);
    expect(w.requests.at(-1)?.continuation).toBeTruthy();
    await search(w.page, "纳米晶", "knowledge");
    expect(await w.page.locator("#ask-language-hint").isVisible()).toBe(true);
    expect(await w.page.locator("#ask-language-hint").textContent()).toContain(
      "不会自动跨语言",
    );
    expect(await w.page.locator("#askIn").inputValue()).toBe("纳米晶");
    expect(await w.page.locator("#ask-results .tag").allTextContents()).toEqual(
      ["知识"],
    );
    await search(w.page, "纳米晶", "source");
    expect(await w.page.locator("#ask-results .tx").allTextContents()).toEqual([
      "纳米晶 合成 nanocrystal\n",
    ]);
    await search(w.page, "钙钛矿", "source");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(0);
    expect(await w.page.locator("#ask-status").textContent()).toContain(
      "关键词",
    );
    await search(w.page, "钙钛矿纳米晶合成", "source");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(1);
    await search(w.page, "纳米晶 nanocrystal", "source");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(1);
    expect(w.env.parseCalls).toBe(1);
  } finally {
    await w.close();
  }
}, 60000);

it("opens a synthesis hit as its own fixed artifact and returns to the same query", async () => {
  const w = await workspace(true);
  try {
    await search(w.page, "nanocrystal", "knowledge");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(2);
    await w.page
      .locator("#ask-results .blk")
      .filter({ has: w.page.locator(".tag", { hasText: "综合" }) })
      .locator("[data-source]")
      .click();
    expect(new URL(w.page.url()).searchParams.get("view")).toBe("syn");
    await expect
      .poll(() => w.page.locator("#synthesis-content").textContent())
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("statement")).toBe("synth-0");
    await w.page.reload();
    await expect
      .poll(() => w.page.locator("#synthesis-content").textContent())
      .toContain("Synthetic synthesis");
    // Reloaded links retain source identity; in-session return restores the query without re-querying.
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    await search(w.page, "nanocrystal", "knowledge");
    const before = w.requests.length;
    await w.page.locator("[data-source]").last().click();
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    expect(await w.page.locator("#askIn").inputValue()).toBe("nanocrystal");
    expect(w.requests.length).toBe(before);
    expect(w.env.parseCalls).toBe(1);
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
    await w.page.locator("#askIn").fill("observation");
    await w.page.locator("#askGo").click();
    await expect.poll(() => intercepted).toBe(true);
    await w.page.locator("#library-tab").click();
    await w.page.locator("#nav-ask").click();
    await expect
      .poll(() => w.page.locator("#ask-status").textContent())
      .toContain("已中止");
    await search(w.page, "纳米晶", "knowledge");
    release();
    await handled;
    expect(await w.page.locator("#askIn").inputValue()).toBe("纳米晶");
    expect(await w.page.locator("#ask-results .tag").allTextContents()).toEqual(
      ["知识"],
    );
    await w.page.route(
      "**/api/v1/query/knowledge-context?*",
      async (route) => {
        await route.fulfill({
          status: 503,
          json: { protocol_version: 1, code: "knowledge-index-unavailable" },
        });
      },
      { times: 1 },
    );
    await w.page.locator("#askGo").click();
    await expect
      .poll(() => w.page.locator("#ask-status").textContent())
      .toContain("knowledge-index-unavailable");
    expect(await w.page.locator("#askIn").inputValue()).toBe("纳米晶");
    await search(w.page, "nanocrystal", "source");
    expect(await w.page.locator("#ask-results .blk").count()).toBeGreaterThan(
      1,
    );
    expect(w.env.parseCalls).toBe(1);
  } finally {
    release();
    await w.close();
  }
}, 60000);

it("opens the fixed hit after a new default is published and restores the query and basket on return", async () => {
  const w = await workspace();
  try {
    await search(w.page, "纳米晶", "knowledge");
    await w.page.locator("[data-source]").first().click();
    await expect
      .poll(() => w.page.locator("#reader-body").textContent())
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("statement")).toBe(
      "finding-1",
    );
    const knowledgeUrl = w.page.url();
    await w.page
      .getByRole("button", { name: "在全文中核对", exact: true })
      .first()
      .click();
    await w.page.locator(".reading-evidence").first().waitFor();
    await w.page.getByRole("button", { name: "返回总结", exact: true }).click();
    await expect
      .poll(() => w.page.locator("#reader-body").textContent())
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("statement")).toBe(
      "finding-1",
    );
    await w.page.getByRole("button", { name: "返回检索", exact: true }).click();
    expect(await w.page.locator("#askIn").inputValue()).toBe("纳米晶");
    await search(w.page, "observation", "source");
    await w.page.locator("[data-basket]").first().click();
    const count = await w.page.locator("#ask-results .blk").count();
    w.env.setText(
      "# Revised\nA newer version that must not replace an old search hit.\n",
    );
    await w.env.app.documentProcessing.parseDocuments({
      ...w.env.parseRequest,
      expected_default_revision: 1,
    });
    await w.page.locator("[data-source]").first().click();
    await expect
      .poll(() => w.page.locator(".library-reading-text").textContent())
      .toContain("original observation");
    expect(new URL(w.page.url()).searchParams.get("document")).toBe(
      w.parsed.document.document_version_id,
    );
    const fixedUrl = w.page.url();
    await w.page.goBack();
    expect(await w.page.locator("#askIn").inputValue()).toBe("observation");
    expect(await w.page.locator("#askKinds").inputValue()).toBe("source");
    expect(await w.page.locator("#ask-results .blk").count()).toBe(count);
    expect(await w.page.locator("#basket li").count()).toBe(1);
    await w.page.goto(knowledgeUrl);
    await expect
      .poll(() => w.page.locator("#main").textContent())
      .toContain("nanocrystal 纳米晶");
    expect(new URL(w.page.url()).searchParams.get("statement")).toBe(
      "finding-1",
    );
    const tampered = new URL(fixedUrl);
    tampered.searchParams.set("representation", "0".repeat(64));
    await w.page.goto(tampered.href);
    await expect
      .poll(() => w.page.locator("#main").textContent())
      .toContain("不匹配");
    expect(await w.page.locator(".library-reading-text").count()).toBe(0);
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
      .poll(() => w.page.locator("#main").textContent())
      .toContain("未使用默认材料替代");
    expect(materialReads).toEqual([]);
    expect(await w.page.locator(".library-pdf-frame").count()).toBe(0);
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
    expect(w.env.parseCalls).toBe(2);
  } finally {
    await w.close();
  }
}, 60000);

it("explains unavailable indexes without claiming a keyword miss or starting maintenance", async () => {
  const w = await workspace(false, false);
  try {
    for (const kind of ["all", "source", "knowledge"]) {
      await search(w.page, "nanocrystal", kind);
      const status = await w.page.locator("#ask-status").textContent();
      expect(status).toContain("索引尚未建立");
      expect(status).toContain("显式重建");
      expect(status).not.toContain("未匹配当前关键词");
    }
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
      await w.page.locator("#askIn").waitFor();
    }
    expect(failedGrants).toEqual([]);
    await w.page.locator("#library-tab").click();
    const box = w.page.locator("[data-ck]").first();
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
