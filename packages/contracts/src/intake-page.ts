import {
  canonicalJsonBytes,
  ContractValidationError,
  parsePublicSourceUrl,
} from "./index.js";
import { importObject } from "./intake.js";

export const WEB_PAGE_LIMITS = {
  bytes: 512 * 1024,
  meta: 500,
  json_ld: 5,
  json_ld_bytes: 64 * 1024,
} as const;
export function parseIntakeFileName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > 255 ||
    /[/\\\p{Cc}\p{Cf}]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new ContractValidationError();
  return value;
}
export function parseIntakeRelativePath(
  value: unknown,
  fileName: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value ||
    new TextEncoder().encode(value).byteLength > 1024 ||
    /[\\\p{Cc}\p{Cf}]/u.test(value) ||
    /^[a-zA-Z]:/u.test(value)
  )
    throw new ContractValidationError();
  const parts = value.split("/");
  if (
    parts.some((p) => !p || p === "." || p === "..") ||
    parts.at(-1) !== fileName
  )
    throw new ContractValidationError();
  return value;
}
/** Persist only an ordinary address; never persist credentials, query strings or fragments. */
export function intakeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return parsePublicSourceUrl(url.href);
  } catch {
    return null;
  }
}
/** Original page values; interpretation belongs to the server adapter. */
export interface WebPageData {
  readonly url: string;
  readonly title: string | null;
  readonly meta: readonly {
    readonly attribute: "name" | "property";
    readonly key: string;
    readonly content: string;
  }[];
  readonly json_ld: readonly string[];
  readonly is_pdf: boolean;
}
function raw(value: unknown): string {
  if (typeof value !== "string") throw new ContractValidationError();
  return value;
}
export function parseWebPageData(value: unknown): WebPageData {
  const r = importObject(value, ["url", "title", "meta", "json_ld", "is_pdf"]);
  if (
    !Array.isArray(r.meta) ||
    r.meta.length > WEB_PAGE_LIMITS.meta ||
    !Array.isArray(r.json_ld) ||
    r.json_ld.length > WEB_PAGE_LIMITS.json_ld ||
    typeof r.is_pdf !== "boolean"
  )
    throw new ContractValidationError();
  const page: WebPageData = {
    url: parsePublicSourceUrl(r.url),
    title: r.title === null ? null : raw(r.title),
    meta: r.meta.map((value) => {
      const v = importObject(value, ["attribute", "key", "content"]);
      if (v.attribute !== "name" && v.attribute !== "property")
        throw new ContractValidationError();
      return {
        attribute: v.attribute,
        key: raw(v.key),
        content: raw(v.content),
      };
    }),
    json_ld: r.json_ld.map((value) => {
      const text = raw(value);
      if (
        new TextEncoder().encode(text).byteLength >
        WEB_PAGE_LIMITS.json_ld_bytes
      )
        throw new ContractValidationError();
      return text;
    }),
    is_pdf: r.is_pdf,
  };
  if (canonicalJsonBytes(page).byteLength > WEB_PAGE_LIMITS.bytes)
    throw new ContractValidationError();
  return page;
}
