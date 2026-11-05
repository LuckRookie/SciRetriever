import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

const TEXT = [
  "Author One and Author Two",
  "Received 1 May 2024",
  "Department of Chemistry, Example University",
  "The cited result holds for both panels.",
  "Panel A of the figure.",
  "Panel B of the figure.",
  "Fig. 1 Two panels of one figure.",
  "A footnote that the paragraph cites.",
  "## Results",
  "Measured values follow.",
].join("\n\n");

/** UTF-8 range of a block in the published document, as the structure reports it. */
function ranger(text: string) {
  const encoder = new TextEncoder();
  return (block: string) => {
    const at = text.indexOf(block);
    if (at < 0) throw new Error(`block not in document: ${block}`);
    const start = encoder.encode(text.slice(0, at)).length;
    return {
      start_utf8: start,
      end_utf8: start + encoder.encode(block).length,
    };
  };
}

it("folds article information, lays out figure groups and footnotes, and names untitled sections by role", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      env.setText(TEXT + "\n");
    },
  });
  try {
    const read = w.env.app.documentRead;
    const current = await read.default({
      literature_id: w.env.parseRequest.literature_id,
      asset_id: w.env.parseRequest.asset_id,
      asset_sha256: w.env.parseRequest.asset_sha256,
    });
    const document_version_id = current.default!.document_version_id;
    const segments = await read.segments({
      document_version_id,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    const total = Math.max(...segments.segments.map((s) => s.end_utf8));
    const slice = await read.slice({
      document_version_id,
      selector: { kind: "range", start_utf8: 0, end_utf8: total },
      max_bytes: 65536,
      continuation: null,
    });
    const range = ranger(slice.text);
    // The layout shape is the server's (contract in ADR 0054's plan block); this checks the page.
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-describe",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.result.layout = {
          schema_version: 1,
          article_info: [
            range("Received 1 May 2024"),
            range("Department of Chemistry, Example University"),
          ],
          figure_groups: [
            {
              group_id: "g1",
              kind: "figure",
              objects: [
                {
                  segment_id: "a",
                  row: 0,
                  column: 0,
                  ...range("Panel A of the figure."),
                },
                {
                  segment_id: "b",
                  row: 0,
                  column: 1,
                  ...range("Panel B of the figure."),
                },
              ],
              captions: [
                {
                  segment_id: "c",
                  ...range("Fig. 1 Two panels of one figure."),
                },
              ],
              rows: [2],
            },
          ],
          footnotes: [
            {
              segment_id: "n",
              page_index: 0,
              ...range("A footnote that the paragraph cites."),
            },
          ],
        };
        await route.fulfill({ response, json: body });
      },
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-outline",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const [first, ...rest] = body.result.sections;
        body.result.sections = [
          {
            ...first,
            title: null,
            title_truncated: false,
            role: "introduction",
            role_source: "arrangement",
          },
          ...rest.map((section: object) =>
            "role" in section
              ? section
              : { ...section, role: null, role_source: null },
          ),
        ];
        await route.fulfill({ response, json: body });
      },
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const article = w.page.locator(".reading-article");
    await article.getByText("Measured values follow.").waitFor();
    // Article information starts folded behind one toggle and opens on demand.
    const toggle = article.getByRole("button", {
      name: "文章信息",
      exact: true,
    });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await article.getByText("Received 1 May 2024").isVisible()).toBe(
      false,
    );
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await article.getByText("Received 1 May 2024").isVisible()).toBe(
      true,
    );
    // Two panels share one row; the caption and the footnote take their own styles.
    const cells = article.locator(".reading-figure-cell");
    expect(await cells.count()).toBe(2);
    const [left, right] = [
      await cells.nth(0).boundingBox(),
      await cells.nth(1).boundingBox(),
    ];
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1);
    expect(
      await article.locator(".reading-figure-caption").innerText(),
    ).toContain("Fig. 1");
    expect(await article.locator(".reading-footnote").innerText()).toContain(
      "A footnote",
    );
    // The Markdown carries no layout markers: the body text is the paper's own.
    expect(await article.innerText()).not.toMatch(/mktero|<!--|:::/);
    // An untitled section is listed by its role, marked as such.
    await w.page.getByRole("button", { name: "显示目录", exact: true }).click();
    const entry = w.page.locator(".reader-outline-entry[data-untitled]");
    await entry.waitFor();
    expect(await entry.innerText()).toBe("引言");
    expect(
      await w.page
        .locator(".reader-outline-entry", { hasText: "Results" })
        .count(),
    ).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);

it("marks a long document above the text, in the information panel and in the library row", async () => {
  const w = await nextWorkspace({ ready: "body" });
  const long = {
    pages: 294,
    arrange_input_bytes: 796130,
    reasons: ["pages", "arrange-input"],
  };
  // The flag is the server's (ADR 0055 contract); this checks the page.
  const withLong = async (
    route: import("playwright").Route,
    mutate: (body: Record<string, any>) => void,
  ) => {
    const response = await route.fetch();
    const body = await response.json();
    mutate(body);
    await route.fulfill({ response, json: body });
  };
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-describe",
      (route) =>
        withLong(route, (body) => {
          body.result.long_document = long;
        }),
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/read",
      (route) =>
        withLong(route, (body) => {
          const r = body.result ?? body;
          (r.detail ?? r).long_document = long;
        }),
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/search",
      (route) =>
        withLong(route, (body) => {
          const r = body.result ?? body;
          for (const item of (r.page ?? r).items ?? [])
            item.long_document = long;
        }),
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const note = w.page.locator(".reading-long-document");
    await note.waitFor();
    expect(await note.innerText()).toBe(
      "长文档（294 页）：按简化流程建档，未逐页校订，文字可能含解析错误；以 PDF 为准。",
    );
    expect(await w.page.getByText("长文档（294 页）· 未逐页校订").count()).toBe(
      1,
    );
    await w.page.goto(`${w.origin}/?view=lib`);
    await w.page
      .locator(".paper-status small", { hasText: "长文档" })
      .first()
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);
