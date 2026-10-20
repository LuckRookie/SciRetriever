import { describe, expect, it } from "vitest";
import { parseRawBlocksV1, RAW_PARSE_PROFILES } from "@sciretriever/contracts";
import { convertMinerURawArchive } from "../src/parsing/backends/mineru/archive.js";
import { convertMinerUContentList } from "../src/parsing/backends/mineru/content-list.js";
import {
  mineruRequestFields,
  MINERU_REQUEST_FIELDS,
} from "../src/parsing/backends/mineru/profile.js";
import { rawParseArchive } from "./raw-parse-fixture.js";

const options = {
  source_asset_id: "00000000-0000-0000-0000-000000000997",
  source_sha256: "a".repeat(64),
  model_identity: "synthetic",
};
const s = (content: string) => [{ type: "text", content }];
describe("MinerU raw archive admission", () => {
  it("retains fixed VLM requests and selects the documented pipeline request fields", () => {
    expect(mineruRequestFields("vlm-engine")).toEqual(MINERU_REQUEST_FIELDS);
    expect(Object.fromEntries(mineruRequestFields("pipeline"))).toMatchObject({
      backend: "pipeline",
      lang_list: "ch",
      parse_method: "auto",
      formula_enable: "true",
      table_enable: "true",
      return_content_list: "true",
      return_middle_json: "true",
    });
    expect(
      Object.fromEntries(mineruRequestFields("pipeline")),
    ).not.toHaveProperty("image_analysis");
  });
  it.each(RAW_PARSE_PROFILES)(
    "publishes only declared artifacts from %s with deterministic identity",
    async (profile) => {
      const bytes = rawParseArchive(profile);
      const output = await convertMinerURawArchive(bytes, {
        ...options,
        profile,
      });
      const again = await convertMinerURawArchive(bytes, {
        ...options,
        profile,
      });
      expect(again.result).toEqual(output.result);
      expect(output.result).toMatchObject({
        profile,
        page_count: 1,
        page_sizes: [[595, 842]],
      });
      expect(output.result.parser_version).toContain(profile);
      expect(
        parseRawBlocksV1(
          JSON.parse(Buffer.from(output.blocks.bytes).toString()),
          [],
        ).blocks,
      ).toHaveLength(2);
      expect(output.resources).toEqual([]);
      expect(Object.keys(output).sort()).toEqual([
        "blocks",
        "markdown",
        "private_content_list",
        "resources",
        "result",
      ]);
      expect(
        Buffer.from(output.private_content_list.bytes).toString(),
      ).toContain("paragraph_content");
    },
  );
  it.each(RAW_PARSE_PROFILES)(
    "rejects missing v2, wrong backend, wrong page count and invalid page sizes for %s",
    async (profile) => {
      for (const variant of [
        { omitV2: true },
        { backend: "unrecognized" },
        { pageSizes: [0, 842] },
        { blocks: [[], []] },
      ]) {
        await expect(
          convertMinerURawArchive(rawParseArchive(profile, variant), {
            ...options,
            profile,
          }),
        ).rejects.toThrow();
      }
      await expect(
        convertMinerURawArchive(rawParseArchive(profile), {
          ...options,
          profile,
          page_count: 2,
        }),
      ).rejects.toThrow();
      const other = profile === "pipeline" ? "vlm-engine" : "pipeline";
      await expect(
        convertMinerURawArchive(rawParseArchive(profile), {
          ...options,
          profile: other,
        }),
      ).rejects.toMatchObject({ code: "parser-structure" });
    },
  );
  it("keeps a block-only image and rejects unprovided or escaping image bytes", async () => {
    const blocks = [
      [
        {
          type: "image",
          bbox: [0, 0, 100, 100],
          content: {
            image_source: { path: "images/a.jpg" },
            image_caption: s("Scheme 1"),
            image_footnote: [],
          },
        },
      ],
    ];
    const resources = [
      { name: "images/a.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    ];
    const output = await convertMinerURawArchive(
      rawParseArchive("pipeline", { blocks, resources }),
      { ...options, profile: "pipeline" },
    );
    expect(output.resources.map((r) => r.reference)).toEqual(["images/a.jpg"]);
    const parsed = parseRawBlocksV1(
      JSON.parse(Buffer.from(output.blocks.bytes).toString()),
      ["images/a.jpg"],
    );
    expect(parsed.blocks.map((b) => b.type)).toEqual(["image", "caption"]);
    expect(parsed.blocks[1]?.text).toBe("Scheme 1");
    await expect(
      convertMinerURawArchive(rawParseArchive("pipeline", { blocks }), {
        ...options,
        profile: "pipeline",
      }),
    ).rejects.toThrow();
    blocks[0]![0]!.content.image_source.path = "../outside.jpg";
    await expect(
      convertMinerURawArchive(
        rawParseArchive("pipeline", { blocks, resources }),
        { ...options, profile: "pipeline" },
      ),
    ).rejects.toThrow();
  });
  it.each([
    ["title", { level: 2, title_content: s("Heading") }, "title"],
    ["paragraph", { paragraph_content: s("Text") }, "text"],
    ["page_header", { page_header_content: s("Header") }, "header"],
    ["page_footer", { page_footer_content: s("Footer") }, "footer"],
    ["page_number", { page_number_content: s("1") }, "page-number"],
    ["page_aside_text", { page_aside_text_content: s("Aside") }, "aside"],
    ["page_footnote", { page_footnote_content: s("Footnote") }, "footnote"],
    [
      "equation_interline",
      {
        math_content: "E=mc^2",
        math_type: "latex",
        image_source: { path: "" },
      },
      "equation",
    ],
    ["image", { content: "Description", image_source: { path: "" } }, "image"],
    ["chart", { content: "Chart", image_source: { path: "" } }, "image"],
    [
      "table",
      {
        html: "<table><tr><td>67%</td></tr></table>",
        image_source: { path: "" },
      },
      "table",
    ],
    ["code", { code_content: s("print(1)") }, "text"],
    ["algorithm", { algorithm_content: s("Algorithm") }, "text"],
    [
      "index",
      {
        list_type: "text_list",
        list_items: [{ item_type: "text", item_content: s("Entry") }],
      },
      "list",
    ],
    [
      "list",
      {
        list_type: "text_list",
        list_items: [{ item_type: "text", item_content: s("Entry") }],
      },
      "list",
    ],
    [
      "list",
      {
        list_type: "reference_list",
        list_items: [{ item_type: "text", item_content: s("Citation") }],
      },
      "reference",
    ],
  ] as const)(
    "maps the upstream %s element to its neutral type",
    (type, content, expected) => {
      const result = convertMinerUContentList(
        [[{ type, content, bbox: [1, 2, 3, 4] }]],
        1,
      );
      expect(result.blocks.blocks[0]).toMatchObject({
        type: expected,
        source_type: type,
        page: 0,
        index: 0,
        bbox: [1, 2, 3, 4],
      });
    },
  );
  it("reports an unknown type without leaking untrusted text and never silently drops it", () => {
    for (const type of ["future_type", "untrusted\nprivate text"]) {
      try {
        convertMinerUContentList(
          [[{ type, content: {}, bbox: [0, 0, 1, 1] }]],
          1,
        );
        throw new Error("Expected refusal");
      } catch (error) {
        expect(error).toMatchObject({
          code: "parser-structure",
          source_type: type === "future_type" ? type : undefined,
        });
        expect(String(error)).not.toContain(type);
      }
    }
  });
});

it.each(["table", "equation_interline"])(
  "preserves %s without inventing a raster for MinerU's empty-crop sentinel",
  (type) => {
    const result = convertMinerUContentList(
      [
        [
          {
            type,
            bbox: [0, 0, 100, 100],
            content: {
              image_source: { path: "images/" },
              ...(type === "table"
                ? { html: "<table><tr><td>67%</td></tr></table>" }
                : { math_type: "latex", math_content: "E=mc^2" }),
            },
          },
        ],
      ],
      1,
    );
    expect(result.references).toEqual([]);
    expect(result.blocks.blocks[0]!.image_ref).toBeNull();
    expect(
      type === "table"
        ? result.blocks.blocks[0]!.html
        : result.blocks.blocks[0]!.text,
    ).toContain(type === "table" ? "67%" : "E=mc^2");
  },
);
