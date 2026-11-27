import { expect, it } from "vitest";
import { markdownBlocks, markdown } from "../src/reading/markdown.js";

it("maps normalized Markdown blocks back to original UTF-8 boundaries including CRLF and non-BMP text", () => {
  const text = "# 标题🙂\r\n\r\nαβ content.\r\n";
  const blocks = markdownBlocks(text),
    bytes = Buffer.from(text);
  expect(bytes.subarray(blocks[0]!.start, blocks[0]!.end).toString()).toBe(
    "# 标题🙂",
  );
  const paragraph = blocks.find((b) => b.token.type === "paragraph")!;
  expect(paragraph.start).toBe(bytes.indexOf(Buffer.from("αβ")));
  expect(
    bytes.subarray(paragraph.start, paragraph.end).toString().trimEnd(),
  ).toBe("αβ content.");
  const unsafe = markdown.parse(
    '<img src="https://example.invalid/tracker" onerror="alert(1)"> [x](javascript:alert(1)) ![x](https://example.invalid/image)',
    { async: false },
  );
  expect(unsafe).not.toMatch(/<img|href="javascript:/);
  expect(unsafe).toContain("&lt;img");
  const pending = markdown.parse("![](images/content-hash.png)", {
    async: false,
  });
  expect(pending).toContain('data-resource="images/content-hash.png"');
  expect(pending).toContain(">图片待加载</span>");
  expect(pending).not.toContain("图片：images/");
});

it("keeps glued inline formulas inline and draws plain Unicode in a formula", () => {
  // A real paper's text: one formula's closing `$` runs into the next's
  // opening `$`. It once opened a display formula that swallowed 15 KB of
  // text, figures and tables up to the next `$$`.
  const text =
    "MP: $177–178^{\\circ}C.$${}^{1}\\mathbf{H}$ NMR $(300\\,\\mathrm{MHz}$, DMSO).\n\n" +
    "![](images/figure.jpg)\n\nFig. 2. Absorption spectra $(3\\times$$10^{-5}\\,\\mathrm{M})$.\n\n" +
    "Then a formula on its own lines:\n$$\nE = h \\nu\n$$\n\nAnd the end.";
  const blocks = markdownBlocks(text).filter((b) => b.token.type !== "space");
  expect(blocks.map((b) => b.token.type)).toEqual([
    "paragraph",
    "paragraph",
    "paragraph",
    "paragraph",
    "displayMath",
    "paragraph",
  ]);
  const html = markdown.parse(text, { async: false });
  expect(html).not.toContain("katex-error");
  expect(html).toContain('data-resource="images/figure.jpg"');
  expect(html.match(/class="katex-display"/g)).toHaveLength(1);
});

// Real Chromium work reached 1.8 s under Full (36/12) load, too close to the 5 s default.
it("renders corrected HTML tables with spans and math while refusing active markup and remote resources", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const script = await build({
    entryPoints: ["apps/web/src/reading/markdown.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "ReadingMarkdown",
    platform: "browser",
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: script.outputFiles[0]!.text });
    await page.evaluate(() => {
      const renderer = (
        window as unknown as {
          ReadingMarkdown: {
            markdown: {
              parse(text: string, options: { async: false }): string;
            };
          };
        }
      ).ReadingMarkdown.markdown;
      document.querySelector("main")!.innerHTML = renderer.parse(
        '<table onclick="window.attacked=true" style="background:url(https://example.invalid/style)"><caption>Original data</caption><thead><tr><th colspan="2">$E=mc^2$</th></tr></thead><tbody><tr><td rowspan="2">α</td><td>4.2 eV <sub>2</sub><img src="https://example.invalid/tracker"><img src="images/saved.png" onerror="window.attacked=true"></td></tr><tr><td>NR<script>window.attacked=true</script><iframe src="https://example.invalid/frame"></iframe></td></tr></tbody></table>',
        { async: false },
      );
    });
    expect(await page.locator("table").count()).toBe(1);
    expect(await page.locator("th").getAttribute("colspan")).toBe("2");
    expect(await page.locator("td").first().getAttribute("rowspan")).toBe("2");
    expect(await page.locator("table").innerText()).toContain("4.2 eV");
    expect(await page.locator(".katex").count()).toBe(1);
    expect(
      await page
        .locator(
          "table img, table script, table iframe, table [onclick], table [style*='example.invalid']",
        )
        .count(),
    ).toBe(0);
    expect(
      await page.locator(".reading-resource").getAttribute("data-resource"),
    ).toBe("images/saved.png");
    await page.locator("table").click();
    expect(await page.evaluate(() => Object.hasOwn(window, "attacked"))).toBe(
      false,
    );
    expect(await page.locator("table").getAttribute("style")).toBeNull();
    expect(requests).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
