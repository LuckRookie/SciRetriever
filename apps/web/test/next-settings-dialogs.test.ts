import { expect, it } from "vitest";
import type { Page } from "playwright";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { executeConfiguration } from "../../server/src/entry/configuration-operations.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

/** Design core rule 6: today 14:28, this year 11月19日 14:28, else 2025年11月19日. */
const RULE_SIX =
  /^(?:\d{2}:\d{2}|\d{1,2}月\d{1,2}日 \d{2}:\d{2}|\d{4}年\d{1,2}月\d{1,2}日)$/u;
/** The pen's colour as the browser resolves it, for comparing text buttons. */
const penColour = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--blue)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

it("orders settings by task, lands old addresses, keeps keys beside their services and saves each block at its bottom right", async () => {
  let owner: TypeScriptConfigurationOwner;
  let baseline = "";
  const w = await nextWorkspace({
    path: "/?view=set",
    ready: ".settings-content",
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      const initial = await owner.read();
      await owner.publishConfiguration(
        {
          ...initial.configuration,
          providers: {},
          models: {},
          analyze: { ...initial.configuration.analyze, model: null },
          browser: { ...initial.configuration.browser, model: null },
        },
        initial.revision,
        ["providers", "models", "analyze", "browser"],
      );
      baseline = (await owner.read()).revision;
    },
    configuration: () => ({
      runtime_revision: baseline,
      read: (signal) => owner.read(signal),
      status: (signal) => owner.status(signal),
      publishConfiguration: (configuration, revision, sections, signal) =>
        owner.publishConfiguration(configuration, revision, sections, signal),
      credential: (edit, revision, signal) =>
        owner.credential(edit, revision, signal),
      sourceOperation: (operation, value, signal) =>
        executeConfiguration(owner, operation, value, signal),
    }),
  });
  try {
    const page = w.page;
    const navigation = page.getByRole("tablist", { name: "设置分区" });
    // Page specs “设置”: the sections in the order of the things people do.
    expect(await navigation.getByRole("tab").allTextContents()).toEqual([
      "外观",
      "模型服务",
      "获取 PDF",
      "生成全文",
      "设备连接",
      "网络",
      "文献库文件",
      "运行状态",
      "高级",
    ]);
    expect(
      await navigation
        .getByRole("tab", { name: "外观", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // Refreshing the configuration is no longer a page action.
    expect(
      await page.getByRole("button", { name: "刷新配置", exact: true }).count(),
    ).toBe(0);
    // Signing out belongs to no section: it is the page's last line.
    const logout = page.locator(".settings-content > .settings-logout");
    expect(await logout.getByRole("button").textContent()).toBe("退出登录");
    expect(
      await page.evaluate(() => {
        const content = document.querySelector(".settings-content")!;
        return content.lastElementChild?.classList.contains("settings-logout");
      }),
    ).toBe(true);
    // An inline text action is written in the pen's colour (rule 10).
    expect(
      await logout
        .getByRole("button")
        .evaluate((button) => getComputedStyle(button).color),
    ).toBe(await penColour(page));

    // Addresses of the earlier sections land on their new homes.
    for (const [old, label] of [
      ["sources", "获取 PDF"],
      ["parser", "生成全文"],
      ["archive", "生成全文"],
      ["cred", "模型服务"],
      ["paths", "文献库文件"],
    ] as const) {
      await page.goto(`${w.origin}/?view=set&setting=${old}`);
      await expect
        .poll(() =>
          navigation
            .getByRole("tab", { selected: true })
            .textContent()
            .catch(() => ""),
        )
        .toBe(label);
    }
    expect(await page.getByRole("tab", { name: "凭据" }).count()).toBe(0);

    // A model service in one place: address, key and models together.
    await navigation
      .getByRole("tab", { name: "模型服务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "添加模型服务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "模型服务 1 名称", exact: true })
      .fill("synthetic-service");
    await page
      .getByRole("textbox", { name: "模型服务 1 服务地址", exact: true })
      .fill("https://provider.example.test/v1");
    const service = page.getByRole("group", { name: "模型服务 1" });
    // A key cannot be stored for a service that is not saved yet.
    expect(
      await service
        .getByRole("button", { name: "填写", exact: true })
        .isDisabled(),
    ).toBe(true);
    await service
      .getByRole("button", { name: "添加模型", exact: true })
      .click();
    await service
      .getByRole("textbox", { name: "模型 1 远程名称", exact: true })
      .fill("remote-model");
    const services = page.locator(".ui-section").filter({
      has: page.getByRole("heading", { name: "模型服务", exact: true }),
    });
    const footer = services.locator(".ui-block-footer");
    expect(await footer.textContent()).toContain("有未保存的改动");
    const save = footer.getByRole("button", {
      name: "保存模型服务",
      exact: true,
    });
    expect(await save.getAttribute("data-variant")).toBe("primary");
    // The save sits at the bottom right of the section's block.
    const [block, button] = await Promise.all([
      services.locator(".ui-block").boundingBox(),
      save.boundingBox(),
    ]);
    expect(block!.x + block!.width - (button!.x + button!.width)).toBeLessThan(
      40,
    );
    expect(
      block!.y + block!.height - (button!.y + button!.height),
    ).toBeLessThan(40);
    await save.click();
    await expect
      .poll(async () => (await owner!.read()).configuration.models)
      .toHaveProperty(["synthetic-service/remote-model"]);
    await expect
      .poll(() => footer.textContent())
      .not.toContain("有未保存的改动");
    expect(
      await footer
        .getByRole("button", { name: "保存模型服务", exact: true })
        .isDisabled(),
    ).toBe(true);
    // The key: only “已保存” or “未填”, never the value.
    expect(await service.locator(".settings-secret-state").textContent()).toBe(
      "未填",
    );
    const secret = "synthetic-service-key-never-shown";
    await service.getByRole("button", { name: "填写", exact: true }).click();
    await service
      .getByLabel("synthetic-service 的密钥", { exact: true })
      .fill(secret);
    const stored = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/configuration/credential",
    );
    await service.getByRole("button", { name: "保存", exact: true }).click();
    expect((await stored).status()).toBe(200);
    await expect
      .poll(() => service.locator(".settings-secret-state").textContent())
      .toBe("已保存");
    expect(await page.locator("body").textContent()).not.toContain(secret);
    expect(JSON.stringify(await owner!.status())).toContain(
      "synthetic-service",
    );

    // A parameter block: one sentence per parameter, the note beside the save.
    await navigation
      .getByRole("tab", { name: "生成全文", exact: true })
      .click();
    const parameters = page.locator(".ui-section").filter({
      has: page.getByRole("heading", { name: "参数", exact: true }),
    });
    for (const term of ["每篇标签上限", "候选检索数量", "回溯批量"])
      expect(
        await parameters
          .locator(".ui-definition", { hasText: term })
          .locator("dt p")
          .textContent(),
      ).toMatch(/调大/u);
    expect(
      await parameters.locator(".ui-block-footer").textContent(),
    ).not.toContain("有未保存的改动");
    await page
      .getByRole("textbox", { name: "每篇标签上限", exact: true })
      .fill("11");
    await expect
      .poll(() => parameters.locator(".ui-block-footer").textContent())
      .toContain("有未保存的改动");
    // Rule 11: the name column is at most 240 px, the control right after it.
    const row = parameters.locator(".ui-definition").first();
    const [term, control] = await Promise.all([
      row.locator("dt").boundingBox(),
      row.locator("dd").boundingBox(),
    ]);
    expect(term!.width).toBeLessThanOrEqual(240);
    expect(control!.x - (term!.x + term!.width)).toBeLessThanOrEqual(32);
    await parameters
      .getByRole("button", { name: "保存生成全文的设置", exact: true })
      .click();
    await expect
      .poll(
        async () => (await owner!.read()).configuration.tags.max_per_literature,
      )
      .toBe(11);
    await expect
      .poll(() => parameters.locator(".ui-block-footer").textContent())
      .not.toContain("有未保存的改动");

    // 高级: the tools themselves, no embedded snapshot page, our own file button.
    await navigation.getByRole("tab", { name: "高级", exact: true }).click();
    await page.locator(".maintenance-page").waitFor();
    expect(await page.locator(".snapshot-list, .snapshot-detail").count()).toBe(
      0,
    );
    expect(await page.locator(".maintenance-page .ui-card").count()).toBe(0);
    expect(
      await page
        .getByRole("textbox", { name: "文献编号", exact: true })
        .count(),
    ).toBe(0);
    await page.getByRole("searchbox", { name: "文献", exact: true }).waitFor();
    const file = page.locator(".maintenance-page .ui-file-picker").first();
    expect(await file.locator("button.ui-button").textContent()).toBe(
      "选择 PDF",
    );
    expect(await file.textContent()).toContain("未选择文件");
    expect(
      await page
        .locator('.maintenance-page input[type="file"]')
        .evaluateAll((inputs) =>
          inputs.every((input) => input.getBoundingClientRect().width <= 1),
        ),
    ).toBe(true);
    expect(await page.locator(".maintenance-page").textContent()).not.toMatch(
      /Choose File|No file chosen/u,
    );

    // 设备连接: every header cell lines up, sortable or not; times by rule 6.
    await navigation
      .getByRole("tab", { name: "设备连接", exact: true })
      .click();
    await page
      .getByRole("button", { name: "连接浏览器扩展", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "连接浏览器扩展" });
    await dialog
      .getByRole("button", { name: "生成连接码", exact: true })
      .click();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    const table = page.locator(".ui-data-table").first();
    await table.locator("tbody time").first().waitFor();
    const centres = await table.locator("thead th").evaluateAll((cells) =>
      cells.map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const box = range.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      }),
    );
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(2);
    const created = table.locator("tbody time").first();
    expect(await created.textContent()).toMatch(RULE_SIX);
    expect(await created.getAttribute("title")).toMatch(/\d{4}\/\d{2}\/\d{2}/u);
    // A sort button in a header keeps the header's colour, not the pen's.
    expect(
      await table
        .locator("thead .ui-button")
        .first()
        .evaluate((button) => getComputedStyle(button).color),
    ).not.toBe(await penColour(page));
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("gives each dialog one primary button that names the action and its count, with rare parameters folded", async () => {
  let owner: TypeScriptConfigurationOwner;
  const w = await nextWorkspace({
    path: "/?view=lib&sort=title-asc",
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
    },
    configuration: () => ({
      runtime_revision: "",
      read: (signal) => owner.read(signal),
      status: (signal) => owner.status(signal),
      publishConfiguration: (configuration, revision, sections, signal) =>
        owner.publishConfiguration(configuration, revision, sections, signal),
      credential: (edit, revision, signal) =>
        owner.credential(edit, revision, signal),
      sourceOperation: (operation, value, signal) =>
        executeConfiguration(owner, operation, value, signal),
    }),
  });
  try {
    const page = w.page;
    const rows = page.locator(".paper-row");
    for (const n of [0, 1]) {
      await rows.nth(n).focus();
      await page.keyboard.press("Space");
    }
    await page
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: /^获取 PDF/u })
      .click();
    const acquire = page.getByRole("dialog", { name: "获取 PDF", exact: true });
    await acquire.locator(".acquire-scope").waitFor();
    const primary = acquire.locator('.ui-button[data-variant="primary"]');
    await expect.poll(() => primary.count()).toBe(1);
    expect(await primary.textContent()).toMatch(/^获取 \d+ 篇$/u);
    expect(await acquire.textContent()).not.toMatch(/确认执行|确认启动/u);
    // Attempts, retries and what to do when blocked are folded away.
    const advanced = acquire.getByRole("button", {
      name: "高级选项",
      exact: true,
    });
    expect(await advanced.getAttribute("aria-expanded")).toBe("false");
    expect(
      await acquire.getByLabel("尝试上限", { exact: true }).isVisible(),
    ).toBe(false);
    await advanced.click();
    await acquire.getByLabel("尝试上限", { exact: true }).waitFor();
    await acquire.getByRole("button", { name: "取消", exact: true }).click();

    // Discovery names the sources it will ask, and starts with “开始发现”.
    await page.goto(`${w.origin}/?view=disc`);
    await page
      .getByRole("textbox", { name: "主题或检索式" })
      .fill("synthetic spectroscopy");
    // Years and scan limits do not step: no plus and minus (rule 11).
    expect(
      await page
        .locator(".intake-form .ui-number")
        .filter({ has: page.getByRole("button", { name: "增加" }) })
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "开始发现", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "确认发现文献" });
    const start = confirm.locator('.ui-button[data-variant="primary"]');
    expect(await start.count()).toBe(1);
    expect(await start.textContent()).toBe("开始发现");
    await expect
      .poll(() => confirm.textContent())
      .toMatch(/使用服务：(?!已配置的文献来源)\S/u);
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("shows one page for an invalid address with the way back to the library", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const invalid = "/?literature=not-a-literature&reader=text";
    await page.goto(`${w.origin}${invalid}`);
    const notFound = page.locator(".page-not-found");
    await notFound.waitFor();
    expect(await notFound.getByRole("heading").textContent()).toBe(
      "找不到这个页面",
    );
    expect(await notFound.textContent()).toContain(
      "地址可能写错了，或者这项内容已经不在了。",
    );
    // The invalid parameters are never written back to the reader.
    expect(await page.locator("main").textContent()).not.toContain(
      "not-a-literature",
    );
    // The site's sidebar stays.
    await page.getByLabel("主导航").waitFor();
    const back = notFound.getByRole("button", {
      name: "回到文献库",
      exact: true,
    });
    expect(await back.evaluate((b) => getComputedStyle(b).color)).toBe(
      await penColour(page),
    );
    await back.click();
    await page.locator('[aria-label="文献列表"] .paper-row').first().waitFor();
    const url = new URL(page.url());
    expect(url.searchParams.get("view")).toBe("lib");
    expect(url.searchParams.has("literature")).toBe(false);
    expect(url.searchParams.has("reader")).toBe(false);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
