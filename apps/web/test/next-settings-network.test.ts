import { expect, it } from "vitest";
import {
  TypeScriptConfigurationOwner,
  type ConfigurationProbeResult,
} from "../../server/src/configuration/owner.js";
import { executeConfiguration } from "../../server/src/entry/configuration-operations.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

it("saves the proxy and the requesters that use it separately, tests the proxy, and keeps its authentication write-only", async () => {
  let owner: TypeScriptConfigurationOwner;
  let probes = 0,
    baseline = "";
  const w = await nextWorkspace({
    path: "/?view=set&setting=network",
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      baseline = (await owner.read()).revision;
    },
    configuration: () => ({
      runtime_revision: baseline,
      read: (signal) => owner.read(signal),
      status: (signal) => owner.status(signal),
      publishConfiguration: (configuration, baseline, sections, signal) =>
        owner.publishConfiguration(configuration, baseline, sections, signal),
      credential: (edit, baseline, signal) =>
        owner.credential(edit, baseline, signal),
      sourceOperation: (operation, value, signal) =>
        executeConfiguration(owner, operation, value, signal),
      // No real proxy is contacted: the probe answers as a CONNECT that passed.
      probe: async (request) => {
        probes += 1;
        expect(request).toEqual({ owner: "proxy", target: null, image: false });
        return {
          owner: "proxy",
          target: null,
          egress: "proxy",
          outcome: "passed",
          execution: { elapsed_ms: 42 },
        } as unknown as ConfigurationProbeResult;
      },
    }),
    ready: 'label:has-text("代理地址")',
  });
  try {
    const page = w.page;
    // Without a saved address nothing can be routed, tested or authenticated.
    expect(await page.getByText("先填写并保存代理地址。").count()).toBe(1);
    expect(
      await page
        .getByRole("button", { name: "测试代理", exact: true })
        .isDisabled(),
    ).toBe(true);
    await page
      .getByRole("textbox", { name: "代理地址", exact: true })
      .fill("http://127.0.0.1:7890");
    await page.getByRole("button", { name: "保存代理", exact: true }).click();
    await expect
      .poll(async () => (await owner!.read()).configuration.network.proxy)
      .toBe("http://127.0.0.1:7890");
    expect(
      (await owner!.read()).configuration.network.via_proxy.sources,
    ).toEqual([]);

    // Each half saves on its own: an unsaved address edit survives saving the routes.
    await page.locator(".ui-choice", { hasText: "Semantic Scholar" }).click();
    await page.locator(".ui-choice", { hasText: "浏览器" }).click();
    await page
      .getByRole("textbox", { name: "代理地址", exact: true })
      .fill("http://127.0.0.1:7891");
    await page.getByRole("button", { name: "保存走代理", exact: true }).click();
    await expect
      .poll(async () => (await owner!.read()).configuration.network.via_proxy)
      .toMatchObject({ sources: ["semantic-scholar"], browser: true });
    expect((await owner!.read()).configuration.network.proxy).toBe(
      "http://127.0.0.1:7890",
    );
    expect(
      await page
        .getByRole("textbox", { name: "代理地址", exact: true })
        .inputValue(),
    ).toBe("http://127.0.0.1:7891");
    // Each block saves at its bottom right (page specs “设置”): the routes
    // have nothing left to save, the address edit still does.
    expect(
      await page
        .getByRole("button", { name: "保存走代理", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      await page
        .getByRole("button", { name: "保存代理", exact: true })
        .isDisabled(),
    ).toBe(false);
    expect(
      await page.getByText("有未保存的改动", { exact: true }).count(),
    ).toBe(1);
    await page
      .getByRole("textbox", { name: "代理地址", exact: true })
      .fill("http://127.0.0.1:7890");

    await page.getByRole("button", { name: "测试代理", exact: true }).click();
    await expect
      .poll(() => page.getByRole("status").allTextContents())
      .toContainEqual("已连通 · 42 ms");
    expect(probes).toBe(1);

    // Authentication is sent once and never shown again.
    const password = "synthetic-proxy-password-never-returned";
    await page.getByRole("button", { name: "填写", exact: true }).click();
    await page
      .getByRole("textbox", { name: "代理用户名", exact: true })
      .fill("synthetic-user");
    await page.getByLabel("代理密码").fill(password);
    await page.getByRole("button", { name: "保存认证", exact: true }).click();
    await expect
      .poll(async () => (await owner!.status()).network?.proxy_authentication)
      .toBe(true);
    await page.getByText("已配置", { exact: true }).waitFor();
    expect(await page.locator("body").textContent()).not.toContain(password);
    expect(
      await page.evaluate(() => JSON.stringify(localStorage)),
    ).not.toContain(password);

    // Other sections only show which requesters use the proxy.
    // The source directory is in “获取 PDF” (page specs “设置”).
    await page.getByRole("tab", { name: "获取 PDF", exact: true }).click();
    const row = page
      .getByRole("region", { name: "文献来源", exact: true })
      .getByRole("row")
      .filter({ hasText: "Semantic Scholar" });
    await expect.poll(() => row.textContent()).toContain("经代理");
    const crossref = page
      .getByRole("region", { name: "文献来源", exact: true })
      .getByRole("row")
      .filter({ hasText: "Crossref" });
    expect(await crossref.textContent()).not.toContain("经代理");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
