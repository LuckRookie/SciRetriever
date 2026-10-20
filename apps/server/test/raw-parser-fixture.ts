import { markdownDraft } from "../src/proofread/markdown-draft.js";
/** Synthetic conversion of test parser text; never used by a production adapter. */
import {
  canonicalJsonBytes,
  rawParseIdentity,
  parseRawParse,
  sha256,
  type ArtifactRef,
  type RawParseProfile,
  type RawParseInput,
} from "@sciretriever/contracts";
import type { ParserBackend } from "./parser-fixture-types.js";
import type { RawParserBackend } from "../src/parsing/ports.js";
export function rawParserFixture(
  parser: ParserBackend,
  headerOnly = false,
): RawParserBackend {
  const identity = async (profile: RawParseProfile) => ({
    parser_version: "fixture-raw-1",
    model_identity: `fixture-${profile}`,
    parameters_sha256: await sha256(Buffer.from(profile)),
  });
  const artifact = async (
    bytes: Uint8Array,
    media_type: string,
  ): Promise<ArtifactRef> => ({
    sha256: await sha256(bytes),
    byte_size: bytes.length,
    media_type,
  });
  return {
    identity,
    async parseRaw(request, profile, signal) {
      const output = await parser.parse(request, signal);
      const text = new TextDecoder().decode(output.markdown.bytes);
      const blocksBytes = canonicalJsonBytes({
        schema_version: 1,
        page_count: output.page_count,
        blocks: markdownDraft(text).map((block, index) => ({
          page: 0,
          index,
          type: headerOnly ? "header" : block.type,
          title_level: block.title_level,
          text: block.text,
          html: block.html,
          image_ref: block.image_ref,
          bbox: [0, 0, 1000, 1000],
          source_type: "fixture",
        })),
      });
      const privateBytes = Buffer.from("[]");
      const blocks = {
        artifact: await artifact(blocksBytes, "application/json"),
        bytes: blocksBytes,
      };
      const private_content_list = {
        artifact: await artifact(privateBytes, "application/json"),
        bytes: privateBytes,
      };
      const input: RawParseInput = {
        source_asset_id: request.source_asset_id,
        source_sha256: request.source_sha256,
        profile,
        ...(await identity(profile)),
        page_count: output.page_count,
        page_sizes: Array.from(
          { length: output.page_count },
          () => [595, 842] as const,
        ),
        blocks: blocks.artifact,
        private_content_list: private_content_list.artifact,
        markdown: output.markdown.artifact,
        resources: output.resources.map((r) => ({
          reference: r.reference,
          artifact: r.content.artifact,
        })),
      };
      const result = await parseRawParse({
        ...input,
        ...(await rawParseIdentity(input)),
      });
      return {
        result,
        blocks,
        private_content_list,
        markdown: output.markdown,
        resources: output.resources,
      };
    },
  };
}
export function withRawParserFixture<T extends { parser: ParserBackend }>(
  ports: T,
) {
  return { rawParser: rawParserFixture(ports.parser) };
}
