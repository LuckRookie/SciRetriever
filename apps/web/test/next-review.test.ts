import { expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { SqliteAnnotationStorage } from "../../server/src/storage/structure-annotations.js";
import { topicDraft } from "../../server/test/tag-fixture.js";

it(
  "uses registered reading declarations and shows snapshot definitions and named differences",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id;
      const before = await w.env.app.snapshots.create({
        kind: "literatures",
        literature_ids: [id],
      });

      const fields = await w.env.app.metadataFields.read(id);
      await w.env.app.metadataFields.edit({
        literature_id: id,
        set: [{ field: "title", value: "Revised measurement paper" }],
        unlock: [],
        expected_revision: fields.metadata_revision,
      });
      const after = await w.env.app.snapshots.create({
        kind: "literatures",
        literature_ids: [id],
      });
      await w.page.route("**/api/v1/query/processors**", async (route) => {
        if (route.request().postDataJSON().operation !== "list")
          return route.continue();
        const response = await route.fetch(),
          body = await response.json();
        body.result = body.result
          .filter((p: { id: string }) => p.id !== "records")
          .map((p: { id: string }) =>
            p.id === "summary"
              ? {
                  ...p,
                  reads: { parts: "supplementary", roles: ["si-methods"] },
                }
              : p,
          );
        await route.fulfill({ response, json: body });
      });
      await w.page.goto(
        `${w.origin}/?view=snapshots&snapshot=${before.snapshot_id}`,
      );
      await w.page
        .getByText("生成条件：手动选择 1 篇文献，固定其中的就绪成员。", {
          exact: true,
        })
        .waitFor();
      // The run dialog only offers registered operators and states what they read.
      await w.page
        .getByRole("button", { name: "运行算子…", exact: true })
        .click();
      const dialog = w.page.getByRole("dialog", {
        name: "运行算子",
        exact: true,
      });
      expect(
        await dialog.getByRole("radio", { name: /^记录提取/ }).isDisabled(),
      ).toBe(true);
      await dialog.getByText("全文总结", { exact: true }).click();
      await dialog.getByRole("button", { name: "下一步", exact: true }).click();
      await dialog
        .getByText("读取：补充材料 · 补充方法", { exact: true })
        .waitFor();
      await w.page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await w.page.getByRole("button", { name: /对比快照/ }).click();
      await w.page.getByRole("option", { name: /1 篇/ }).click();
      await w.page
        .getByRole("button", { name: "比较快照", exact: true })
        .click();
      await w.page
        .getByRole("button", { name: "描述变化 · 1", exact: true })
        .click();
      await w.page
        .getByRole("button", { name: "Revised measurement paper", exact: true })
        .waitFor();
      expect(after.snapshot_id).not.toBe(before.snapshot_id);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "binds manual role edits to the authenticated session and ignores a spoofed actor",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id,
        part = (await w.env.app.archive.status(id)).parts[0]!;
      const store = new SqliteAnnotationStorage(
        w.env.app.database,
        w.env.app.files,
      );
      const annotation = (await store.current(part.document_version_id!))!;
      const auth = await (
        await w.page.context().request.get(`${w.origin}/auth/status`)
      ).json();
      expect(auth.actor).toMatch(
        /^web-session:\d{4}-\d\d-\d\dT[\d:.]+Z:[a-f0-9-]{36}$/,
      );
      const grant = await (
        await w.page.context().request.post(`${w.origin}/api/clients`, {
          headers: { Origin: w.origin, "X-Workbench-Init": "1" },
          data: {},
        })
      ).json();
      const response = await w.page
        .context()
        .request.post(
          `${w.origin}/api/v1/maintenance/document-role?client_id=${grant.client_id}`,
          {
            headers: {
              Origin: w.origin,
              "X-Workbench-Csrf": grant.csrf,
              "X-Sciretriever-Protocol-Version": "1",
            },
            data: {
              protocol_version: 1,
              request: {
                document_version_id: part.document_version_id,
                section_id: annotation.sections[0]!.section_id,
                role: "methods",
                expected_manual_revision: annotation.manual_revision,
                actor: "forged-person",
              },
            },
          },
        );
      expect(response.status()).toBe(200);
      const db = new DatabaseSync(join(w.env.home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare(
              "SELECT actor FROM structure_role_decisions WHERE document_version_id=?",
            )
            .all(part.document_version_id!),
        ).toEqual([{ actor: auth.actor }]);
      } finally {
        db.close();
      }
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "executes an explicit document publication step without other archive stages",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id,
        calls = w.env.modelCalls;
      const before = await w.env.app.archive.status(id);
      await w.page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
      await w.page
        .getByRole("button", { name: "单步处理", exact: true })
        .click();
      const dialog = w.page.getByRole("dialog", {
        name: "单步处理文献",
        exact: true,
      });
      await dialog.getByRole("button", { name: /处理步骤/ }).click();
      await w.page
        .getByRole("option", { name: "全文发布", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "确认执行此步骤", exact: true })
        .click();
      await dialog
        .getByRole("status")
        .filter({ hasText: "此步骤已完成" })
        .waitFor();
      expect(w.env.modelCalls).toBe(calls);
      const after = await w.env.app.archive.status(id);
      expect(after.parts[0]!.steps).toEqual(before.parts[0]!.steps);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "runs vocabulary consolidation only after explicit confirmation",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const tags = w.env.app.tags;
      await tags.change({
        mutation: { op: "create", tag: topicDraft("Review topic") },
        expected_version: (await tags.state()).version,
        reason: "review fixture",
      });
      const before = w.env.modelCalls;
      await w.page.goto(`${w.origin}/?view=tags`);
      await w.page
        .getByRole("button", { name: "整理词表", exact: true })
        .click();
      expect(w.env.modelCalls).toBe(before);
      const response = w.page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/maintenance/tags") &&
          r.request().postDataJSON().request.operation === "consolidate",
      );
      await w.page
        .getByRole("dialog", { name: "整理词表", exact: true })
        .getByRole("button", { name: "确认整理", exact: true })
        .click();
      expect((await response).status()).toBe(200);
      const state = await tags.state();
      expect(state.consolidated_version).toBe(state.version);
      expect(w.env.modelCalls).toBeGreaterThan(before);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "recreates a snapshot for a stale result and preserves its specification before explicit rerun",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id;
      w.env.setModel((input) => ({
        outcome: "completed",
        title: "Measurement",
        statements: [
          {
            statement_id: "s1",
            category: "finding",
            epistemic: "reported",
            text: "Energy was measured.",
            conditions: [],
            quantity: null,
            evidence_segment_ids: [input.segments![0]!.segment_id],
          },
        ],
      }));
      const spec = {
        purpose: "question",
        question: "What energy was measured?",
      };
      const run = await w.env.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "review-original",
        name: "Original review",
        processor: { id: "summary", version: "2" },
        spec,
        inputs: [{ kind: "literature", literature_id: id }],
      });
      expect(run.failures).toEqual([]);
      const result = (await w.env.app.processorRead!.list()).items[0]!;
      w.env.setText(
        "# Measurements\nThe corrected measured energy was 4.3 eV.",
      );
      await w.env.build(w.env.parseRequest);
      expect(
        (await w.env.app.processorRead!.byId(String(result.result_id)))!
          .freshness?.state,
      ).toBe("stale");
      const before = w.env.modelCalls;
      await w.page.goto(
        `${w.origin}/?view=ext&result=${result.result_id}&resultHash=${result.content_sha256}`,
      );
      await w.page
        .getByRole("button", { name: "基于新快照重新运行", exact: true })
        .click();
      await w.page
        .getByRole("button", {
          name: "按原结果范围生成新快照",
          exact: true,
        })
        .click();
      await w.page
        .getByRole("button", { name: "确认启动", exact: true })
        .waitFor();
      expect(w.env.modelCalls).toBe(before);
      const submitted = w.page.waitForRequest((r) =>
        r.url().includes("/api/v1/maintenance/processor-submit"),
      );
      await w.page
        .getByRole("button", { name: "确认启动", exact: true })
        .click();
      const body = (await submitted).postDataJSON();
      const original = (await w.env.app.processorRead!.byId(
        String(result.result_id),
      ))!.result.invocation.spec;
      expect(original).toMatchObject(spec);
      expect(body.request.spec).toEqual(original);
      expect(body.request.inputs[0]).toMatchObject({ kind: "snapshot" });
      expect(
        (await w.env.app.processorRead!.byId(String(result.result_id)))!.result
          .invocation.spec,
      ).toEqual(original);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "keeps unsaved proofreading on navigation and a concurrent-version conflict",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id,
        asset = w.env.parseRequest.asset_id,
        p = w.page;
      await p.goto(`${w.origin}/?literature=${id}&reader=edit`);
      const editor = p.getByRole("region", { name: "校订稿编辑", exact: true }),
        field = editor.getByRole("textbox", {
          name: "第 1 页校订稿",
          exact: true,
        });
      await field.waitFor();
      const initial = await field.inputValue();
      await field.fill(initial + "\n\nMy pending change.\n\n");
      await p.getByRole("tab", { name: "全文", exact: true }).click();
      await p
        .getByRole("dialog", { name: "保留未保存的校订？", exact: true })
        .getByRole("button", { name: "继续编辑", exact: true })
        .click();
      expect(await field.inputValue()).toContain("My pending change.");
      const current = (await w.env.app.archive.status(id)).parts[0]!
        .proofread_id;
      const { executeMaintenance } = await import(
        "../../server/src/entry/maintenance-operations.js"
      );
      await executeMaintenance(w.env.app, "proofread-save", {
        literature_id: id,
        asset_id: asset,
        proofread_id: current,
        markdown: initial + "\n\nOther session change.\n\n",
        actor: "test:concurrent-editor",
      });
      await editor
        .getByRole("button", { name: "保存修订", exact: true })
        .click();
      await editor.getByRole("alert").waitFor();
      expect(await field.inputValue()).toContain("My pending change.");
      const latest = await w.env.app.proofreading!.editor({ asset_id: asset });
      expect(latest.text).toContain("Other session change.");
      expect(latest.text).not.toContain("My pending change.");
      for (const width of [1440, 390]) {
        await p.setViewportSize({ width, height: 900 });
        expect(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);
