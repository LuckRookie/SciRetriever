import { describe, expect, it } from "vitest";
import {
  parseRawBlocksV1,
  parseRawParse,
  parseRawParseInput,
  rawParseIdentity,
  RAW_BLOCK_TYPES,
} from "../src/index.js";

const hash = "a".repeat(64);
const artifact = (media_type: string) => ({
  sha256: hash,
  byte_size: 12,
  media_type,
});
const block = {
  page: 0,
  index: 0,
  type: "text",
  title_level: null,
  text: "Synthetic source 151.41 ℃",
  html: null,
  image_ref: null,
  bbox: [20, 30, 900, 80],
  source_type: "paragraph",
};
const document = { schema_version: 1, page_count: 2, blocks: [block] };
const input = {
  source_asset_id: "00000000-0000-0000-0000-000000000001",
  source_sha256: hash,
  profile: "pipeline",
  parser_version: "mineru-3.4.4-pipeline",
  model_identity: "synthetic-pipeline",
  parameters_sha256: hash,
  page_count: 2,
  page_sizes: [
    [595, 842],
    [595, 842],
  ],
  blocks: artifact("application/json"),
  markdown: artifact("text/markdown"),
  resources: [
    { reference: "images/figure.png", artifact: artifact("image/png") },
  ],
  private_content_list: artifact("application/json"),
};

describe("raw parsing contracts", () => {
  it.each(RAW_BLOCK_TYPES)(
    "accepts the neutral %s type without rewriting scientific text",
    (type) => {
      const value = parseRawBlocksV1(
        {
          ...document,
          blocks: [
            {
              ...block,
              type,
              title_level: type === "title" ? 2 : null,
              image_ref: type === "image" ? "images/figure.png" : null,
              html: type === "table" ? "<table></table>" : null,
            },
          ],
        },
        ["images/figure.png"],
      );
      expect(value.blocks[0]?.text).toBe(block.text);
      expect(Object.isFrozen(value.blocks[0])).toBe(true);
    },
  );
  it.each([
    { bbox: [-1, 0, 200, 200] },
    { bbox: [0, 0, 1001, 200] },
    { bbox: [200, 0, 100, 200] },
    { bbox: [0, 0, 100.5, 200] },
    { page: 2 },
    { index: -1 },
    { type: "unknown" },
    { image_ref: "images/missing.png" },
    { image_ref: "../secret.png" },
    { image_ref: "https://example.test/a.png" },
    { image_ref: "%2e%2e/secret.png" },
    { title_level: 2 },
    { html: "<table></table>" },
    { source_type: "" },
    { unexpected: "private" },
  ])("rejects invalid blocks (%j)", (change) => {
    expect(() =>
      parseRawBlocksV1({ ...document, blocks: [{ ...block, ...change }] }, []),
    ).toThrow();
  });
  it("rejects duplicate and reordered addresses but permits empty pages", () => {
    expect(() =>
      parseRawBlocksV1({ ...document, blocks: [block, block] }, []),
    ).toThrow();
    expect(() =>
      parseRawBlocksV1(
        { ...document, blocks: [{ ...block, page: 1 }, block] },
        [],
      ),
    ).toThrow();
    expect(
      parseRawBlocksV1({ ...document, blocks: [{ ...block, page: 1 }] }, [])
        .blocks,
    ).toHaveLength(1);
  });
  it("binds the manifest ID to all inputs and output hashes, independent of resource order", async () => {
    const parsed = parseRawParseInput(input);
    const identity = await rawParseIdentity(parsed);
    expect(await parseRawParse({ ...input, ...identity })).toEqual({
      ...parsed,
      ...identity,
    });
    const resources = [
      ...input.resources,
      { reference: "images/second.png", artifact: artifact("image/png") },
    ];
    expect(
      await rawParseIdentity(parseRawParseInput({ ...input, resources })),
    ).toEqual(
      await rawParseIdentity(
        parseRawParseInput({ ...input, resources: [...resources].reverse() }),
      ),
    );
    for (const change of [
      { source_sha256: "b".repeat(64) },
      { profile: "vlm-engine" },
      { model_identity: "other" },
      { parameters_sha256: "b".repeat(64) },
      { markdown: { ...input.markdown, sha256: "b".repeat(64) } },
    ]) {
      await expect(
        parseRawParse({ ...input, ...identity, ...change }),
      ).rejects.toThrow();
    }
    await expect(
      parseRawParse({
        ...input,
        ...identity,
        raw_parse_id: input.source_asset_id,
      }),
    ).rejects.toThrow();
    await expect(
      parseRawParse({ ...input, ...identity, observed_at: "2026-10-20" }),
    ).rejects.toThrow();
  });
  it("requires blocks and page sizes for both profiles and keeps Markdown-only registration explicit", async () => {
    expect(() => parseRawParseInput({ ...input, blocks: null })).toThrow();
    expect(() =>
      parseRawParseInput({ ...input, page_sizes: [[595, 842]] }),
    ).toThrow();
    expect(() =>
      parseRawParseInput({
        ...input,
        page_sizes: [
          [0, 842],
          [595, 842],
        ],
      }),
    ).toThrow();
    expect(() =>
      parseRawParseInput({
        ...input,
        resources: [...input.resources, ...input.resources],
      }),
    ).toThrow();
    const old = {
      ...input,
      profile: "vlm-engine-markdown-only",
      blocks: null,
      private_content_list: null,
      page_sizes: [],
    };
    const parsed = parseRawParseInput(old);
    expect(
      (await parseRawParse({ ...parsed, ...(await rawParseIdentity(parsed)) }))
        .blocks,
    ).toBeNull();
    expect(() =>
      parseRawParseInput({
        ...old,
        private_content_list: input.private_content_list,
      }),
    ).toThrow();
  });
});
