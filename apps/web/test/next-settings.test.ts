import { expect, it } from "vitest";
import type { Page } from "playwright";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

async function select(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
it("preserves drafts across section publications and conflicts, explains restart binding, and clears credentials", async () => {
  let owner: TypeScriptConfigurationOwner;
  let baseline = "",
    failStatus = false,
    armStatus = false;
  const w = await nextWorkspace({
    path: "/?view=set",
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      baseline = (await owner.read()).revision;
    },
    configuration: () => ({
      runtime_revision: baseline,
      runtime_capabilities: {
        parsing: { assembled: true, unavailable_reason: null },
        metadata: [],
        acquisition: [
          {
            source_name: "core",
            selected: true,
            assembled: false,
            ready_at_startup: false,
            failure_code: "missing-credential",
          },
        ],
      },
      read: (signal) => owner.read(signal),
      status: (signal) => {
        if (failStatus) {
          failStatus = false;
          throw new Error("synthetic readiness failure");
        }
        return owner.status(signal);
      },
      publishConfiguration: async (
        configuration,
        baseline,
        sections,
        signal,
      ) => {
        const result = await owner.publishConfiguration(
          configuration,
          baseline,
          sections,
          signal,
        );
        if (armStatus) {
          armStatus = false;
          failStatus = true;
        }
        return result;
      },
      credential: (edit, baseline, signal) =>
        owner.credential(edit, baseline, signal),
    }),
    ...{ ready: 'label:has-text("Catalog 路径")' },
  });
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "运行状态", exact: true }).click();
    const runtime = page.locator(".settings-section [data-state]");
    await expect.poll(() => runtime.textContent()).toContain("core");
    expect(await runtime.getAttribute("data-state")).toBe("restart-required");
    await page
      .getByRole("tab", { name: "解析与 Browser", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Browser profile", exact: true })
      .fill("synthetic-unsaved-profile");
    await page.getByRole("tab", { name: "文献来源", exact: true }).click();
    await select(page, "元数据来源模式", "自定义");
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("501");
    armStatus = true;
    await page
      .getByRole("button", { name: "保存来源配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("status").allTextContents())
      .toContainEqual(expect.stringContaining("状态读取失败"));
    expect((await owner!.read()).configuration.sources.metadata.limit).toBe(
      501,
    );
    await page
      .getByRole("tab", { name: "解析与 Browser", exact: true })
      .click();
    expect(
      await page
        .getByRole("textbox", { name: "Browser profile", exact: true })
        .inputValue(),
    ).toBe("synthetic-unsaved-profile");
    await page.getByRole("tab", { name: "文献来源", exact: true }).click();
    const saved = await owner!.read(),
      changed = structuredClone(saved.configuration);
    const updated = {
      ...changed,
      sources: {
        ...changed.sources,
        metadata: { ...changed.sources.metadata, limit: 88 },
      },
    };
    await owner!.publishConfiguration(updated, saved.revision, ["sources"]);
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("43");
    await page
      .getByRole("button", { name: "保存来源配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("revision 冲突"));
    expect(
      await page
        .getByRole("textbox", { name: "元数据结果上限", exact: true })
        .inputValue(),
    ).toBe("43");
    expect((await owner!.read()).configuration.sources.metadata.limit).toBe(88);
    await page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await page.getByRole("dialog", { name: "保留未保存的修改？" }).waitFor();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("view")).toBe("set");
    await page.getByRole("button", { name: "刷新配置", exact: true }).click();
    await page.getByRole("button", { name: "读取保存值", exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole("textbox", { name: "元数据结果上限", exact: true })
          .inputValue(),
      )
      .toBe("88");
    await page.getByRole("tab", { name: "凭据", exact: true }).click();
    await select(page, "凭据类型", "文献来源 API key");
    await page
      .getByRole("textbox", { name: "目标名称", exact: true })
      .fill("core");
    const syntheticSecret = "synthetic-ui-secret-never-returned";
    await page.getByLabel("凭据值", { exact: true }).fill(syntheticSecret);
    await page.getByRole("button", { name: "保存凭据", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("凭据值", { exact: true }).inputValue())
      .toBe("");
    await expect
      .poll(() => page.getByRole("status").allTextContents())
      .toContainEqual(expect.stringContaining("凭据已保存且不回显"));
    expect(await page.locator("body").textContent()).not.toContain(
      syntheticSecret,
    );
    expect(
      await page.evaluate(() => JSON.stringify(localStorage)),
    ).not.toContain(syntheticSecret);
    expect(
      await page.evaluate(
        () => `${location.href}\n${JSON.stringify(history.state)}`,
      ),
    ).not.toContain(syntheticSecret);
    await page.getByRole("tab", { name: "运行状态", exact: true }).click();
    await expect.poll(() => runtime.textContent()).toContain("下一次外部请求");
    expect(await runtime.textContent()).toContain("普通配置已保存");
    expect(await runtime.textContent()).toContain("重启服务后生效");
    expect(await runtime.textContent()).toContain("core");
    expect(await runtime.getAttribute("data-state")).toBe("restart-required");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
