import { inflateRawSync } from "node:zlib";
import { parserMarkdownReferences } from "../../markdown-resources.js";
import { createHash } from "node:crypto";
import {
  parseStrictJsonObject,
  ContractValidationError,
  sha256,
  canonicalJsonBytes,
  parseRawParse,
  parseRawParseInput,
  rawParseIdentity,
  type RawParseProfile,
} from "@sciretriever/contracts";
import {
  MINERU_RELEASE,
  MINERU_PROTOCOL,
  MINERU_RAW_ARCHIVE_VERSION,
  mineruRequestFields,
} from "./profile.js";
import {
  ParsingFailure,
  type StagedParserArtifact,
  type StagedRawParseOutput,
} from "../../ports.js";
import { convertMinerUContentList } from "./content-list.js";
import { TypeScriptParserArtifactRules } from "../../artifact-rules.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4096;

function fail(): never {
  throw new ParsingFailure("parser-structure");
}
function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail();
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail();
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function safePath(value: string): string {
  let candidate = value;
  for (let round = 0; round < 8 && candidate.includes("%"); round += 1) {
    if (/%(?![0-9a-f]{2})/iu.test(candidate)) fail();
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      fail();
    }
  }
  if (
    !candidate ||
    candidate.includes("%") ||
    candidate.length > 2048 ||
    candidate.includes("\\") ||
    [...candidate].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) ||
    candidate.startsWith("/") ||
    candidate.startsWith("~/") ||
    /^[A-Za-z]:/u.test(candidate)
  )
    fail();
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail();
  return parts.join("/").normalize("NFC");
}
interface Entry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressed: number;
  readonly size: number;
  readonly crc: number;
  readonly localOffset: number;
  readonly externalAttributes: number;
  readonly madeBy: number;
}
function parseZip(bytes: Uint8Array): readonly Entry[] {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) fail();
  let eocd = -1;
  for (
    let index = bytes.byteLength - 22;
    index >= Math.max(0, bytes.byteLength - 65_557);
    index -= 1
  )
    if (u32(bytes, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  if (eocd < 0) fail();
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  const commentSize = u16(bytes, eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    count > MAX_ENTRIES ||
    centralOffset + centralSize > eocd ||
    eocd + 22 + commentSize > bytes.byteLength
  )
    fail();
  const entries: Entry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, offset) !== 0x02014b50) fail();
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const crc = u32(bytes, offset + 16);
    const compressed = u32(bytes, offset + 20);
    const size = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const externalAttributes = u32(bytes, offset + 38);
    const madeBy = u16(bytes, offset + 4);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || flags & 1 || (method !== 0 && method !== 8)) fail();
    const name = safePath(
      text(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    );
    const folded = name.toLocaleLowerCase();
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (
      names.has(folded) ||
      name.endsWith("/") ||
      externalAttributes & 0x10 ||
      (madeBy >>> 8 === 3 && fileType !== 0 && fileType !== 0x8000)
    )
      fail();
    if (
      size > MAX_ENTRY_BYTES ||
      compressed > MAX_ARCHIVE_BYTES ||
      size > Math.max(compressed, 1) * 200
    )
      fail();
    total += size;
    if (total > MAX_TOTAL_BYTES) fail();
    entries.push({
      name,
      method,
      flags,
      compressed,
      size,
      crc,
      localOffset,
      externalAttributes,
      madeBy,
    });
    names.add(folded);
    offset = end;
  }
  return Object.freeze(entries);
}
function entryBytes(archive: Uint8Array, entry: Entry): Uint8Array {
  const offset = entry.localOffset;
  if (u32(archive, offset) !== 0x04034b50) fail();
  const nameLength = u16(archive, offset + 26);
  const extraLength = u16(archive, offset + 28);
  const localName = safePath(
    text(archive.subarray(offset + 30, offset + 30 + nameLength)),
  );
  if (
    localName !== entry.name ||
    u16(archive, offset + 6) !== entry.flags ||
    u16(archive, offset + 8) !== entry.method ||
    (!(entry.flags & 0x8) &&
      (u32(archive, offset + 14) !== entry.crc ||
        u32(archive, offset + 18) !== entry.compressed ||
        u32(archive, offset + 22) !== entry.size))
  )
    fail();
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (end > archive.byteLength) fail();
  const compressed = archive.subarray(start, end);
  let bytes: Uint8Array;
  try {
    bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    fail();
  }
  if (bytes.byteLength !== entry.size || crc32(bytes) !== entry.crc) fail();
  return bytes;
}
function mediaType(name: string): string {
  const suffix = name.toLowerCase().split(".").at(-1) ?? "";
  return (
    (
      {
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
      } as Record<string, string>
    )[suffix] ?? "application/octet-stream"
  );
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024) fail();
  try {
    return parseStrictJsonObject(
      Buffer.concat([
        Buffer.from('{"value":'),
        Buffer.from(bytes),
        Buffer.from("}"),
      ]),
    ).value;
  } catch {
    fail();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

async function artifact(
  bytes: Uint8Array,
  type: string,
): Promise<StagedParserArtifact> {
  return {
    bytes,
    artifact: {
      sha256: await sha256(bytes),
      media_type: type,
      byte_size: bytes.byteLength,
    },
  };
}

export interface MinerUArchiveOptions {
  readonly source_asset_id: string;
  readonly source_sha256: string;
  readonly page_count?: number;
  readonly model_identity: string;
  readonly parameters_sha256?: string;
}

/** Convert the bounded dual-profile MinerU output; no legacy output fallback. */
export async function convertMinerURawArchive(
  archive: Uint8Array,
  options: MinerUArchiveOptions & { readonly profile: RawParseProfile },
): Promise<StagedRawParseOutput> {
  try {
    if (
      !(archive instanceof Uint8Array) ||
      archive.byteLength > MAX_ARCHIVE_BYTES
    )
      fail();
    const fields = mineruRequestFields(options.profile);
    const files = new Map(
      parseZip(archive).map((entry) => [
        entry.name,
        entryBytes(archive, entry),
      ]),
    );
    const middleNames = [...files.keys()].filter((name) =>
      name.endsWith("_middle.json"),
    );
    if (middleNames.length !== 1) fail();
    const middleName = middleNames[0]!;
    const stem = middleName.slice(0, -"_middle.json".length);
    const middleBytes = files.get(middleName)!;
    const privateBytes = files.get(`${stem}_content_list_v2.json`);
    const markdownBytes = files.get(`${stem}.md`);
    if (
      !privateBytes ||
      !markdownBytes ||
      middleBytes.byteLength + privateBytes.byteLength > 32 * 1024 * 1024
    )
      fail();
    const middle = record(strictJson(middleBytes));
    if (
      middle._backend !==
        (options.profile === "pipeline" ? "pipeline" : "vlm") ||
      !Array.isArray(middle.pdf_info)
    )
      fail();
    const pageCount = middle.pdf_info.length;
    if (
      pageCount < 1 ||
      pageCount > 10000 ||
      (options.page_count !== undefined && options.page_count !== pageCount)
    )
      fail();
    const pageSizes = middle.pdf_info.map(
      (v, index): readonly [number, number] => {
        const p = record(v);
        if (
          p.page_idx !== index ||
          !Array.isArray(p.page_size) ||
          p.page_size.length !== 2 ||
          p.page_size.some(
            (n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0,
          )
        )
          fail();
        return [p.page_size[0] as number, p.page_size[1] as number];
      },
    );
    const converted = convertMinerUContentList(
      strictJson(privateBytes),
      pageCount,
    );
    const markdown = text(markdownBytes);
    if (!markdown.trim()) fail();
    const references = [
      ...new Set([
        ...parserMarkdownReferences(markdown),
        ...converted.references,
      ]),
    ].sort();
    const prefix = stem.slice(0, stem.lastIndexOf("/") + 1);
    const resources = await Promise.all(
      references.map(async (reference) => {
        const bytes = files.get(safePath(`${prefix}${reference}`));
        if (!bytes) fail();
        return {
          reference,
          content: await artifact(bytes, mediaType(reference)),
        };
      }),
    );
    const staged = {
      blocks: await artifact(
        canonicalJsonBytes(converted.blocks),
        "application/json",
      ),
      markdown: await artifact(markdownBytes, "text/markdown"),
      resources,
      private_content_list: await artifact(privateBytes, "application/json"),
    };
    await new TypeScriptParserArtifactRules().validate(
      staged,
      undefined,
      converted.references,
    );
    const input = parseRawParseInput({
      source_asset_id: options.source_asset_id,
      source_sha256: options.source_sha256,
      profile: options.profile,
      parser_version: `mineru-${MINERU_RELEASE}-${options.profile}/${MINERU_RAW_ARCHIVE_VERSION}`,
      model_identity: options.model_identity,
      parameters_sha256:
        options.parameters_sha256 ??
        hash(
          canonicalJsonBytes({
            adapter: MINERU_RAW_ARCHIVE_VERSION,
            release: MINERU_RELEASE,
            protocol: MINERU_PROTOCOL,
            profile: options.profile,
            model_identity: options.model_identity,
            fields: Object.fromEntries(fields),
          }),
        ),
      page_count: pageCount,
      page_sizes: pageSizes,
      blocks: staged.blocks.artifact,
      markdown: staged.markdown.artifact,
      resources: resources.map((r) => ({
        reference: r.reference,
        artifact: r.content.artifact,
      })),
      private_content_list: staged.private_content_list.artifact,
    });
    const result = await parseRawParse({
      ...input,
      ...(await rawParseIdentity(input)),
    });
    return { ...staged, result };
  } catch (error) {
    if (error instanceof ContractValidationError)
      throw new ParsingFailure("parser-structure");
    throw error;
  }
}
