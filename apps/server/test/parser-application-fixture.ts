import {
  createApplication,
  type Application,
  type ApplicationOptions as ProductionOptions,
} from "../src/bootstrap/application.js";
import type { ParserBackend } from "./parser-fixture-types.js";
import type {
  ParserArtifactRules,
  RawParserBackend,
} from "../src/parsing/ports.js";
import { rawParserFixture } from "./raw-parser-fixture.js";
import { parseRawBlocksV1 } from "@sciretriever/contracts";
import type { PdfPages } from "../src/proofread/contract.js";
export type { Application };
export type ApplicationOptions = Omit<ProductionOptions, "parsing"> & {
  readonly parsing?: {
    readonly parser: ParserBackend;
    readonly rawParser?: RawParserBackend;
    readonly rules: ParserArtifactRules;
  };
};
/** Adapts a synthetic text generator into both raw parser profiles, never a legacy catalog writer. */
export async function createParserFixtureApplication(
  home: string,
  options: ApplicationOptions = {},
) {
  const { parsing, ...rest } = options;
  // These legacy text-generator fixtures test document reads, not OCR/correction
  // quality. Supply a matching synthetic visible layer instead of launching a
  // real renderer for their placeholder PDFs. Dedicated proofreading fixtures
  // supply independent, conflicting layers and test the actual correction rules.
  const pages: PdfPages = {
    method: "synthetic-parser-page-layer-v1",
    async inspect(asset, hash, signal) {
      const current = await application.rawParseStorage!.current(asset, signal);
      const raw = (
        current.find((p) => p.profile === "vlm-engine") ??
        current.find((p) => p.profile === "pipeline")
      )?.result;
      if (!raw || raw.source_sha256 !== hash)
        throw new Error("Synthetic raw input is unavailable");
      const source = await application.rawParseStorage!.loadSource(
        raw.raw_parse_id,
        signal,
      );
      if (!source.blocks) throw new Error("Synthetic raw blocks are required");
      const blocks = parseRawBlocksV1(
        JSON.parse(new TextDecoder().decode(source.blocks.bytes)),
        raw.resources.map((r) => r.reference),
      ).blocks;
      return Array.from({ length: raw.page_count }, (_, page) => {
        const text = blocks
          .filter((b) => b.page === page)
          .map((b) => b.html ?? b.text)
          .join("\n");
        return {
          page,
          kind: text ? ("text-layer" as const) : ("blank" as const),
          text,
          visible_glyphs: text.length,
          hidden_glyphs: 0,
          unmapped_glyphs: 0,
          has_graphics: false,
        };
      });
    },
    async image() {
      throw new Error("Synthetic text fixture must not request an image");
    },
  };
  const application = await createApplication(home, {
    ...rest,
    ...(parsing && !rest.proofreadPages ? { proofreadPages: pages } : {}),
    ...(parsing
      ? {
          parsing: {
            rawParser: parsing.rawParser ?? rawParserFixture(parsing.parser),
          },
        }
      : {}),
  });
  return application;
}
