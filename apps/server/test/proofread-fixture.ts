import { convertMinerURawArchive } from "../src/parsing/backends/mineru/archive.js";
import { rawParseArchive } from "./raw-parse-fixture.js";
import type { ProofreadInputReader } from "../src/proofread/draft.js";
import type { PdfPageInspection } from "../src/browser/pdf-region.js";
export const asset = "00000000-0000-0000-0000-000000000991";
export async function proofreadFixture(
  text = "The yield was 67%.",
  layer = text,
  kind: PdfPageInspection["kind"] = "text-layer",
) {
  const output = await convertMinerURawArchive(
    rawParseArchive("vlm-engine", {
      markdown: text,
      blocks: [
        [
          {
            type: "paragraph",
            bbox: [0, 0, 900, 100],
            content: { paragraph_content: [{ type: "text", content: text }] },
          },
        ],
      ],
    }),
    {
      source_asset_id: asset,
      source_sha256: "a".repeat(64),
      profile: "vlm-engine",
      model_identity: "synthetic-vlm",
    },
  );
  const reader: ProofreadInputReader = {
    readArtifact: async (id, kind, ref) => {
      if (id !== output.result.raw_parse_id)
        throw new Error("unexpected raw ID");
      if (kind === "image")
        return output.resources.find((r) => r.reference === ref)!.content.bytes;
      return output[kind].bytes;
    },
  };
  const pages: PdfPageInspection[] = [
    {
      page: 0,
      kind,
      text: kind === "text-layer" ? layer : "",
      visible_glyphs: kind === "text-layer" ? layer.length : 0,
      unmapped_glyphs: 0,
      hidden_glyphs: 0,
      has_graphics: kind === "image-only",
    },
  ];
  return {
    raw: output.result,
    reader,
    pages,
    page_method: "synthetic-pages-v1",
  };
}
