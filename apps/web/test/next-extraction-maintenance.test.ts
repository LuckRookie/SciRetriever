import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  independentNextAssets,
  motionOptions,
} from "./next-workspace-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  extractionSpecHash,
  EXTRACTION_SCHEMA_URI,
  parseAsset,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { startMaintenanceWorkbench } from "../../server/src/bootstrap/workbench.js";
import { migrateDocumentCatalog } from "../../server/src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../../server/src/storage/sqlite/retrieval-migration.js";
import { migrateExtractionCatalog } from "../../server/src/storage/sqlite/extraction-migration.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../server/src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
// Budget covers the complete real-browser migration, delivery, retry and rejection journey.
it("delivers a v5 extraction batch through the real Chromium maintenance form and refuses forged responses", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-extraction-web-"));
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  let workbench:
    | Awaited<ReturnType<typeof startMaintenanceWorkbench>>
    | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/extraction-web.pdf");
    const asset = parseAsset({
      asset_id: id(970),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/extraction-web.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(971),
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: id(972),
        source_kind: "asset-provider",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      }),
    });
    await app.close();
    for (const [migrate, backup] of [
      [migrateDocumentCatalog, "before-v3.sqlite"],
      [migrateRetrievalCatalog, "before-v4.sqlite"],
      [migrateExtractionCatalog, "before-v5.sqlite"],
    ] as const)
      await migrate({
        catalog_path: join(home, "catalog.sqlite"),
        backup_path: join(home, backup),
      });
    workbench = await startMaintenanceWorkbench({
      home,
      assets: await independentNextAssets("maintenance"),
    });
    const content = {
      schema_version: 1 as const,
      spec_id: "synthetic.web",
      spec_version: "1",
      record_meaning: "One synthetic value",
      output_schema: {
        $schema: EXTRACTION_SCHEMA_URI,
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      field_instructions: [],
      inclusion_rules: [],
      missing_value_rules: [],
      evidence_policy: {
        field_granularity: "file" as const,
        required_pointers: "record-root" as const,
        cross_input_relation: "optional" as const,
      },
      required_capabilities: ["material-file-v1" as const],
    };
    const spec = { ...content, spec_sha256: await extractionSpecHash(content) };
    const prepared = await workbench.application.extractionPreparation.prepare({
      spec,
      inputs: [
        {
          input_id: "source-1",
          literature_id: FIXTURE_LITERATURE.literature_id,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          document_version_id: null,
        },
      ],
    });
    const evidence = (
      await workbench.application.documentRead.materialEvidence({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
      })
    ).evidence;
    browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage(motionOptions());
    await page.goto(`${workbench.origin}/?view=set`);
    await page.getByRole("tab", { name: "规范与交付", exact: true }).click();
    const output = async () => {
      const disclosure = page.getByRole("button", {
        name: "回执与固定输入",
        exact: true,
      });
      if ((await disclosure.count()) === 0) return "";
      if ((await disclosure.getAttribute("aria-expanded")) !== "true")
        await disclosure.click();
      return page.getByTestId("delivery-result").textContent();
    };
    const confirm = async (label: string, twice = false) => {
      await page.getByRole("button", { name: label, exact: true }).click();
      const button = page
        .getByRole("dialog")
        .getByRole("button", { name: label, exact: true });
      if (twice)
        await button.evaluate((element) => {
          (element as HTMLButtonElement).click();
          (element as HTMLButtonElement).click();
        });
      else await button.click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    };
    await page
      .getByLabel("调用方 namespace", { exact: true })
      .fill("local.web");
    await page
      .getByLabel("输入准备结果 JSON", { exact: true })
      .fill(JSON.stringify(prepared));
    await confirm("创建 operation");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    const operationId = await page
      .getByLabel("Operation ID", { exact: true })
      .inputValue();
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
    const intent = {
      schema_version: 1,
      operation_id: operationId,
      submission_key: "web-key",
      batch_id: "web-batch",
      records: [
        {
          record_id: "web-record",
          payload: { value: "alpha" },
          field_evidence: [
            { pointer: "", sources: [{ input_id: "source-1", evidence }] },
          ],
        },
      ],
      relations: [],
      coverage: [
        {
          input_id: "source-1",
          status: "processed-with-records",
          reason: null,
        },
      ],
      producer: {
        method_id: "synthetic.web",
        method_version: "1",
        usage: { calls: 1 },
      },
    };
    await page
      .getByLabel("候选批次 JSON", { exact: true })
      .fill(JSON.stringify(intent));
    const path = "**/api/v1/maintenance/extraction-submit";
    await page.route(path, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"protocol_version":1,"result":{}}',
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    await page.unroute(path);
    await page.route(path, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          code: "é".repeat(5000),
        }),
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("交付响应过大");
    await page.unroute(path);
    const sessionPath = "**/api/v1/maintenance/session";
    await page.route(sessionPath, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ protocol_version: 1, csrf: "é".repeat(2100) }),
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("交付响应过大");
    await page.unroute(sessionPath);
    let sends = 0;
    await page.route(path, (route) => {
      sends++;
      void route.continue();
    });
    await confirm("提交候选批次", true);
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    expect(sends).toBe(1);
    const first = JSON.parse((await output()) ?? "null") as {
      receipt: {
        receipt_id: string;
        submission_sha256: string;
        protected_materials: unknown[];
      };
      accepted_batch: unknown;
    };
    expect(first.accepted_batch).toMatchObject({
      records: [{ payload: { value: "alpha" } }],
    });
    const receiptId = first.receipt.receipt_id;
    await page.unroute(path);
    await page.route(path, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          result: {
            ...first,
            receipt: { ...first.receipt, submission_sha256: "f".repeat(64) },
          },
        }),
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    await page.unroute(path);
    await page.route(path, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          result: {
            ...first,
            receipt: { ...first.receipt, protected_materials: [] },
          },
        }),
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    await page.unroute(path);
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    const retried = JSON.parse((await output()) ?? "null") as {
      receipt: { receipt_id: string };
    };
    expect(retried.receipt.receipt_id).toBe(receiptId);
    const receiptPath = "**/api/v1/maintenance/extraction-receipt";
    for (const raw of [
      '{"protocol_version":2,"result":{}}',
      '{"protocol_version":1,"protocol_version":1,"result":{}}',
      JSON.stringify({
        protocol_version: 1,
        result: { ...first.receipt, receipt_id: id(999) },
      }),
      JSON.stringify({
        protocol_version: 1,
        result: { ...first.receipt, checks_json: "{}" },
      }),
    ]) {
      await page.route(receiptPath, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: raw,
        }),
      );
      await page
        .getByRole("button", { name: "读取回执与保护", exact: true })
        .click();
      await expect
        .poll(() => page.getByTestId("delivery-feedback").textContent())
        .toContain("请求失败");
      await page.unroute(receiptPath);
    }
    await page
      .getByRole("button", { name: "读取回执与保护", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    await page.getByLabel("候选批次 JSON", { exact: true }).fill(
      JSON.stringify({
        ...intent,
        submission_key: "new-key",
        batch_id: "new-batch",
      }),
    );
    expect(await output()).toBe("");
    await confirm("关闭 operation");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("operation-not-open");
    await confirm("创建 operation");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    const cancelledId = await page
      .getByLabel("Operation ID", { exact: true })
      .inputValue();
    await confirm("取消 operation");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    await page.getByLabel("候选批次 JSON", { exact: true }).fill(
      JSON.stringify({
        ...intent,
        operation_id: cancelledId,
        submission_key: "cancel-key",
        batch_id: "cancel-batch",
      }),
    );
    await confirm("提交候选批次");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("operation-not-open");
  } finally {
    await browser?.close();
    await workbench?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
