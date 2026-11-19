import { expect, it } from "vitest";
import type { Page } from "playwright";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { executeConfiguration } from "../../server/src/entry/configuration-operations.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
async function select(
  scope: Page | ReturnType<Page["locator"]>,
  page: Page,
  label: string,
  option: string,
) {
  await scope
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
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
      sourceOperation: (operation, value, s) =>
        executeConfiguration(owner, operation, value, s),
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
    // Sources are chosen and configured in the directory; each change saves at once.
    const directory = page.getByRole("region", {
      name: "文献来源",
      exact: true,
    });
    const row = (name: string) =>
      directory.getByRole("row").filter({ hasText: name }).first();
    const sources = async () => (await owner!.read()).configuration.sources;
    const wos = directory.getByRole("checkbox", {
      name: "Web of Science：主题检索",
      exact: true,
    });
    await wos.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => [...(await sources()).metadata.providers].sort())
      .toEqual(["crossref", "openalex", "web-of-science"]);
    await row("Web of Science").locator(".source-config-toggle").click();
    const editor = directory.locator(".source-editor");
    await select(editor, page, "产品", "Expanded");
    await editor
      .getByRole("textbox", { name: "数据库", exact: true })
      .fill("WOS-Synthetic");
    await editor
      .getByRole("textbox", { name: "版本", exact: true })
      .fill("2026");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await sources()).metadata.web_of_science)
      .toMatchObject({
        product: "expanded",
        database: "WOS-Synthetic",
        edition: "2026",
      });
    // The form-level limit keeps what the directory saved.
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("37");
    await save("保存来源配置");
    expect(await sources()).toMatchObject({
      metadata: {
        mode: "custom",
        providers: expect.arrayContaining([
          "openalex",
          "crossref",
          "web-of-science",
        ]),
        limit: 37,
        web_of_science: { product: "expanded", database: "WOS-Synthetic" },
      },
      acquisition: { mode: "custom", providers: ["core"] },
    });
    await directory
      .getByRole("tablist", { name: "PDF 来源方式" })
      .getByRole("tab", { name: "自动", exact: true })
      .click();
    await expect
      .poll(async () => (await sources()).acquisition)
      .toMatchObject({ mode: "auto", providers: [] });
    // An invalid limit is refused and nothing is written.
    const beforeInvalid = (await owner!.read()).revision;
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("0");
    await page
      .getByRole("button", { name: "保存来源配置", exact: true })
      .click();
    await expect
      .poll(() => page.getByText("结果上限需为正整数。").count())
      .toBeGreaterThan(0);
    expect((await owner!.read()).revision).toBe(beforeInvalid);
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("37");
    // A source missing a required value says so on its row until it is filled.
    await expect
      .poll(() => row("Unpaywall").textContent())
      .toContain("缺联系邮箱");
    await row("Unpaywall").locator(".source-config-toggle").click();
    await editor
      .getByRole("textbox", { name: "联系邮箱", exact: true })
      .fill("research@example.org");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await sources()).acquisition.unpaywall)
      .toMatchObject({ contact_email: "research@example.org" });
    await expect
      .poll(() => row("Unpaywall").textContent())
      .toContain("联系邮箱已配置");
    const saved = await owner!.read();
    expect(saved.configuration.providers).toEqual(providers);
    expect(saved.configuration.models).toEqual(models);
    // The browser lives with getting PDFs, the parser with the full text.
    await page
      .getByRole("textbox", { name: "浏览器个人资料", exact: true })
      .fill("web-fixture");
    await save("保存浏览器设置");
    await tab("生成全文");
    await page
      .getByRole("textbox", { name: "MinerU 服务地址", exact: true })
      .fill("http://127.0.0.1:8000");
    await select(page, page, "MinerU 连接模式", "本机 loopback");
    await page
      .getByRole("textbox", { name: "MinerU 模型", exact: true })
      .fill("synthetic-parser");
    await save("保存解析服务");
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
    await tab("获取 PDF");
    await page
      .getByRole("textbox", { name: "浏览器个人资料", exact: true })
      .fill("draft-after-conflict");
    await page
      .getByRole("button", { name: "保存浏览器设置", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("草稿仍保留"));
    expect(
      await page
        .getByRole("textbox", { name: "浏览器个人资料", exact: true })
        .inputValue(),
    ).toBe("draft-after-conflict");
    const probes: unknown[] = [];
    await page.route("**/api/configuration/probe?*", async (route) => {
      probes.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: {
          result:
            probes.length === 1
              ? { outcome: "passed", reason: null }
              : { outcome: "failed", reason: "model-authentication-rejected" },
        },
      });
    });
    const beforeProbe = (await owner!.read()).revision;
    // The parser is tested under 生成全文, the browser model under 获取 PDF.
    const results: string[] = [];
    for (const [section, name] of [
      ["生成全文", "测试 解析服务"],
      ["获取 PDF", "测试 浏览器模型"],
    ] as const) {
      await tab(section);
      await page.getByRole("button", { name, exact: true }).click();
      await page
        .getByRole("dialog", { name: "测试连接" })
        .getByRole("button", { name: "测试", exact: true })
        .click();
      await expect
        .poll(() => page.locator(".configuration-probe [role=status]").count())
        .toBe(1);
      results.push(
        (await page
          .locator(".configuration-probe [role=status]")
          .textContent())!,
      );
    }
    expect(probes).toEqual([
      { owner: "parse", target: null, image: false },
      { owner: "browser-model", target: null, image: true },
    ]);
    expect(results).toEqual([
      "测试通过，连接正常。",
      "测试结果：失败。模型服务拒绝了 API key，请在“模型服务”里检查这个服务的密钥。",
    ]);
    expect((await owner!.read()).revision).toBe(beforeProbe);
    await tab("高级");
    await page
      .getByRole("button", { name: "重新读取配置", exact: true })
      .click();
    await page.getByRole("button", { name: "读取保存值", exact: true }).click();
    await tab("获取 PDF");
    await expect
      .poll(() =>
        page
          .getByRole("textbox", { name: "浏览器个人资料", exact: true })
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
