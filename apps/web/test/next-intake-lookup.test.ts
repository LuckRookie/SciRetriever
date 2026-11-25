import { expect, it } from "vitest";
import {
  FIXTURE_DOI,
  FIXTURE_TITLE,
} from "../../server/src/workbench/synthetic-fixture.js";
import { lookupSources, work } from "./lookup-sources-fixture.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

const UNIQUE = work(
    "A uniquely titled synthetic survey",
    "10.5555/lookup-unique",
  ),
  TWIN_A = work("Twin titled synthetic article", "10.5555/twin-a"),
  TWIN_B = work(
    "Twin titled synthetic article",
    "10.5555/twin-b",
    "openalex",
    "Other",
  );

it("finds named papers line by line: recognized, in the library, to choose, refused; a chosen candidate goes in (page specs “找文献 · 指定文献”)", async () => {
  const sources = lookupSources([UNIQUE, TWIN_A, TWIN_B]);
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
    core: sources.core,
  });
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "指定文献", exact: true }).click();
    const panel = page.getByRole("tabpanel");
    const box = panel.getByRole("textbox", {
      name: "每行一篇：DOI、文献的网址，或完整的标题。",
    });
    const find = panel.getByRole("button", {
      name: "查找这些文献",
      exact: true,
    });
    const count = panel.locator(".intake-lookup-count");
    await expect.poll(() => count.textContent()).toBe("0 行");
    expect(await find.isDisabled()).toBe(true);
    // Over 200 non-empty lines the count turns into the limit, and nothing goes.
    await box.fill(
      Array.from({ length: 201 }, (_, i) => `10.5555/many-${i}`).join("\n"),
    );
    await expect
      .poll(() => count.textContent())
      .toBe("一次最多 200 行，请分批");
    expect(await find.isDisabled()).toBe(true);
    // Four lines, a blank one between them not counted.
    await box.fill(
      [
        `https://doi.org/${UNIQUE.metadata.identifiers[0]!.value}`,
        `doi:${FIXTURE_DOI}`,
        "",
        "Twin titled synthetic article",
        "https://example.org/some/article",
      ].join("\n"),
    );
    await expect.poll(() => count.textContent()).toBe("4 行");
    await find.click();

    const view = page.getByRole("region", { name: "批次", exact: true });
    await view
      .getByRole("heading", { name: "指定文献", exact: true })
      .waitFor();
    const part = (name: string) =>
      view.getByRole("region", { name: new RegExp(`^${name}（\\d+）$`, "u") });
    // Once recognition is done each line sits in its own part, by line number.
    await part("认出的").waitFor();
    expect(await part("认出的").locator("li").allInnerTexts()).toEqual([
      expect.stringMatching(
        /^1\s+https:\/\/doi\.org\/10\.5555\/lookup-unique\s+A uniquely titled synthetic survey · Ada Tester · 2026$/u,
      ),
    ]);
    expect(await part("已在库的").locator("li").innerText()).toMatch(
      new RegExp(
        `^2\\s+doi:${FIXTURE_DOI.replace(/\./gu, "\\.")}\\s+${FIXTURE_TITLE}`,
        "u",
      ),
    );
    const choose = view.getByRole("group", { name: "可能是这一篇" });
    expect(await choose.locator("li").innerText()).toMatch(
      /^4\s+Twin titled synthetic article[\s\S]*待决定$/u,
    );
    expect(await part("没有导入的内容").locator("li").innerText()).toMatch(
      /^5\s+https:\/\/example\.org\/some\/article\s+不支持这个网址/u,
    );
    expect(await view.getByRole("group", { name: "没认出" }).count()).toBe(0);
    expect(
      (await view.getByLabel("各行计数").innerText()).replace(/\s+/gu, " "),
    ).toBe("行数 4 认出 1 已在库 1 可能是这一篇 1 无法处理 1");
    // The library line was matched there: no source was asked about it.
    expect(sources.calls.some((call) => call.includes(FIXTURE_DOI))).toBe(
      false,
    );

    // Adopt the OpenAlex work; the decision stands at the row's end.
    await choose.getByRole("button", { name: "采用", exact: true }).click();
    await page.getByRole("menuitem", { name: /Ada Other/u }).click();
    await choose
      .getByText("采用：Twin titled synthetic article · Ada Other · 2026", {
        exact: true,
      })
      .waitFor();
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view
      .locator(".intake-batch-state .ui-badge")
      .filter({ hasText: /^(完成|部分完成)$/u })
      .waitFor();
    // The report names the line left out, with its number and text.
    const left = view.getByRole("table", { name: "没有入库的行" });
    await left.waitFor();
    expect(await left.locator("tbody tr").count()).toBe(1);
    expect(await left.locator("tbody tr").innerText()).toContain(
      "https://example.org/some/article",
    );
    await view.getByRole("button", { name: /^获取全文 \d+ 篇$/u }).waitFor();

    // The papers named are in the library now: three found, one refused.
    const id = new URL(page.url()).searchParams.get("session")!;
    const report = await w.env.app.importSessions.report(id, null, 200);
    const added = report.items.filter((item) => item.literature_id);
    expect(added.map((item) => item.line?.number).sort()).toEqual([1, 2, 4]);
    const dois = await Promise.all(
      added.map(async (item) =>
        (
          await w.env.app.library.detail(item.literature_id!)
        ).literature.metadata.identifiers
          .map((i) => i.value)
          .join(","),
      ),
    );
    expect(dois.sort()).toEqual(
      [FIXTURE_DOI, "10.5555/lookup-unique", "10.5555/twin-b"].sort(),
    );
    await view.getByRole("button", { name: "更多", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "在文献库查看", exact: true })
      .click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(3);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
