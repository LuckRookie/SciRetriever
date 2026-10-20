import {
  canonicalJsonBytes,
  parseParserResult,
  parseRawParse,
  parseRawParseInput,
  rawParseIdentity,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import {
  ParsingFailure,
  type StagedParserArtifact,
  type StagedParserResource,
} from "./ports.js";
import { TypeScriptParserArtifactRules } from "./artifact-rules.js";

/** Read existing immutable bytes; this conversion cannot invoke a parser or change its current relation. */
export async function stageLegacyRawParse(
  value: unknown,
  read: (artifact: ArtifactRef, signal?: AbortSignal) => Promise<Uint8Array>,
  signal?: AbortSignal,
) {
  const parser = await parseParserResult(value);
  let total = 0;
  const load = async (artifact: ArtifactRef): Promise<StagedParserArtifact> => {
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
    total += artifact.byte_size;
    if (total > 128 * 1024 * 1024) throw new ParsingFailure("parser-structure");
    const bytes = await read(artifact, signal);
    if (
      bytes.length !== artifact.byte_size ||
      (await sha256(bytes)) !== artifact.sha256
    )
      throw new ParsingFailure("parser-structure");
    return { artifact, bytes };
  };
  const markdown = await load(parser.markdown);
  const resources: StagedParserResource[] = [];
  for (const r of parser.resources)
    resources.push({ reference: r.reference, content: await load(r.artifact) });
  await new TypeScriptParserArtifactRules().validate(
    { markdown, resources },
    signal,
  );
  const input = parseRawParseInput({
    source_asset_id: parser.source_asset_id,
    source_sha256: parser.source_sha256,
    profile: "vlm-engine-markdown-only",
    parser_version: parser.provenance.parser_version,
    model_identity: parser.provenance.model_identity,
    parameters_sha256: await sha256(
      canonicalJsonBytes({
        method: "register-parser-result-v1",
        parser_result_sha256: parser.result_sha256,
      }),
    ),
    page_count: parser.page_count,
    page_sizes: [],
    blocks: null,
    markdown: parser.markdown,
    resources: parser.resources,
    private_content_list: null,
  });
  return {
    result: await parseRawParse({
      ...input,
      ...(await rawParseIdentity(input)),
    }),
    blocks: null,
    private_content_list: null,
    markdown,
    resources,
  };
}
