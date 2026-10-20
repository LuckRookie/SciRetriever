import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAssetId, sha256 } from "@sciretriever/contracts";
import { MinerUParser } from "../src/parsing/backends/mineru/http.js";
import { buildDocumentStructure } from "../src/document/builder.js";
import { convertMinerURawArchive } from "../src/parsing/backends/mineru/archive.js";
import { rawParseZip as zip } from "./raw-parse-fixture.js";

const source = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(source).digest("hex");
const archiveOptions = {
  source_asset_id: "00000000-0000-0000-0000-000000000990",
  source_sha256: hash,
  model_identity: "fixture-model",
  profile: "vlm-engine" as const,
};
async function request() {
  return {
    source_asset_id: parseAssetId(archiveOptions.source_asset_id),
    source_sha256: await sha256(source),
    media_type: "application/pdf" as const,
    withContent: async <T>(
      consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    ) =>
      consume(
        (async function* () {
          yield source;
        })(),
      ),
  };
}
function entries(
  options: {
    imagePath?: string;
    imageDirectory?: string;
    markdown?: string;
    backend?: string;
    privateOutput?: string;
  } = {},
) {
  const prefix = "document/vlm/";
  return [
    {
      name: prefix + "document.md",
      bytes: Buffer.from(
        options.markdown ?? "# parsed\n\n![figure](images/figure.jpg)\n",
      ),
    },
    {
      name: prefix + "document_middle.json",
      bytes: Buffer.from(
        JSON.stringify({
          _backend: options.backend ?? "vlm",
          _version_name: "3.4.4",
          pdf_info: [
            { page_idx: 0, page_size: [612, 792] },
            { page_idx: 1, page_size: [612, 792] },
          ],
        }),
      ),
    },
    {
      name: prefix + "document_content_list_v2.json",
      bytes: Buffer.from(
        JSON.stringify([
          [
            {
              type: "image",
              bbox: [1, 2, 900, 900],
              content: {
                image_source: {
                  path: options.imagePath ?? "images/figure.jpg",
                },
                image_caption: [],
                image_footnote: [],
              },
            },
          ],
          [],
        ]),
      ),
    },
    {
      name: (options.imageDirectory ?? prefix + "images/") + "figure.jpg",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    },
    {
      name: prefix + "document_model.json",
      bytes: Buffer.from(options.privateOutput ?? "PRIVATE-ARCHIVE-SENTINEL"),
    },
  ];
}
function nestedArchive(options: Parameters<typeof entries>[0] = {}) {
  return zip(entries(options));
}

describe("TypeScript MinerU raw HTTP client", () => {
  it("sends PDF bytes and a fixed profile, accepting only raw ZIP results", async () => {
    const parser = new MinerUParser(
      {
        request: async (url, input) => {
          expect(url).toBe("http://127.0.0.1:19001/parse");
          expect(input.headers["content-type"]).toBe("application/pdf");
          expect(input.headers["x-sciretriever-profile"]).toBe("vlm-engine");
          expect(input.headers.accept).toBe("application/zip");
          expect(input.body).toEqual(Buffer.from(source));
          return {
            status: 200,
            headers: [["content-type", "application/zip"]],
            body: nestedArchive(),
          };
        },
      },
      { baseUrl: "http://127.0.0.1:19001", modelIdentity: "fixture-model" },
    );
    await expect(
      parser.parseRaw(await request(), "vlm-engine"),
    ).resolves.toMatchObject({
      result: {
        source_asset_id: archiveOptions.source_asset_id,
        profile: "vlm-engine",
        page_count: 2,
      },
    });
  });
  it("rejects the retired JSON response instead of interpreting it as raw parsing", async () => {
    const parser = new MinerUParser(
      {
        request: async () => ({
          status: 200,
          headers: [["content-type", "application/json"]],
          body: Buffer.from("{}"),
        }),
      },
      { baseUrl: "http://127.0.0.1:19001", modelIdentity: "fixture-model" },
    );
    await expect(
      parser.parseRaw(await request(), "vlm-engine"),
    ).rejects.toMatchObject({ code: "parser-unavailable" });
  });
  it.each([
    [
      "traversal",
      () =>
        zip([
          ...entries(),
          { name: "../private.txt", bytes: Buffer.from("secret") },
        ]),
    ],
    [
      "encoded traversal",
      () =>
        zip([
          ...entries(),
          {
            name: "bundle/%252e%252e/private.txt",
            bytes: Buffer.from("secret"),
          },
        ]),
    ],
    [
      "case collision",
      () =>
        zip([
          ...entries(),
          {
            name: "document/vlm/Images/Figure.jpg",
            bytes: Buffer.from("collision"),
          },
        ]),
    ],
    ["wrong backend", () => nestedArchive({ backend: "other" })],
    [
      "CRC mismatch",
      () => {
        const bytes = nestedArchive();
        const offset = 30 + Buffer.byteLength("document/vlm/document.md");
        bytes[offset] = bytes[offset]! ^ 0xff;
        return bytes;
      },
    ],
  ] as const)(
    "rejects %s without publishing a partial result",
    async (_, archive) => {
      await expect(
        convertMinerURawArchive(archive(), archiveOptions),
      ).rejects.toMatchObject({ code: "parser-structure" });
    },
  );
});

it("resolves nested resources strictly relative to their document output", async () => {
  const result = await convertMinerURawArchive(nestedArchive(), archiveOptions);
  expect(result.result.page_count).toBe(2);
  expect(result.resources.map((r) => r.reference)).toEqual([
    "images/figure.jpg",
  ]);
  expect(result.resources[0]!.content.bytes).toEqual(
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
  expect(Buffer.from(result.markdown.bytes).toString()).toContain(
    "(images/figure.jpg)",
  );
  await expect(
    convertMinerURawArchive(nestedArchive(), {
      ...archiveOptions,
      page_count: 1,
    }),
  ).rejects.toMatchObject({ code: "parser-structure" });
});
it.each([
  { imagePath: "../figure.jpg" },
  { imagePath: "%252e%252e/figure.jpg" },
  { imagePath: "images/missing.jpg" },
  { imageDirectory: "images/" },
  { markdown: "# parsed\n![figure](../images/figure.jpg)" },
  { markdown: "# parsed\n![figure](images/missing.jpg)" },
])(
  "rejects missing or escaping resources without a root-directory fallback: %j",
  async (options) => {
    await expect(
      convertMinerURawArchive(nestedArchive(options), archiveOptions),
    ).rejects.toMatchObject({ code: "parser-structure" });
  },
);
it("uses the parsed page count even when raw PDF bytes contain no page object markers", async () => {
  const parser = new MinerUParser(
    {
      request: async () => ({
        status: 200,
        headers: [["content-type", "application/zip"]],
        body: nestedArchive(),
      }),
    },
    { baseUrl: "http://127.0.0.1:19001", modelIdentity: "fixture-model" },
  );
  expect(
    (await parser.parseRaw(await request(), "vlm-engine")).result.page_count,
  ).toBe(2);
});
it("binds immutable raw identity to source, content and model, excluding discarded private output", async () => {
  const first = await convertMinerURawArchive(nestedArchive(), archiveOptions);
  const repeat = await convertMinerURawArchive(
    nestedArchive({ privateOutput: "changed ignored debug data" }),
    archiveOptions,
  );
  expect(repeat.result).toEqual(first.result);
  const other = await convertMinerURawArchive(nestedArchive(), {
    ...archiveOptions,
    source_asset_id: "00000000-0000-0000-0000-000000000993",
    source_sha256: await sha256(new Uint8Array([4, 5, 6])),
  });
  expect(other.result.result_sha256).not.toBe(first.result.result_sha256);
  const model = await convertMinerURawArchive(nestedArchive(), {
    ...archiveOptions,
    model_identity: "different-model-revision",
  });
  expect(model.result.parameters_sha256).not.toBe(
    first.result.parameters_sha256,
  );
  expect(model.result.raw_parse_id).not.toBe(first.result.raw_parse_id);
  expect(Object.keys(first).sort()).toEqual([
    "blocks",
    "markdown",
    "private_content_list",
    "resources",
    "result",
  ]);
});
it.each([
  "![figure][figure-ref]\n\n[figure-ref]: images/figure.jpg\n",
  "![figure][]\n\n[figure]: images/figure.jpg\n",
  '<picture><source srcset="images/figure.jpg 1x"><img src=images/figure.jpg></picture>\n',
  "![figure](images/figure.jpg)\n\n`![code](images/missing.jpg)`\n<!-- ![comment](images/missing.jpg) -->\n```md\n![example](images/missing.jpg)\n```\n",
])(
  "uses the same resource closure for conversion and admission: %s",
  async (markdown) => {
    const converted = await convertMinerURawArchive(
      nestedArchive({ markdown }),
      archiveOptions,
    );
    expect(converted.resources.map((r) => r.reference)).toEqual([
      "images/figure.jpg",
    ]);
    expect(Buffer.from(converted.markdown.bytes).toString()).toBe(markdown);
  },
);
it.each([
  "![figure][ref]\n\n[ref]: images/missing.jpg\n",
  '<img srcset="images/figure.jpg 1x, images/missing.jpg 2x">',
  "![figure][ref]\n\n[ref]: https://example.test/private.jpg\n",
  "![figure][ref]\n\n[ref]: ../private.jpg\n",
])(
  "rejects missing or escaping resources in all supported forms: %s",
  async (markdown) => {
    await expect(
      convertMinerURawArchive(nestedArchive({ markdown }), archiveOptions),
    ).rejects.toMatchObject({ code: "parser-structure" });
  },
);
it("preserves supplied scientific text and heading decisions without turning parser Markdown into the default document", async () => {
  // Synthetic parser OUTPUT, not a claim about real PDF OCR quality.
  const markdown = [
    "# Synthetic multi-column article",
    "Left-column paragraph α, then right-column paragraph β.",
    "# Supporting Information",
    "A publisher marker supplied as a heading by the parser.",
    "## Formula and table",
    "$$E = mc^2$$",
    "| Compound | Yield |",
    "| --- | --- |",
    "| 3m | 67% |",
    "![Scheme][scheme]",
    "[scheme]: images/figure.jpg",
    "",
  ].join("\n");
  const converted = await convertMinerURawArchive(
    nestedArchive({ markdown }),
    archiveOptions,
  );
  const built = await buildDocumentStructure(converted.markdown.bytes);
  expect(Buffer.from(converted.markdown.bytes)).toEqual(Buffer.from(markdown));
  expect(built.structure.sections.map((s) => s.title)).toEqual([
    "Synthetic multi-column article",
    "Supporting Information",
    "Formula and table",
  ]);
  expect(
    Buffer.concat(
      built.structure.segments.map((s) =>
        converted.markdown.bytes.subarray(s.start_utf8, s.end_utf8),
      ),
    ),
  ).toEqual(Buffer.from(markdown));
  expect(converted.resources).toHaveLength(1);
});
