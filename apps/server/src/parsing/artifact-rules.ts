import { createHash } from "node:crypto";
import { parseArtifactRef } from "@sciretriever/contracts";
import {
  canonicalParserResourceReference,
  parserMarkdownReferences,
} from "./markdown-resources.js";
import {
  ParsingFailure,
  type ParserArtifactRules,
  type StagedParserArtifact,
  type StagedParserResource,
  type StagedParserOutput,
} from "./ports.js";

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 4096;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_RESOURCE_BYTES = 128 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParsingFailure("parser-structure");
  }
}

function verifyArtifact(
  value: StagedParserArtifact,
  markdown: boolean,
  maxBytes: number,
): string {
  try {
    if (!value || !(value.bytes instanceof Uint8Array)) throw new Error();
    const descriptor = parseArtifactRef(value.artifact);
    if (
      descriptor.byte_size < 1 ||
      descriptor.byte_size > maxBytes ||
      value.bytes.byteLength !== descriptor.byte_size ||
      digest(value.bytes) !== descriptor.sha256 ||
      (markdown && descriptor.media_type !== "text/markdown")
    )
      throw new Error();
    return markdown ? decodeUtf8(value.bytes) : "";
  } catch (error) {
    if (error instanceof ParsingFailure) throw error;
    throw new ParsingFailure("parser-structure");
  }
}

function mediaMatches(
  reference: string,
  mediaType: string,
  bytes: Uint8Array,
): boolean {
  const suffix =
    reference.toLocaleLowerCase().split("/").at(-1)?.split(".").at(-1) ?? "";
  const expected: Record<string, string> = {
    avif: "image/avif",
    bmp: "image/bmp",
    csv: "text/csv",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    tex: "text/plain",
    txt: "text/plain",
    webp: "image/webp",
  };
  const wanted = expected[suffix] ?? "application/octet-stream";
  if (mediaType !== wanted || bytes.length === 0) return false;
  if (wanted === "image/png")
    return Buffer.from(bytes)
      .subarray(0, 8)
      .equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (wanted === "image/jpeg")
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  if (wanted === "image/gif")
    return (
      Buffer.from(bytes).subarray(0, 6).toString("ascii") === "GIF87a" ||
      Buffer.from(bytes).subarray(0, 6).toString("ascii") === "GIF89a"
    );
  if (wanted === "image/webp")
    return (
      Buffer.from(bytes).subarray(0, 4).toString("ascii") === "RIFF" &&
      Buffer.from(bytes).subarray(8, 12).toString("ascii") === "WEBP"
    );
  if (wanted === "image/avif")
    return (
      bytes.length >= 12 &&
      Buffer.from(bytes).subarray(4, 8).toString("ascii") === "ftyp" &&
      Buffer.from(bytes).subarray(8, 32).toString("ascii").includes("avif")
    );
  if (wanted === "image/bmp")
    return Buffer.from(bytes).subarray(0, 2).toString("ascii") === "BM";
  if (wanted === "application/pdf")
    return Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-";
  if (
    wanted.startsWith("text/") ||
    wanted === "application/json" ||
    wanted === "image/svg+xml"
  ) {
    const text = decodeUtf8(bytes);
    return (
      wanted !== "image/svg+xml" ||
      text.slice(0, 4096).toLocaleLowerCase().includes("<svg")
    );
  }
  return true;
}

/** Pure TypeScript P2 gate for already-normalized parser artifacts. */
export class TypeScriptParserArtifactRules implements ParserArtifactRules {
  async validate(
    output: Pick<StagedParserOutput, "markdown" | "resources">,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
    if (
      !output ||
      !Array.isArray(output.resources) ||
      output.resources.length > MAX_RESOURCE_COUNT
    )
      throw new ParsingFailure("parser-structure");
    const markdown = verifyArtifact(output.markdown, true, MAX_MARKDOWN_BYTES);
    if (!markdown.trim()) throw new ParsingFailure("parser-structure");
    const references = parserMarkdownReferences(markdown);
    const byReference = new Map<string, StagedParserResource>();
    let total = 0;
    for (const resource of output.resources) {
      const canonical = canonicalParserResourceReference(resource.reference);
      if (
        canonical !== resource.reference ||
        byReference.has(canonical) ||
        [...byReference.keys()].some(
          (key) => key.toLocaleLowerCase() === canonical.toLocaleLowerCase(),
        )
      )
        throw new ParsingFailure("parser-structure");
      verifyArtifact(resource.content, false, MAX_RESOURCE_BYTES);
      total += resource.content.bytes.byteLength;
      if (total > MAX_TOTAL_RESOURCE_BYTES)
        throw new ParsingFailure("parser-structure");
      byReference.set(canonical, resource);
    }
    if (
      references.length !== byReference.size ||
      references.some((reference) => !byReference.has(reference))
    )
      throw new ParsingFailure("parser-structure");
    for (const reference of references) {
      const resource = byReference.get(reference)!;
      if (
        !mediaMatches(
          reference,
          parseArtifactRef(resource.content.artifact).media_type,
          resource.content.bytes,
        )
      )
        throw new ParsingFailure("parser-structure");
    }
    if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
  }
}
