import {
  parseArtifactRef,
  parseLiteratureId,
  parseParserResult,
  parserResultSha256,
  type Asset,
  type LiteratureCurrentFacts,
  type ParserResult,
} from "@sciretriever/contracts";
import {
  ParsingFailure,
  type ParserBackend,
  type ParserArtifactRules,
  type ParserPublication,
  type StagedParserArtifact,
  type StagedParserOutput,
} from "./ports.js";

export interface ParsingSource {
  currentFacts(literatureId: string): Promise<LiteratureCurrentFacts | null>;
  withArtifact<T>(
    asset: Asset,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<T>;
  inspectPdf(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ readonly page_count: number }>;
}
export interface ParserResultPublisher {
  publish(command: ParserPublication): Promise<ParserResult>;
}
/** Only the issuing service can consume this opaque, single-use preparation. */
export interface PreparedParsing {
  readonly result: ParserResult;
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ParsingFailure("parser-cancelled");
}
function exact(value: object, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new ParsingFailure("parser-structure");
}
function copyArtifact(value: StagedParserArtifact): StagedParserArtifact {
  exact(value, ["artifact", "bytes"]);
  if (!(value.bytes instanceof Uint8Array))
    throw new ParsingFailure("parser-structure");
  return {
    artifact: parseArtifactRef(value.artifact),
    bytes: Uint8Array.from(value.bytes),
  };
}
function copyOutput(value: StagedParserOutput): StagedParserOutput {
  exact(value, [
    "source_asset_id",
    "source_sha256",
    "page_count",
    "markdown",
    "resources",
    "provenance",
  ]);
  if (
    !Array.isArray(value.resources) ||
    value.resources.length > 4096 ||
    !(value.markdown?.bytes instanceof Uint8Array) ||
    value.markdown.bytes.length > 8 * 1024 * 1024
  )
    throw new ParsingFailure("parser-structure");
  let size = 0;
  for (const r of value.resources) {
    exact(r, ["reference", "content"]);
    if (
      !(r.content?.bytes instanceof Uint8Array) ||
      r.content.bytes.length > 32 * 1024 * 1024
    )
      throw new ParsingFailure("parser-structure");
    size += r.content.bytes.length;
  }
  if (size > 128 * 1024 * 1024) throw new ParsingFailure("parser-structure");
  return {
    ...value,
    markdown: copyArtifact(value.markdown),
    resources: value.resources.map((r) => ({
      reference: r.reference,
      content: copyArtifact(r.content),
    })),
    provenance: structuredClone(value.provenance),
  };
}
export class ParsingService {
  private readonly stop = new AbortController();
  private readonly pending = new Map<PreparedParsing, ParserPublication>();
  constructor(
    private readonly source: ParsingSource,
    private readonly parser: ParserBackend,
    private readonly rules: ParserArtifactRules,
    private readonly publisher: ParserResultPublisher,
  ) {}
  async prepareCurrentPrimary(
    literatureId: string,
    signal?: AbortSignal,
  ): Promise<PreparedParsing> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    cancelled(active);
    const id = parseLiteratureId(literatureId);
    const facts = await this.source.currentFacts(id);
    cancelled(active);
    const asset = facts?.primary_asset;
    if (!asset || asset.media_type !== "application/pdf")
      throw new ParsingFailure("parser-stale");
    let pdf: Uint8Array;
    let pageCount: number;
    try {
      pdf = await this.source.withArtifact(
        asset,
        async (chunks) => {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const part of chunks) {
            cancelled(active);
            size += part.length;
            if (size > 256 * 1024 * 1024)
              throw new ParsingFailure("parser-structure");
            parts.push(Buffer.from(part));
          }
          return Buffer.concat(parts);
        },
        { maxBytes: 256 * 1024 * 1024, signal: active },
      );
      pageCount = (await this.source.inspectPdf(pdf, active)).page_count;
      if (
        !Number.isSafeInteger(pageCount) ||
        pageCount < 1 ||
        pageCount > 10000
      )
        throw new ParsingFailure("parser-structure");
    } catch (error) {
      cancelled(active);
      if (error instanceof ParsingFailure) throw error;
      throw new ParsingFailure("parser-unavailable");
    }
    cancelled(active);
    let readable = true;
    let output: StagedParserOutput;
    try {
      const result = await this.parser.parse(
        Object.freeze({
          source_asset_id: asset.asset_id,
          source_sha256: asset.sha256,
          media_type: "application/pdf" as const,
          withContent: async <T>(
            consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
            consumerSignal?: AbortSignal,
          ): Promise<T> => {
            const check = () => {
              cancelled(active);
              if (!readable || consumerSignal?.aborted)
                throw new ParsingFailure("parser-cancelled");
            };
            check();
            const chunks = (async function* () {
              for (let offset = 0; offset < pdf.length; offset += 1024 * 1024) {
                check();
                yield Uint8Array.from(
                  pdf.subarray(offset, offset + 1024 * 1024),
                );
              }
              check();
            })();
            const consumed = await consume(chunks);
            check();
            return consumed;
          },
        }),
        active,
      );
      cancelled(active);
      try {
        output = copyOutput(result);
      } catch {
        throw new ParsingFailure("parser-structure");
      }
    } catch (error) {
      cancelled(active);
      if (error instanceof ParsingFailure) throw error;
      throw new ParsingFailure("parser-unavailable");
    } finally {
      readable = false;
    }
    if (
      output.source_asset_id !== asset.asset_id ||
      output.source_sha256 !== asset.sha256 ||
      output.page_count !== pageCount
    )
      throw new ParsingFailure("parser-structure");
    let result: ParserResult;
    try {
      const core = {
        source_asset_id: asset.asset_id,
        source_sha256: asset.sha256,
        page_count: pageCount,
        markdown: output.markdown.artifact,
        resources: output.resources.map((r) => ({
          reference: r.reference,
          artifact: r.content.artifact,
        })),
        provenance: output.provenance,
      };
      result = await parseParserResult({
        ...core,
        result_sha256: await parserResultSha256(core),
      });
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(
          result.provenance.provenance.source_name,
        )
      )
        throw new ParsingFailure("parser-structure");
      const ordered = result.resources.map(
        (r) => output.resources.find((item) => item.reference === r.reference)!,
      );
      output = { ...output, resources: ordered };
      await this.rules.validate(output, active);
    } catch (error) {
      cancelled(active);
      if (error instanceof ParsingFailure) throw error;
      throw new ParsingFailure("parser-structure");
    }
    cancelled(active);
    const prepared = Object.freeze({ result });
    this.pending.set(prepared, {
      literature_id: id,
      result,
      markdown: output.markdown,
      resources: output.resources,
    });
    return prepared;
  }
  async commitCurrentPrimary(
    prepared: PreparedParsing,
    signal?: AbortSignal,
  ): Promise<ParserResult> {
    const command = this.pending.get(prepared);
    this.pending.delete(prepared);
    if (!command) throw new ParsingFailure("parser-stale");
    cancelled(
      signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal,
    );
    // Commit owns completion after this point; interruption cannot roll back durable bytes.
    try {
      const result = await parseParserResult(
        await this.publisher.publish(command),
      );
      if (result.result_sha256 !== command.result.result_sha256)
        throw new ParsingFailure("parser-publication");
      return result;
    } catch (error) {
      if (error instanceof ParsingFailure) throw error;
      throw new ParsingFailure("parser-publication");
    }
  }
  discardPrepared(prepared: PreparedParsing): void {
    this.pending.delete(prepared);
  }
  close(): void {
    this.stop.abort();
    this.pending.clear();
  }
}
