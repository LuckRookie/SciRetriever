import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  parseParserResult,
  parseStrictJsonObject,
  parserResultSha256,
  sha256,
  type ParserResult,
} from "@sciretriever/contracts";
import {
  ParsingFailure,
  type ParserArtifactRules,
  type StagedParserArtifact,
  type StagedParserOutput,
} from "../../ports.js";

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
    bytes = entry.method === 0 ? compressed : inflateRawSync(compressed);
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

function validateImagePaths(
  value: unknown,
  markdownReference: string,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  const pending: unknown[] = [value];
  const prefix = markdownReference.includes("/")
    ? markdownReference.slice(0, markdownReference.lastIndexOf("/") + 1)
    : "";
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (key !== "image_path") {
        pending.push(child);
        continue;
      }
      if (typeof child !== "string") fail();
      const reference = safePath(`${prefix}${safePath(child)}`);
      if (!files.has(reference) || !mediaType(reference).startsWith("image/"))
        fail();
    }
  }
}

function primaryOutput(
  files: ReadonlyMap<string, Uint8Array>,
  expectedPageCount: number,
): { readonly markdownReference: string; readonly markdown: Uint8Array } {
  const middleNames = [...files.keys()].filter((name) =>
    name.endsWith("_middle.json"),
  );
  if (middleNames.length !== 1) fail();
  const middleName = middleNames[0]!;
  const stem = middleName.slice(0, -"_middle.json".length);
  if (!stem) fail();
  const markdownReference = `${stem}.md`;
  const modelName = `${stem}_model.json`;
  const contentListName = `${stem}_content_list.json`;
  const markdown = files.get(markdownReference);
  const middleBytes = files.get(middleName);
  const modelBytes = files.get(modelName);
  const contentListBytes = files.get(contentListName);
  if (!markdown || !middleBytes || !modelBytes || !contentListBytes) fail();
  if (
    middleBytes.byteLength +
      modelBytes.byteLength +
      contentListBytes.byteLength >
    32 * 1024 * 1024
  )
    fail();
  const middle = record(strictJson(middleBytes));
  if (middle._backend !== "vlm" || !Array.isArray(middle.pdf_info)) fail();
  if (middle.pdf_info.length !== expectedPageCount) fail();
  middle.pdf_info.forEach((page, index) => {
    const value = record(page);
    if (value.page_idx !== index) fail();
  });
  validateImagePaths(middle, markdownReference, files);
  const model = strictJson(modelBytes);
  if (!model || typeof model !== "object") fail();
  const contentList = strictJson(contentListBytes);
  if (!Array.isArray(contentList)) fail();
  let previousPage = -1;
  for (const item of contentList) {
    const value = record(item);
    if (
      !Number.isSafeInteger(value.page_idx) ||
      (value.page_idx as number) < 0 ||
      (value.page_idx as number) >= expectedPageCount ||
      (value.page_idx as number) < previousPage
    )
      fail();
    previousPage = value.page_idx as number;
  }
  return { markdownReference, markdown };
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
function markdownReferences(markdown: string): readonly string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(
    /!\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu,
  )) {
    const raw = match[1]!.replace(/^<|>$/gu, "");
    values.add(safePath(decodeURIComponent(raw)));
  }
  for (const match of markdown.matchAll(
    /<(?:img|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu,
  ))
    values.add(safePath(decodeURIComponent(match[1]!)));
  return Object.freeze([...values].sort());
}

export interface MinerUArchiveOptions {
  readonly source_asset_id: string;
  readonly source_sha256: string;
  readonly page_count?: number;
  readonly model_identity: string;
  readonly observed_at?: string;
  readonly provenance_id?: string;
  readonly parameters_sha256?: string;
}

/** Convert a bounded MinerU result ZIP without Python, shell tools, or filesystem paths. */
export async function convertMinerUArchive(
  archive: Uint8Array,
  options: MinerUArchiveOptions,
  rules?: Pick<ParserArtifactRules, "validate">,
): Promise<StagedParserOutput & { readonly result: ParserResult }> {
  if (
    !(archive instanceof Uint8Array) ||
    archive.byteLength > MAX_ARCHIVE_BYTES
  )
    fail();
  const entries = parseZip(archive);
  const files = new Map(
    entries.map((entry) => [entry.name, entryBytes(archive, entry)]),
  );
  const expectedPageCount = options.page_count ?? 1;
  if (!Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1) fail();
  const primary = primaryOutput(files, expectedPageCount);
  const markdownBytes = primary.markdown;
  const markdown = text(markdownBytes);
  if (!markdown.trim()) fail();
  const references = markdownReferences(markdown);
  const resources = references.map(async (reference) => {
    const direct = files.get(reference);
    if (!direct) fail();
    return {
      reference,
      content: await artifact(direct, mediaType(reference)),
    };
  });
  const resolvedResources = await Promise.all(resources);
  const provenance = {
    provenance: {
      provenance_id:
        options.provenance_id ?? "00000000-0000-0000-0000-000000000000",
      source_kind: "parser" as const,
      source_name: "mineru-ts",
      source_record_id: null,
      observed_at: options.observed_at ?? new Date().toISOString(),
      input_sha256: options.source_sha256,
      parameters_sha256:
        options.parameters_sha256 ??
        hash(new TextEncoder().encode("mineru-ts-archive-v1")),
    },
    parser_version: "mineru-ts-archive-v1",
    mode: "archive",
    model_identity: options.model_identity,
  };
  const core = {
    source_asset_id: options.source_asset_id,
    source_sha256: options.source_sha256,
    page_count: expectedPageCount,
    markdown: (await artifact(markdownBytes, "text/markdown")).artifact,
    resources: resolvedResources.map((resource) => ({
      reference: resource.reference,
      artifact: resource.content.artifact,
    })),
    provenance,
  };
  const result_sha256 = await parserResultSha256(core as never);
  const result = await parseParserResult({ ...core, result_sha256 });
  const output: StagedParserOutput = {
    source_asset_id: result.source_asset_id,
    source_sha256: result.source_sha256,
    page_count: result.page_count,
    provenance: result.provenance,
    markdown: await artifact(markdownBytes, "text/markdown"),
    resources: resolvedResources,
  };
  if (rules) await rules.validate(output);
  return Object.freeze({ ...output, result });
}
