import { expect, it } from "vitest";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { executeConfiguration } from "../../server/src/entry/configuration-operations.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

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
      sourceOperation: (operation, value, signal) =>
        executeConfiguration(owner, operation, value, signal),
    }),
    ...{ ready: 'label:has-text("文献库文件")' },
  });
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "生成全文", exact: true }).click();
    const profile = page.locator(".ui-definition", { hasText: "解析方式" });
    await profile.waitFor();
    expect(await profile.textContent()).toContain("vlm-engine");
    await page
      .getByRole("textbox", { name: "每篇标签上限", exact: true })
      .fill("9");
    // A number field commits on leaving it; then the section's save appears.
    await page.keyboard.press("Tab");
    const publication = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/configuration/publish-json",
    );
    await page
      .getByRole("button", { name: "保存生成全文的设置", exact: true })
      .click();
    expect((await publication).status()).toBe(200);
    await expect
      .poll(
        async () => (await owner!.read()).configuration.tags.max_per_literature,
      )
      .toBe(9);
    // The per-document call budget is gone; archive stops on repeated errors or no progress.
    expect(
      await page.getByRole("textbox", { name: "每篇矫正调用上限" }).count(),
    ).toBe(0);
    await page.getByRole("tab", { name: "运行状态", exact: true }).click();
    const runtime = page.locator(".settings-runtime[data-state]");
    await expect.poll(() => runtime.textContent()).toContain("core");
    expect(await runtime.getAttribute("data-state")).toBe("restart-required");
    await page.getByRole("tab", { name: "解析与浏览器", exact: true }).click();
    await page
      .getByRole("textbox", { name: "浏览器个人资料", exact: true })
      .fill("synthetic-unsaved-profile");
    await page.getByRole("tab", { name: "文献来源", exact: true }).click();
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
    await page.getByRole("tab", { name: "解析与浏览器", exact: true }).click();
    expect(
      await page
        .getByRole("textbox", { name: "浏览器个人资料", exact: true })
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
    // Source credentials live in the source directory; only model services stay under 凭据.
    await page.getByRole("tab", { name: "凭据", exact: true }).click();
    await page.getByRole("button", { name: /凭据类型/ }).click();
    expect(
      await page.getByRole("option", { name: "文献来源 API key" }).count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    // The configuration changed outside this page above; wait for the directory to be read again.
    const reread = page.waitForResponse((r) =>
      r.url().includes("/api/configuration/sources"),
    );
    await page.getByRole("tab", { name: "文献来源", exact: true }).click();
    await reread;
    const directory = page.getByRole("region", {
      name: "文献来源",
      exact: true,
    });
    const core = directory.getByRole("row").filter({ hasText: "CORE" });
    await core.getByRole("button", { name: /缺 API Key/ }).click();
    const syntheticSecret = "synthetic-ui-secret-never-returned";
    const secret = directory.locator(".source-secret input").first();
    await secret.fill(syntheticSecret);
    await directory.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => directory.getByRole("status").allTextContents())
      .toContainEqual(expect.stringContaining("已保存"));
    expect(await secret.inputValue()).toBe("");
    await expect.poll(() => core.textContent()).toContain("API Key 已配置");
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
    expect(await runtime.textContent()).toContain("重启服务后生效");
    expect(await runtime.textContent()).toContain("core");
    expect(await runtime.getAttribute("data-state")).toBe("restart-required");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
