import { expect, it } from "vitest";
import { componentFixture } from "./component-fixture.js";
it("keeps processing explicit, restores dialog focus, and supports keyboard fields under production CSP", async () => {
  const env = await componentFixture(),
    page = env.page;
  try {
    await page
      .getByRole("heading", { name: "组件画廊", exact: true })
      .waitFor();
    for (const reduced of [false, true]) {
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      await page.getByRole("button", { name: "示例加工", exact: true }).click();
      await page.getByRole("dialog", { name: "确认示例加工" }).waitFor();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      expect(await page.getByLabel("加工执行次数").textContent()).toBe(
        reduced ? "已执行 1 次" : "已执行 0 次",
      );
      await page.getByRole("button", { name: "示例加工", exact: true }).click();
      await page.getByRole("button", { name: "执行示例", exact: true }).click();
      await expect
        .poll(() => page.getByLabel("加工执行次数").textContent())
        .toBe(reduced ? "已执行 2 次" : "已执行 1 次");
    }
    const open = page.getByRole("button", { name: "打开对话框", exact: true });
    await open.click();
    await page.getByRole("textbox", { name: "对话框输入" }).fill("draft");
    await page.keyboard.press("Escape");
    expect(
      await open.evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.getByRole("searchbox", { name: "搜索示例" }).fill("keyword");
    await page.keyboard.press("Escape");
    expect(
      await page.getByRole("searchbox", { name: "搜索示例" }).inputValue(),
    ).toBe("");
    expect(
      await page
        .locator(".ui-tabs")
        .evaluateAll((elements) =>
          elements.every(
            (element) => getComputedStyle(element).outlineStyle === "none",
          ),
        ),
    ).toBe(true);
    const select = page.getByRole("button", { name: /材料范围/ });
    await select.click();
    await page.getByRole("option", { name: "已有 PDF", exact: true }).click();
    expect(await select.textContent()).toContain("已有 PDF");
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    const tabs = page.getByRole("tablist", { name: "阅读视图示例" });
    await tabs.getByRole("tab", { name: "PDF", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    expect(
      await tabs
        .getByRole("tab", { name: "全文", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const disabled = page.getByRole("button", { name: "解析", exact: true });
    expect(await disabled.isDisabled()).toBe(true);
    expect(await disabled.getAttribute("aria-describedby")).toBeTruthy();
    const separator = page.getByRole("separator", { name: "示例侧栏宽度" });
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    expect(await separator.getAttribute("aria-valuenow")).toBe("276");
    await separator.dblclick();
    expect(await separator.getAttribute("aria-valuenow")).toBe("260");
    for (let n = 0; n < 10; n++) {
      await page
        .getByRole("button", { name: "打开活动抽屉", exact: true })
        .click();
      await page.getByRole("dialog", { name: "活动示例" }).waitFor();
      await page.keyboard.press("Escape");
    }
    expect(await page.locator("style").count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 30000);
it("keeps all twelve three-way motion comparisons operable and exports selected parameters", async () => {
  const env = await componentFixture("lab"),
    page = env.page;
  try {
    await page
      .getByRole("heading", { name: "交互手感实验台", exact: true })
      .waitFor();
    expect(await page.locator(".lab-comparisons").count()).toBe(12);
    expect(await page.locator(".lab-variant").count()).toBe(36);
    for (const variant of ["A", "B", "C"]) {
      const dialog = page.getByRole("button", {
        name: `打开 ${variant} 对话框`,
        exact: true,
      });
      await dialog.click();
      await page
        .getByRole("dialog", { name: `${variant} 对话框示例` })
        .waitFor();
      await page.keyboard.press("Escape");
    }
    for (const name of ["筛选面板展开", "信息栏收起"]) {
      const section = page.getByRole("region", { name, exact: true });
      const buttons = section.getByRole("button", {
        name: name === "筛选面板展开" ? "筛选条件" : "收起信息栏",
        exact: true,
      });
      for (let i = 0; i < 3; i++) await buttons.nth(0).click();
    }
    const locator = page.getByRole("region", {
      name: "列表项增删",
      exact: true,
    });
    await locator
      .getByRole("button", { name: "增加", exact: true })
      .nth(2)
      .click();
    expect(await locator.locator(".lab-variant-c .lab-demo-item").count()).toBe(
      2,
    );
    const reducedSwitch = page.getByRole("switch", { name: "减少动效" });
    expect(await reducedSwitch.isChecked()).toBe(
      process.env.SCIRETRIEVER_REDUCED_MOTION === "reduce",
    );
    // Both initial OS preferences must permit an explicit full/reduced override.
    // A toggle from an already reduced context deliberately turns reduction off.
    for (const desired of [false, true]) {
      if ((await reducedSwitch.isChecked()) !== desired) {
        await reducedSwitch.focus();
        await page.keyboard.press("Space");
      }
      expect(await reducedSwitch.isChecked()).toBe(desired);
      await expect
        .poll(() => page.locator("html").getAttribute("data-reduced-motion"))
        .toBe(String(desired));
    }
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出参数 JSON" }).click();
    expect((await download).suggestedFilename()).toBe(
      "sciretriever-motion-parameters.json",
    );
    expect(await page.locator("style").count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 30000);

it("keeps pending actions named, focused and fixed-width, and preserves disclosure drafts without moving text actions", async () => {
  const env = await componentFixture(),
    page = env.page;
  try {
    await page
      .getByRole("heading", { name: "组件画廊", exact: true })
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
    const textAction = page.getByRole("button", {
      name: "文字操作",
      exact: true,
    });
    await textAction.hover();
    await page.mouse.down();
    expect(
      await textAction.evaluate(
        (element) => getComputedStyle(element).transform,
      ),
    ).toBe("none");
    await page.mouse.up();
    const submit = page.getByRole("button", {
      name: "提交反馈示例",
      exact: true,
    });
    const width = Math.round((await submit.boundingBox())!.width);
    await submit.focus();
    await submit.press("Enter");
    await expect.poll(() => submit.getAttribute("data-pending")).toBe("true");
    const feedbackVisibility = async (selector: string) =>
      submit.locator(selector).evaluate((element) => {
        let opacity = 1;
        let visible = true;
        for (
          let ancestor: Element | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          opacity *= Number(style.opacity);
          visible &&=
            style.display !== "none" && style.visibility === "visible";
        }
        const bounds = element.getBoundingClientRect();
        return (
          visible && opacity > 0.99 && bounds.width > 0 && bounds.height > 0
        );
      });
    // A data-pending attribute alone does not prove feedback is visible: an
    // ancestor opacity rule can hide both the spinner and the delayed label.
    await expect
      .poll(() => feedbackVisibility(".ui-button-pending .ui-spinner"))
      .toBe(true);
    expect(
      await submit.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await submit.press("Enter");
    expect(await page.getByLabel("反馈示例提交次数").textContent()).toBe("1");
    await expect
      .poll(() => submit.locator(".ui-button-pending-label").textContent(), {
        timeout: 3000,
      })
      .toBe("正在提交…");
    expect(await feedbackVisibility(".ui-button-pending-label")).toBe(true);
    expect(Math.round((await submit.boundingBox())!.width)).toBe(width);
    expect(
      await submit.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page
      .getByRole("button", { name: "完成反馈示例", exact: true })
      .click();
    await expect.poll(() => submit.getAttribute("data-pending")).toBeNull();
    expect(Math.round((await submit.boundingBox())!.width)).toBe(width);
    expect(
      await submit
        .locator(".ui-button-label")
        .evaluate((element) => getComputedStyle(element).opacity),
    ).toBe("1");
    const toggle = page.getByRole("button", {
      name: "查看覆盖范围",
      exact: true,
    });
    const draft = page.getByRole("textbox", {
      name: "折叠区草稿",
      exact: true,
    });
    await toggle.click();
    await draft.fill("Keep this unsaved draft");
    for (let index = 0; index < 5; index++) {
      await toggle.click();
      expect(await draft.isVisible()).toBe(false);
      await toggle.click();
      expect(await draft.inputValue()).toBe("Keep this unsaved draft");
    }
    await page.getByRole("button", { name: "查看长内容", exact: true }).click();
    const longContent = page
      .locator(".ui-disclosure")
      .filter({
        has: page.getByRole("button", { name: "查看长内容", exact: true }),
      })
      .locator(".ui-disclosure-panel > div");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await longContent.evaluate(
        (element) => getComputedStyle(element).transform,
      ),
    ).toBe("none");
    expect(await longContent.textContent()).toContain("合成长段落 30");
    expect(await page.locator("style").count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally {
    await page.mouse.up();
    await env.close();
  }
}, 30000);
