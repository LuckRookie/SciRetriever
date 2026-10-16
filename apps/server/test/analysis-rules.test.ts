import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseParserResult,
  parserResultSha256,
  parseProvenance,
  parseAssetId,
  type Sha256,
  type ParserResult,
} from "@sciretriever/contracts";
import { parseContentDraft } from "../src/analysis/ts-rules.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function parserFor(source: string): Promise<ParserResult> {
  const markdown = {
    sha256: hash(source) as Sha256,
    media_type: "text/markdown",
    byte_size: Buffer.byteLength(source),
  } as const;
  const core = {
    source_asset_id: parseAssetId(id(1)),
    source_sha256: hash("pdf-input") as Sha256,
    page_count: 1,
    markdown,
    resources: [],
    provenance: {
      provenance: parseProvenance({
        provenance_id: id(2),
        source_kind: "parser",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: hash("pdf-input") as Sha256,
        parameters_sha256: "a".repeat(64),
      }),
      parser_version: "fixture",
      mode: null,
      model_identity: null,
    },
  };
  return parseParserResult({
    ...core,
    result_sha256: await parserResultSha256(core),
  });
}

function draft(
  body: string,
  reference = "Reference DOI 10.1000/source",
): string {
  return [
    "# 研究背景与目标",
    "",
    body,
    "",
    "# 研究方法",
    "",
    "未提供",
    "",
    "# 数据",
    "",
    "未提供",
    "",
    "# 结论与局限性",
    "",
    "未提供",
    "",
    "# 参考文献",
    "",
    `1. ${reference}`,
    "",
  ].join("\n");
}

it("accepts model paraphrases without lexical fact checking and preserves source binding", async () => {
  const source = "The measurement was 0.012 g. Reference DOI 10.1000/source.";
  const parser = await parserFor(source);
  const parsed = parseContentDraft(
    draft("The mass was 12 mg.", "Reformatted citation"),
    parser,
    source,
  );
  expect(parsed.sections[0]!.markdown).toBe("The mass was 12 mg.");
  expect(parsed.references).toEqual(["Reformatted citation"]);
  expect(() =>
    parseContentDraft(draft("Summary"), parser, source + "changed"),
  ).toThrowError(expect.objectContaining({ code: "content-input" }));
});

it("accepts ordinary Markdown and fills the legacy wrappers without dropping content", async () => {
  const source = "A source paragraph.";
  const parser = await parserFor(source);
  const body =
    "An introduction.\n\n# Findings\n\nUseful finding.\n\n### Detail\n\nAdditional context.\n\n```\n# Code heading\n```";
  const result = parseContentDraft(body, parser, source);
  expect(result.sections.filter((s) => s.role !== "additional")).toHaveLength(
    4,
  );
  expect(result.sections.find((s) => s.title === "总结")?.markdown).toBe(
    "An introduction.",
  );
  expect(
    result.sections.find((s) => s.title === "Findings")?.markdown,
  ).toContain("### Detail");
  expect(
    result.sections.find((s) => s.title === "Findings")?.markdown,
  ).toContain("# Code heading");
  expect(result.references).toEqual([]);
  expect(() => parseContentDraft("", parser, source)).toThrow();
  expect(() => parseContentDraft("# Empty heading", parser, source)).toThrow();
  expect(() =>
    parseContentDraft("Broken\u0000content", parser, source),
  ).toThrow();
});
