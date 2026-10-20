import {
  ContractValidationError,
  canonicalJsonBytes,
  parseArtifactRef,
  parseAssetId,
  sha256,
  type ArtifactRef,
  type Sha256,
} from "./index.js";

export const RAW_PARSE_PROFILES = ["pipeline", "vlm-engine"] as const;
export type RawParseProfile = (typeof RAW_PARSE_PROFILES)[number];
export type RawParseSourceProfile =
  | RawParseProfile
  | "vlm-engine-markdown-only";
export const RAW_BLOCK_TYPES = [
  "title",
  "text",
  "list",
  "table",
  "equation",
  "image",
  "caption",
  "footnote",
  "header",
  "footer",
  "page-number",
  "reference",
  "aside",
  "discarded",
] as const;
export type RawBlockType = (typeof RAW_BLOCK_TYPES)[number];
export type PageRegion = readonly [number, number, number, number];
export interface RawBlock {
  readonly page: number;
  readonly index: number;
  readonly type: RawBlockType;
  readonly title_level: number | null;
  readonly text: string;
  readonly html: string | null;
  readonly image_ref: string | null;
  readonly bbox: PageRegion;
  readonly source_type: string;
}
export interface RawBlocksV1 {
  readonly schema_version: 1;
  readonly page_count: number;
  readonly blocks: readonly RawBlock[];
}
export interface RawParseResource {
  readonly reference: string;
  readonly artifact: ArtifactRef;
}
export interface RawParseInput {
  readonly source_asset_id: string;
  readonly source_sha256: Sha256;
  readonly profile: RawParseSourceProfile;
  readonly parser_version: string | null;
  readonly model_identity: string | null;
  readonly parameters_sha256: Sha256;
  readonly page_count: number;
  readonly page_sizes: readonly (readonly [number, number])[];
  readonly blocks: ArtifactRef | null;
  readonly markdown: ArtifactRef;
  readonly resources: readonly RawParseResource[];
  readonly private_content_list: ArtifactRef | null;
}
export interface RawParse extends RawParseInput {
  readonly raw_parse_id: string;
  readonly result_sha256: Sha256;
}

function fail(): never {
  throw new ContractValidationError();
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4 * 1024 * 1024): string {
  if (typeof value !== "string" || value.length > max) fail();
  return value;
}
function identityText(value: unknown): string {
  const parsed = text(value, 256);
  if (
    !parsed.trim() ||
    parsed !== parsed.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(parsed)
  )
    fail();
  return parsed;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail();
  return value as number;
}
function digest(value: unknown): Sha256 {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail();
  return value as Sha256;
}
export function parseRawParseProfile(value: unknown): RawParseProfile {
  if (value !== "pipeline" && value !== "vlm-engine") fail();
  return value;
}
/** Logical resource names, never URLs or machine paths. */
export function parseRawResourceReference(value: unknown): string {
  const name = text(value, 1024);
  if (
    !name ||
    name !== name.normalize("NFC") ||
    name !== name.trim() ||
    /[\\:%?#\p{Cc}\p{Cf}]/u.test(name) ||
    name.startsWith("~/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail();
  return name;
}
export function parsePageRegion(value: unknown): PageRegion {
  if (!Array.isArray(value) || value.length !== 4) fail();
  const [x0, y0, x1, y1] = value.map((v) => integer(v, 0, 1000));
  if (x0! > x1! || y0! > y1!) fail();
  return Object.freeze([x0!, y0!, x1!, y1!]);
}
/** Resource closure is mandatory: a block cannot refer to an unlisted image. */
export function parseRawBlocksV1(
  value: unknown,
  resources: readonly string[],
): RawBlocksV1 {
  const r = exact(value, ["schema_version", "page_count", "blocks"]);
  if (
    r.schema_version !== 1 ||
    !Array.isArray(r.blocks) ||
    r.blocks.length > 1000000
  )
    fail();
  const pages = integer(r.page_count, 1, 10000);
  const references = new Set(resources.map(parseRawResourceReference));
  if (references.size !== resources.length) fail();
  let previousPage = -1;
  let previousIndex = -1;
  const blocks = r.blocks.map((value): RawBlock => {
    const b = exact(value, [
      "page",
      "index",
      "type",
      "title_level",
      "text",
      "html",
      "image_ref",
      "bbox",
      "source_type",
    ]);
    const page = integer(b.page, 0, pages - 1);
    const index = integer(b.index, 0, 1000000);
    if (
      page < previousPage ||
      (page === previousPage && index <= previousIndex)
    )
      fail();
    previousPage = page;
    previousIndex = index;
    if (!RAW_BLOCK_TYPES.includes(b.type as RawBlockType)) fail();
    const type = b.type as RawBlockType;
    const level = b.title_level === null ? null : integer(b.title_level, 1, 6);
    if ((type === "title") !== (level !== null)) fail();
    const html = b.html === null ? null : text(b.html);
    if (html !== null && type !== "table") fail();
    const image =
      b.image_ref === null ? null : parseRawResourceReference(b.image_ref);
    if (image !== null && !references.has(image)) fail();
    return Object.freeze({
      page,
      index,
      type,
      title_level: level,
      text: text(b.text),
      html,
      image_ref: image,
      bbox: parsePageRegion(b.bbox),
      source_type: identityText(b.source_type),
    });
  });
  return Object.freeze({
    schema_version: 1,
    page_count: pages,
    blocks: Object.freeze(blocks),
  });
}
function artifact(value: unknown, media: string): ArtifactRef {
  const result = parseArtifactRef(value);
  if (result.media_type !== media || result.byte_size < 1) fail();
  return result;
}
export function parseRawParseInput(value: unknown): RawParseInput {
  const r = exact(value, [
    "source_asset_id",
    "source_sha256",
    "profile",
    "parser_version",
    "model_identity",
    "parameters_sha256",
    "page_count",
    "page_sizes",
    "blocks",
    "markdown",
    "resources",
    "private_content_list",
  ]);
  const profile =
    r.profile === "vlm-engine-markdown-only"
      ? r.profile
      : parseRawParseProfile(r.profile);
  const pages = integer(r.page_count, 1, 10000);
  if (
    !Array.isArray(r.page_sizes) ||
    !Array.isArray(r.resources) ||
    r.resources.length > 4096
  )
    fail();
  if (
    r.page_sizes.length !== (profile === "vlm-engine-markdown-only" ? 0 : pages)
  )
    fail();
  const sizes = r.page_sizes.map((p): readonly [number, number] => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      p.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)
    )
      fail();
    return Object.freeze([p[0] as number, p[1] as number]);
  });
  const resources = r.resources
    .map((value): RawParseResource => {
      const resource = exact(value, ["reference", "artifact"]);
      const descriptor = parseArtifactRef(resource.artifact);
      if (
        !descriptor.media_type.startsWith("image/") ||
        descriptor.byte_size < 1
      )
        fail();
      return Object.freeze({
        reference: parseRawResourceReference(resource.reference),
        artifact: descriptor,
      });
    })
    .sort((a, b) =>
      a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
    );
  if (new Set(resources.map((r) => r.reference)).size !== resources.length)
    fail();
  const blocks =
    r.blocks === null ? null : artifact(r.blocks, "application/json");
  const privateList =
    r.private_content_list === null
      ? null
      : artifact(r.private_content_list, "application/json");
  if (
    profile === "vlm-engine-markdown-only"
      ? blocks !== null || privateList !== null
      : blocks === null || privateList === null
  )
    fail();
  return Object.freeze({
    source_asset_id: parseAssetId(r.source_asset_id),
    source_sha256: digest(r.source_sha256),
    profile,
    parser_version:
      profile === "vlm-engine-markdown-only" && r.parser_version === null
        ? null
        : identityText(r.parser_version),
    model_identity:
      profile === "vlm-engine-markdown-only" && r.model_identity === null
        ? null
        : identityText(r.model_identity),
    parameters_sha256: digest(r.parameters_sha256),
    page_count: pages,
    page_sizes: Object.freeze(sizes),
    blocks,
    markdown: artifact(r.markdown, "text/markdown"),
    resources: Object.freeze(resources),
    private_content_list: privateList,
  });
}
export async function rawParseIdentity(value: RawParseInput) {
  const result_sha256 = await sha256(
    canonicalJsonBytes(parseRawParseInput(value)),
  );
  const h = result_sha256;
  return Object.freeze({
    raw_parse_id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
    result_sha256,
  });
}
export async function parseRawParse(value: unknown): Promise<RawParse> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const { raw_parse_id, result_sha256, ...input } = value as Record<
    string,
    unknown
  >;
  const parsed = parseRawParseInput(input);
  const identity = await rawParseIdentity(parsed);
  if (
    raw_parse_id !== identity.raw_parse_id ||
    result_sha256 !== identity.result_sha256
  )
    fail();
  return Object.freeze({ ...parsed, ...identity });
}
