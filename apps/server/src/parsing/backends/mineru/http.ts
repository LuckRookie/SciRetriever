import { createHash } from "node:crypto";
import {
  parseArtifactRef,
  parseParserResult,
  parseStrictJsonObject,
} from "@sciretriever/contracts";
import type { HttpResponse } from "../../../network/http.js";
import {
  ParsingFailure,
  type ParserBackend,
  type ParserRequest,
  type StagedParserArtifact,
  type StagedParserOutput,
} from "../../ports.js";
import { convertMinerUArchive } from "./archive.js";

export interface MinerUHttpTransport {
  request(
    url: string,
    options: {
      readonly body: Uint8Array;
      readonly headers: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
}

function fail(): never {
  throw new ParsingFailure("parser-unavailable");
}

/** Count ordinary PDF page objects without executing a parser or reading paths. */
function pageCount(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?:\s|\/|>)/gu) ?? [];
  return Math.max(1, matches.length);
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) fail();
  return record;
}
function artifact(value: unknown): StagedParserArtifact {
  const record = object(value, ["artifact", "base64"]);
  if (typeof record.base64 !== "string" || !record.base64) fail();
  const bytes = Buffer.from(record.base64, "base64");
  if (bytes.toString("base64") !== record.base64) fail();
  const descriptor = parseArtifactRef(record.artifact);
  if (
    bytes.byteLength !== descriptor.byte_size ||
    createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
  )
    fail();
  return { artifact: descriptor, bytes };
}
async function decode(response: HttpResponse): Promise<StagedParserOutput> {
  if (response.status !== 200) throw new ParsingFailure("parser-unavailable");
  if (response.body.byteLength > 128 * 1024 * 1024) fail();
  const value = parseStrictJsonObject(response.body);
  const record = object(value, [
    "source_asset_id",
    "source_sha256",
    "page_count",
    "result_sha256",
    "markdown",
    "resources",
    "provenance",
  ]);
  if (!Array.isArray(record.resources) || record.resources.length > 4096)
    fail();
  const markdown = artifact(record.markdown);
  const resources = record.resources.map((item) => {
    const resource = object(item, ["reference", "content"]);
    if (typeof resource.reference !== "string" || !resource.reference.trim())
      fail();
    return {
      reference: resource.reference,
      content: artifact(resource.content),
    };
  });
  const parsed = await parseParserResult({
    source_asset_id: record.source_asset_id,
    source_sha256: record.source_sha256,
    page_count: record.page_count,
    result_sha256: record.result_sha256,
    markdown: markdown.artifact,
    resources: resources.map((item) => ({
      reference: item.reference,
      artifact: item.content.artifact,
    })),
    provenance: record.provenance,
  });
  return {
    source_asset_id: parsed.source_asset_id,
    source_sha256: parsed.source_sha256,
    page_count: parsed.page_count,
    provenance: parsed.provenance,
    markdown,
    resources,
  };
}

/** MinerU backend client. The remote operator service is the only parser dependency. */
export class MinerUParser implements ParserBackend {
  private readonly base: URL;
  constructor(
    private readonly transport: MinerUHttpTransport,
    options: { readonly baseUrl: string; readonly modelIdentity: string },
  ) {
    try {
      this.base = new URL(options.baseUrl);
    } catch {
      throw new ParsingFailure("parser-unavailable");
    }
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !options.modelIdentity.trim()
    )
      throw new ParsingFailure("parser-unavailable");
    this.base.pathname = this.base.pathname.replace(/\/$/u, "");
    this.modelIdentity = options.modelIdentity;
  }
  private readonly modelIdentity: string;

  async parse(
    request: ParserRequest,
    signal?: AbortSignal,
  ): Promise<StagedParserOutput> {
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
    const pdf = await request.withContent(async (chunks) => {
      const pieces: Buffer[] = [];
      let size = 0;
      for await (const chunk of chunks) {
        if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
        size += chunk.byteLength;
        if (size > 256 * 1024 * 1024) fail();
        pieces.push(Buffer.from(chunk));
      }
      return Buffer.concat(pieces);
    }, signal);
    if (
      createHash("sha256").update(pdf).digest("hex") !== request.source_sha256
    )
      fail();
    const response = await this.transport.request(
      `${this.base.toString().replace(/\/$/u, "")}/parse`,
      {
        body: pdf,
        headers: {
          accept: "application/json",
          "content-type": "application/pdf",
          "x-sciretriever-model": this.modelIdentity,
        },
        ...(signal ? { signal } : {}),
      },
    );
    const contentType = response.headers
      .find(([name]) => name.toLowerCase() === "content-type")?.[1]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const converted =
      contentType === "application/zip"
        ? await convertMinerUArchive(response.body, {
            source_asset_id: request.source_asset_id,
            source_sha256: request.source_sha256,
            page_count: pageCount(pdf),
            model_identity: this.modelIdentity,
          })
        : await decode(response);
    const result: StagedParserOutput =
      "result" in converted
        ? {
            source_asset_id: converted.source_asset_id,
            source_sha256: converted.source_sha256,
            page_count: converted.page_count,
            provenance: converted.provenance,
            markdown: converted.markdown,
            resources: converted.resources,
          }
        : converted;
    if (
      result.source_asset_id !== request.source_asset_id ||
      result.source_sha256 !== request.source_sha256
    )
      throw new ParsingFailure("parser-structure");
    return result;
  }
}
