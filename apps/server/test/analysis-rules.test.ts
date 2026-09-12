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

it("enforces source alignment for identifiers, measurements, formulas and numbers", async () => {
  const source =
    "Reference DOI 10.1000/source reports 12 mg and $E=mc^2$ with value 42.";
  const parser = await parserFor(source);
  expect(() =>
    parseContentDraft(
      draft("The result is 12 mg, $E=mc^2$, and value 42."),
      parser,
      source,
    ),
  ).not.toThrow();
  expect(() =>
    parseContentDraft(draft("The result is 13 mg."), parser, source),
  ).toThrowError(expect.objectContaining({ code: "measurement-alignment" }));
  expect(() =>
    parseContentDraft(draft("The result is value 43."), parser, source),
  ).toThrowError(expect.objectContaining({ code: "number-alignment" }));
  expect(() =>
    parseContentDraft(draft("The result cites another study."), parser, source),
  ).not.toThrow();
  expect(() =>
    parseContentDraft(
      draft("The result cites another study.", "Unknown reference"),
      parser,
      source,
    ),
  ).toThrowError(expect.objectContaining({ code: "reference-alignment" }));
});

it("rejects unsafe HTML and deep headings while allowing headings in fenced code", async () => {
  const source = "A reference sentence.";
  const parser = await parserFor(source);
  expect(() =>
    parseContentDraft(
      draft("<h1>Injected</h1>", "A reference sentence."),
      parser,
      source,
    ),
  ).toThrowError(expect.objectContaining({ code: "html-heading" }));
  expect(() =>
    parseContentDraft(
      draft("### Deep heading", "A reference sentence."),
      parser,
      source,
    ),
  ).toThrowError(expect.objectContaining({ code: "heading-depth" }));
  expect(() =>
    parseContentDraft(
      draft("```\n# This is code\n```", "A reference sentence."),
      parser,
      source,
    ),
  ).not.toThrow();
});
