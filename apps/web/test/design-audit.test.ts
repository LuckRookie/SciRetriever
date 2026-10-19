import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import {
  collectDesignAudit,
  designAuditFindings,
  writeDesignAudit,
  type DesignAudit,
} from "./design-audit-fixture.js";

it("records reproducible computed-style evidence on the synthetic React workspace", async () => {
  const output = process.env.SCIRETRIEVER_DESIGN_AUDIT_OUTPUT;
  const rows: {
    entry: string;
    page: string;
    theme: string;
    width: number;
    findings: ReturnType<typeof designAuditFindings>;
    audit: DesignAudit;
    placeholder: boolean;
  }[] = [];
  const entry = "react";
  {
    let owner: TypeScriptConfigurationOwner;
    let baseline = "";
    const setup: NonNullable<
      NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"]
    > = async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      baseline = (await owner.read()).revision;
    };
    const configuration = () => ({
      runtime_revision: baseline,
      read: (signal?: AbortSignal) => owner.read(signal),
      status: (signal?: AbortSignal) => owner.status(signal),
      publishConfiguration: owner.publishConfiguration.bind(owner),
      credential: owner.credential.bind(owner),
    });
    const w = await nextWorkspace({ ready: "body", setup, configuration });
    try {
      const counts = {
        parse: w.env.parseCalls,
        model: w.env.modelCalls,
        jobs: (await w.env.app.jobs!.listJobs(20)).length,
      };
      const pages = output
        ? ["lib", "disc", "ins", "ask", "syn", "ext", "task", "web", "set"]
        : ["lib"];
      for (const name of pages) {
        await w.page.goto(`${w.origin}/?view=${name}`);
        await w.page.locator(".navigation").waitFor({ state: "attached" });
        await expect
          .poll(() => w.page.locator(".ui-skeleton:visible").count())
          .toBe(0);
        if (name === "lib")
          await w.page.locator(".paper-row").first().waitFor();
        if (name === "set")
          await w.page
            .getByRole("textbox", { name: "Catalog 路径", exact: true })
            .waitFor();
        const placeholder = (await w.page.locator("body").innerText()).includes(
          "正在迁移",
        );
        for (const width of output ? [1440, 1280, 1024, 390] : [1440])
          for (const theme of output
            ? ["light", "dark", "green", "warm"]
            : ["light"]) {
            await w.page.setViewportSize({ width, height: 900 });
            await w.page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            await w.page.keyboard.press("Tab");
            const button = w.page.getByRole("button").first();
            if (await button.isVisible()) await button.focus();
            await w.page.evaluate(() => document.fonts.ready);
            const filename = `${name}-${width}-${theme}`;
            if (output) {
              await mkdir(join(output, entry), { recursive: true });
              await w.page.screenshot({
                path: join(output, entry, `${filename}.png`),
                animations: "disabled",
              });
            }
            const audit = output
              ? await writeDesignAudit(w.page, join(output, entry), filename)
              : await collectDesignAudit(w.page);
            expect(audit.sampled).toBeGreaterThan(0);
            expect(
              audit.controls.every(
                (control) => control.width > 0 && control.height > 0,
              ),
            ).toBe(true);
            rows.push({
              entry,
              page: name,
              theme,
              width,
              audit,
              findings: designAuditFindings(audit),
              placeholder,
            });
          }
      }
      expect(w.env.parseCalls).toBe(counts.parse);
      expect(w.env.modelCalls).toBe(counts.model);
      expect((await w.env.app.jobs!.listJobs(20)).length).toBe(counts.jobs);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  }
  if (output) {
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(
        rows.map(({ audit, ...row }) => ({
          ...row,
          controls: audit.sampled,
          fontFaces: audit.fontFaces,
          fonts: audit.fonts,
          platform: audit.platform,
        })),
        null,
        2,
      ) + "\n",
    );
    const markdown = [
      "# 合成库默认页面计算样式审计",
      "",
      "本报告记录 Linux / Chromium 实测，不代替 macOS 字体截图或人类视觉确认。悬停、提交中、错误和浮层状态另由对应组件/功能旅程覆盖；此矩阵只截图每页默认状态。缺少边框/焦点值与未可解析颜色会保留为 null，不推断通过。",
      "",
      "| 入口 | 页面 | 宽度 | 主题 | 可见控件 | 圆角种类 | 按钮高度种类 | 低文字对比候选 | 焦点低对比候选 | 溢出 | 占位页 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (row) =>
          `| ${row.entry} | ${row.page} | ${row.width} | ${row.theme} | ${row.audit.sampled} | ${row.findings.radii.join(", ")} | ${row.findings.heights.join(", ")} | ${row.findings.lowTextContrast.length} | ${row.findings.lowFocusContrast.length} | ${row.findings.horizontalOverflow} | ${row.placeholder} |`,
      ),
    ];
    await writeFile(join(output, "README.md"), markdown.join("\n") + "\n");
  }
}, 240000);
