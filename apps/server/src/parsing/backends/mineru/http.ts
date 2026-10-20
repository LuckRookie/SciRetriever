import { createHash } from "node:crypto";
import { type RawParseProfile } from "@sciretriever/contracts";
import type { HttpResponse } from "../../../network/http.js";
import {
  ParsingFailure,
  type ParserRequest,
  type StagedRawParseOutput,
  type RawParserBackend,
} from "../../ports.js";
import { convertMinerURawArchive } from "./archive.js";
import { mineruRawIdentity } from "./profile.js";

export interface MinerUHttpTransport {
  request(
    url: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly body: Uint8Array;
      readonly headers: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
}

function fail(): never {
  throw new ParsingFailure("parser-unavailable");
}

/** MinerU backend client. The remote operator service is the only parser dependency. */
export class MinerUParser implements RawParserBackend {
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

  identity(profile: RawParseProfile) {
    return mineruRawIdentity(profile, this.modelIdentity);
  }

  async parseRaw(
    request: ParserRequest,
    profile: RawParseProfile,
    signal?: AbortSignal,
  ): Promise<StagedRawParseOutput> {
    const identity = await this.identity(profile);
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
    const pdf = await this.pdfBytes(request, signal);
    const response = await this.transport.request(
      `${this.base.toString().replace(/\/$/u, "")}/parse`,
      {
        body: pdf,
        headers: {
          accept: "application/zip",
          "content-type": "application/pdf",
          "x-sciretriever-profile": profile,
          "x-sciretriever-model": identity.model_identity,
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
    const media = response.headers.filter(
      ([name]) => name.toLowerCase() === "content-type",
    );
    if (
      response.status !== 200 ||
      media.length !== 1 ||
      media[0]![1].split(";", 1)[0]!.trim().toLowerCase() !== "application/zip"
    )
      fail();
    return convertMinerURawArchive(response.body, {
      source_asset_id: request.source_asset_id,
      source_sha256: request.source_sha256,
      profile,
      model_identity: identity.model_identity,
      parameters_sha256: identity.parameters_sha256,
    });
  }

  private async pdfBytes(
    request: ParserRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
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
    return pdf;
  }
}
