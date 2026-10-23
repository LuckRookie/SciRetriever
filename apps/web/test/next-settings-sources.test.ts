import { expect, it } from "vitest";
import type { Page } from "playwright";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
async function mode(page: Page, label: string, option: string) {
  await page
    .getByRole("radiogroup", { name: label, exact: true })
    .getByText(option, { exact: true })
    .click();
}
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function check(page: Page, name: string, checked: boolean) {
  const f = page.getByRole("checkbox", { name, exact: true });
  if ((await f.isChecked()) !== checked) {
    await f.focus();
    await page.keyboard.press("Space");
  }
}
it("preserves source parameters and runtime sections, rejects incomplete settings, and only probes saved configuration after confirmation", async () => {
  let owner: TypeScriptConfigurationOwner;
  let baseline = "";
  const w = await nextWorkspace({
    path: "/?view=set&setting=sources",
    ready: 'label:has-text("元数据结果上限")',
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      const initial = await owner.read();
      await owner.publishConfiguration(
        {
          ...initial.configuration,
          sources: {
            ...initial.configuration.sources,
            metadata: {
              ...initial.configuration.sources.metadata,
              mode: "custom",
              providers: ["openalex", "crossref"],
            },
            acquisition: {
              ...initial.configuration.sources.acquisition,
              mode: "custom",
              providers: ["core"],
            },
          },
        },
        initial.revision,
        ["sources"],
      );
      baseline = (await owner.read()).revision;
    },
    configuration: () => ({
      runtime_revision: baseline,
      read: (s) => owner.read(s),
      status: (s) => owner.status(s),
      publishConfiguration: (c, r, sections, s) =>
        owner.publishConfiguration(c, r, sections, s),
      credential: (e, r, s) => owner.credential(e, r, s),
    }),
  });
  try {
    const page = w.page,
      providers = (await owner!.read()).configuration.providers,
      models = (await owner!.read()).configuration.models;
    const save = async (name: string) => {
      const r = page.waitForResponse((r) =>
        r.url().includes("/api/configuration/publish-json"),
      );
      await page.getByRole("button", { name, exact: true }).click();
      expect((await r).status()).toBe(200);
    };
    const tab = async (name: string) =>
      page.getByRole("tab", { name, exact: true }).click();
    await check(page, "Web of Science", true);
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("37");
    await select(page, "产品", "Expanded");
    await page
      .getByRole("textbox", { name: "数据库", exact: true })
      .fill("WOS-Synthetic");
    await page.getByRole("textbox", { name: "版本", exact: true }).fill("2026");
    await mode(page, "获取来源模式", "自动");
    await save("保存来源配置");
    expect((await owner!.read()).configuration.sources).toMatchObject({
      metadata: {
        mode: "custom",
        providers: ["openalex", "crossref", "web-of-science"],
        limit: 37,
        web_of_science: {
          product: "expanded",
          database: "WOS-Synthetic",
          edition: "2026",
        },
      },
      acquisition: { mode: "auto", providers: [] },
    });
    await mode(page, "获取来源模式", "自定义");
    await check(page, "Unpaywall", true);
    const beforeInvalid = (await owner!.read()).revision;
    await page
      .getByRole("button", { name: "保存来源配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("联系邮箱"));
    expect((await owner!.read()).revision).toBe(beforeInvalid);
    await page
      .getByRole("textbox", { name: "Unpaywall 联系邮箱", exact: true })
      .fill("research@example.org");
    await save("保存来源配置");
    const saved = await owner!.read();
    expect(saved.configuration.sources.acquisition).toMatchObject({
      mode: "custom",
      providers: ["unpaywall"],
      unpaywall: { contact_email: "research@example.org" },
    });
    expect(saved.configuration.providers).toEqual(providers);
    expect(saved.configuration.models).toEqual(models);
    await page.getByRole("textbox", { name: "数据库", exact: true }).fill("");
    await page
      .getByRole("button", { name: "保存来源配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("产品和数据库"));
    expect((await owner!.read()).revision).toBe(saved.revision);
    await page
      .getByRole("textbox", { name: "数据库", exact: true })
      .fill("WOS-Synthetic");
    await tab("解析与 Browser");
    await page
      .getByRole("textbox", { name: "Browser profile", exact: true })
      .fill("web-fixture");
    await page
      .getByRole("textbox", { name: "MinerU 服务地址", exact: true })
      .fill("http://127.0.0.1:8000");
    await select(page, "MinerU 连接模式", "本机 loopback");
    await page
      .getByRole("textbox", { name: "MinerU 模型", exact: true })
      .fill("synthetic-parser");
    await save("保存运行配置");
    const runtime = await owner!.read();
    expect(runtime.configuration).toMatchObject({
      browser: { profile: "web-fixture" },
      parsing: {
        base_url: "http://127.0.0.1:8000",
        connection_mode: "loopback",
        model_identity: "synthetic-parser",
      },
    });
    expect(runtime.configuration.sources).toEqual(saved.configuration.sources);
    await owner!.publishConfiguration(
      {
        ...runtime.configuration,
        browser: {
          ...runtime.configuration.browser,
          profile: "external-change",
        },
      },
      runtime.revision,
      ["browser"],
    );
    await page
      .getByRole("textbox", { name: "Browser profile", exact: true })
      .fill("draft-after-conflict");
    await page
      .getByRole("button", { name: "保存运行配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("草稿仍保留"));
    expect(
      await page
        .getByRole("textbox", { name: "Browser profile", exact: true })
        .inputValue(),
    ).toBe("draft-after-conflict");
    const probes: unknown[] = [];
    await page.route("**/api/configuration/probe?*", async (route) => {
      probes.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: { result: { outcome: "passed", reason: "synthetic-probe" } },
      });
    });
    const beforeProbe = (await owner!.read()).revision;
    for (const name of ["测试 Parse", "测试 Browser 模型"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page
        .getByRole("dialog", { name: "测试连接" })
        .getByRole("button", { name: "确认测试", exact: true })
        .click();
    }
    await expect.poll(() => probes.length).toBe(2);
    expect(probes).toEqual([
      { owner: "parse", target: null, image: false },
      { owner: "browser-model", target: null, image: true },
    ]);
    expect((await owner!.read()).revision).toBe(beforeProbe);
    await page.getByRole("button", { name: "刷新配置", exact: true }).click();
    await page.getByRole("button", { name: "读取保存值", exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole("textbox", { name: "Browser profile", exact: true })
          .inputValue(),
      )
      .toBe("external-change");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
