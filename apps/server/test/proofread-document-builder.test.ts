import { describe, expect, it } from "vitest";
import { parseDocumentStructureV2 } from "@sciretriever/contracts";
import { convertMinerURawArchive } from "../src/parsing/backends/mineru/archive.js";
import { rawParseArchive } from "./raw-parse-fixture.js";
import { buildProofreadVersion } from "../src/proofread/engine.js";
import { buildProofreadStructure } from "../src/document/proofread-builder.js";
async function fixture(different = false) {
  const results = await Promise.all(
    (["vlm-engine"] as const).map((profile) =>
      convertMinerURawArchive(
        rawParseArchive(profile, {
          markdown: `# 方法\n\nα 化学式，产率 ${different && profile === "vlm-engine" ? 87 : 67}%。\n`,
          blocks: [
            [
              {
                type: "title",
                bbox: [10, 10, 900, 80],
                content: {
                  level: 1,
                  title_content: [{ type: "text", content: "方法" }],
                },
              },
              {
                type: "paragraph",
                bbox: [10, 100, 900, 250],
                content: {
                  paragraph_content: [
                    {
                      type: "text",
                      content: `α 化学式，产率 ${different && profile === "vlm-engine" ? 87 : 67}%。`,
                    },
                  ],
                },
              },
            ],
          ],
        }),
        {
          profile,
          source_asset_id: "00000000-0000-0000-0000-000000000961",
          source_sha256: "a".repeat(64),
          model_identity: `synthetic-${profile}`,
        },
      ),
    ),
  );
  return buildProofreadVersion({
    raw: results[0]!.result,
    page_method: "fixture-pages-v1",
    pages: [
      {
        page: 0,
        kind: "text-layer",
        text: "方法 α 化学式，产率 67%。",
        visible_glyphs: 20,
        unmapped_glyphs: 0,
        hidden_glyphs: 0,
        has_graphics: false,
      },
    ],
    reader: {
      readArtifact: async (id, kind) => {
        const source = results.find((r) => r.result.raw_parse_id === id)!;
        if (kind === "image") throw new Error("unexpected image");
        return source[kind].bytes;
      },
    },
  });
}
describe("proofread document structure v2", () => {
  it("makes stable UTF-8 segments with block identity, page regions and no semantic-role mutation", async () => {
    const f = await fixture();
    const a = await buildProofreadStructure(
        f.version,
        f.blocks.bytes,
        f.markdown.bytes,
      ),
      b = await buildProofreadStructure(
        f.version,
        f.blocks.bytes,
        f.markdown.bytes,
      );
    expect(a).toEqual(b);
    expect(a.structure.segments.map((s) => s.kind)).toEqual([
      "heading",
      "text",
    ]);
    expect(a.structure.sections[0]).toMatchObject({
      title: "方法",
      role: null,
      role_source: null,
    });
    const segment = a.structure.segments[1]!;
    expect(segment).toMatchObject({
      page: 0,
      region: [10, 100, 900, 250],
      source: "parser",
      basis: "text-layer",
      uncertainty: null,
      locate: "region",
    });
    expect(
      Buffer.from(f.markdown.bytes)
        .subarray(segment.start_utf8, segment.end_utf8)
        .toString("utf8"),
    ).toContain("α 化学式，产率 67%。");
    expect(segment.segment_id).toBe(segment.block_id);
  });
  it("refuses failed proofreading and modified source bytes", async () => {
    const failed = await fixture(true);
    await expect(
      buildProofreadStructure(
        failed.version,
        failed.blocks.bytes,
        failed.markdown.bytes,
      ),
    ).rejects.toThrow("proofread-document-incomplete");
    const f = await fixture();
    await expect(
      buildProofreadStructure(
        f.version,
        f.blocks.bytes,
        Buffer.from("replaced"),
      ),
    ).rejects.toThrow("proofread-document-integrity");
  });
  it("rejects overlapping ranges, out-of-page locations, forged regions and duplicate block identities", async () => {
    const f = await fixture(),
      built = await buildProofreadStructure(
        f.version,
        f.blocks.bytes,
        f.markdown.bytes,
      );
    for (const update of [
      { page: 1 },
      { region: [-1, 0, 100, 200] },
      { start_utf8: 0 },
      { block_id: built.structure.segments[0]!.block_id },
      { locate: "page" },
    ]) {
      expect(() =>
        parseDocumentStructureV2(
          {
            ...built.structure,
            segments: [
              built.structure.segments[0],
              { ...built.structure.segments[1], ...update },
            ],
          },
          f.markdown.bytes.length,
        ),
      ).toThrow();
    }
  });
});

it("refuses an otherwise valid dense structure before it can exceed the fixed reader's publication limit", async () => {
  const {
    canonicalJsonBytes,
    sha256,
    proofreadIdentity,
    parseProofreadBlocksV1,
  } = await import("@sciretriever/contracts");
  const { renderBlocks } = await import("../src/proofread/render.js");
  const f = await fixture(),
    source = parseProofreadBlocksV1(
      JSON.parse(new TextDecoder().decode(f.blocks.bytes)),
      [],
    );
  const blocks = Array.from({ length: 70000 }, (_, i) => ({
    ...source.blocks[1]!,
    block_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    text: "x",
    raw_ref: [[0, i] as const],
  }));
  const blockBytes = canonicalJsonBytes({ ...source, blocks }),
    markdown = renderBlocks(blocks, []).markdown;
  const { proofread_id: _id, content_sha256: _hash, ...base } = f.version;
  void _id;
  void _hash;
  const input = {
    ...base,
    blocks: {
      ...base.blocks,
      byte_size: blockBytes.length,
      sha256: await sha256(blockBytes),
    },
    markdown: {
      ...base.markdown,
      byte_size: markdown.length,
      sha256: await sha256(markdown),
    },
    stats: base.stats,
  };
  const version = { ...input, ...(await proofreadIdentity(input)) };
  await expect(
    buildProofreadStructure(version, blockBytes, markdown),
  ).rejects.toThrow("proofread-document-structure-limit");
}, 30000);

it("keeps block-owned headings and exact Unicode ranges while honoring cancellation and size bounds", async () => {
  const {
    canonicalJsonBytes,
    sha256,
    proofreadIdentity,
    parseProofreadBlocksV1,
  } = await import("@sciretriever/contracts");
  const { renderBlocks } = await import("../src/proofread/render.js");
  const { MAX_DOCUMENT_MARKDOWN_BYTES } = await import(
    "../src/document/limits.js"
  );
  const f = await fixture();
  const source = parseProofreadBlocksV1(
    JSON.parse(new TextDecoder().decode(f.blocks.bytes)),
    [],
  );
  const blocks = [
    source.blocks[0]!,
    ...Array.from({ length: 1024 }, (_, i) => ({
      ...source.blocks[1]!,
      block_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      text: i === 1023 ? "# Not a structural heading\n中文😀 tail" : "内容 α",
      raw_ref: [[0, i + 1] as const],
    })),
  ];
  const blockBytes = canonicalJsonBytes({ ...source, blocks }),
    markdown = renderBlocks(blocks, []).markdown;
  const { proofread_id: _id, content_sha256: _hash, ...base } = f.version;
  void _id;
  void _hash;
  const input = {
    ...base,
    blocks: {
      ...base.blocks,
      byte_size: blockBytes.length,
      sha256: await sha256(blockBytes),
    },
    markdown: {
      ...base.markdown,
      byte_size: markdown.length,
      sha256: await sha256(markdown),
    },
  };
  const version = { ...input, ...(await proofreadIdentity(input)) };
  const built = await buildProofreadStructure(version, blockBytes, markdown);
  expect(built.structure.sections.map((s) => s.title)).toEqual(["方法"]);
  const last = built.structure.segments.at(-1)!;
  expect(
    new TextDecoder("utf-8", { fatal: true }).decode(
      markdown.subarray(last.start_utf8, last.end_utf8),
    ),
  ).toContain("中文😀 tail");
  const controller = new AbortController();
  const pending = buildProofreadStructure(
    version,
    blockBytes,
    markdown,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 0);
  await expect(pending).rejects.toThrow("proofread-document-cancelled");
  await expect(
    buildProofreadStructure(version, blockBytes, markdown, controller.signal),
  ).rejects.toThrow("proofread-document-cancelled");
  await expect(
    buildProofreadStructure(
      version,
      blockBytes,
      new Uint8Array(MAX_DOCUMENT_MARKDOWN_BYTES + 1),
    ),
  ).rejects.toThrow("proofread-document-markdown-limit");
});
