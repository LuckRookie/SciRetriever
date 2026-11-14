import type { PageReading } from "./page.js";

/** `sr-connect1:<encoded address>:<pairing code>`, as the settings page hands it over. */
export function parseConnectionCode(code: string): {
  address: string;
  pairing_code: string;
} {
  const match = /^sr-connect1:([^:\s]+):(srp1_[A-Za-z0-9_-]{43})$/u.exec(
    code.trim(),
  );
  if (!match?.[1] || !match[2])
    throw new CaptureError("连接码格式不对，请从设置页重新复制。", "code");
  return {
    address: normalizeAddress(decodeURIComponent(match[1])),
    pairing_code: match[2],
  };
}

/** A library address: http(s), a host and a port, nothing after it. */
export function normalizeAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CaptureError(
      "地址格式不对，例如 http://localhost:4174",
      "address",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new CaptureError("地址要以 http:// 开头", "address");
  return url.origin;
}

/** The match pattern a host permission is requested for. */
export const originPattern = (address: string) =>
  `${new URL(address).origin}/*`;

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface Identifier {
  namespace: "doi" | "arxiv";
  value: string;
}
export function identifiersOf(
  reading: Pick<PageReading, "doi" | "arxiv">,
): Identifier[] {
  return [
    ...(reading.doi ? [{ namespace: "doi" as const, value: reading.doi }] : []),
    ...(reading.arxiv
      ? [{ namespace: "arxiv" as const, value: reading.arxiv }]
      : []),
  ];
}
/** A DOI or arXiv number the user typed when the page had none. */
export function manualIdentifier(text: string): Identifier | null {
  const value = text.trim();
  const doi = /(10\.\d{4,9}\/\S+)/u.exec(value)?.[1];
  if (doi) return { namespace: "doi", value: doi.toLowerCase() };
  const arxiv =
    /^(?:arxiv:\s*)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)$/iu.exec(
      value,
    )?.[1];
  return arxiv ? { namespace: "arxiv", value: arxiv } : null;
}

const dateOf = (value: string | null) => {
  const match = value
    ? /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?/u.exec(value.trim())
    : null;
  if (!match?.[1]) return { date: null, year: null };
  const [, year, month, day] = match;
  const two = (part: string) => part.padStart(2, "0");
  return {
    date:
      month && Number(month) >= 1 && Number(month) <= 12
        ? day && Number(day) >= 1 && Number(day) <= 31
          ? `${year}-${two(month)}-${two(day)}`
          : `${year}-${two(month)}`
        : year,
    year: Number(year),
  };
};

/** Page fields as neutral metadata for the `web-capture` source record. */
export function metadataOf(
  reading: PageReading,
  identifiers: Identifier[],
): Record<string, unknown> {
  const { date, year } = dateOf(reading.date);
  const pages = reading.first_page
    ? reading.last_page && reading.last_page !== reading.first_page
      ? `${reading.first_page}-${reading.last_page}`
      : reading.first_page
    : null;
  const language =
    reading.language &&
    /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(reading.language)
      ? reading.language.toLowerCase()
      : null;
  return {
    title: reading.title,
    authors: [...new Set(reading.authors)].slice(0, 500).map((name) => ({
      kind: "unknown",
      display_name: name,
      given_name: null,
      family_name: null,
      orcid: null,
      affiliations: [],
    })),
    abstract: reading.abstract,
    publication_date: date,
    publication_year: year,
    language,
    venue: reading.journal,
    publisher: reading.publisher,
    volume: reading.volume,
    issue: reading.issue,
    pages,
    identifiers,
    keywords: [...new Set(reading.keywords)].slice(0, 100),
  };
}

/** The library's preview of a page (`/api/v1/intake/pages/preview`); nothing is written. */
export interface Lookup {
  found: boolean;
  literature_id: string | null;
  library_title: string | null;
  has_pdf: boolean;
  pdf_url: string | null;
}
export interface Folder {
  folder_id: string;
  parent_id: string | null;
  name: string;
}
export interface FileStatus {
  file_id: string;
  action: "upload" | "hash";
  status: "pending" | "uploaded" | "existing" | "conflict";
  reason: string | null;
}
/** The receipt of `/api/v1/intake/pages/save`; a PDF goes on through its batch. */
export interface CaptureResult {
  item_id: string;
  batch_id: string;
  literature_id: string | null;
  disposition: "created" | "enriched" | "matched" | null;
  metadata: { status: string; job_id: string | null; code: string | null };
  missing_folder_ids: string[];
  file: FileStatus | null;
}

const MESSAGES: Record<string, string> = {
  "device-pairing-expired": "连接码已过期，请到设置页重新生成。",
  "device-pairing-used": "连接码已用过，请到设置页重新生成。",
  "device-pairing-invalid": "连接码无效，请从设置页重新复制。",
  "device-exchange-rate-limited": "尝试太频繁，请一分钟后再试。",
  "device-token-invalid": "文献库不认这个扩展了，请重新连接。",
  "device-revoked": "这个设备已在设置页撤销，请重新连接。",
  "device-purpose-forbidden":
    "这个连接没有“入库”用途，请重新生成连接码并勾选入库。",
  "intake-item-empty": "这一页没有读到书目，无法收藏。",
  "intake-identity-conflict": "这个标识在库里对应多篇文献，请到文献库处理。",
  "intake-request-conflict": "这次收藏与之前的请求不一致，请重新打开弹窗。",
  "intake-pdf-invalid": "下载到的文件不是可读的 PDF。",
  "intake-disk-space": "文献库所在磁盘空间不足。",
  "intake-request-too-large": "页面上的书目信息太长，没能保存。",
};

/**
 * The library's intake and pairing routes, over the browser's own fetch. Every
 * request leaves the page's cookies behind (`credentials: "omit"`): the device
 * token is the only credential.
 */
export class LibraryClient {
  constructor(
    readonly address: string,
    private readonly token: string | null,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}
  private async send(
    path: string,
    init: RequestInit,
    auth = true,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.address}${path}`, {
        ...init,
        credentials: "omit",
        headers: {
          ...(init.headers as Record<string, string>),
          "X-Sciretriever-Protocol-Version": "1",
          ...(auth && this.token
            ? { Authorization: `Bearer ${this.token}` }
            : {}),
        },
      });
    } catch {
      throw new CaptureError(`连不上 ${this.address}`, "unreachable");
    }
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      result?: unknown;
    } | null;
    if (!response.ok) {
      const code =
        typeof body?.code === "string" ? body.code : `http-${response.status}`;
      throw new CaptureError(
        MESSAGES[code] ?? `文献库拒绝了请求（${code}）。`,
        code,
      );
    }
    if (!body?.result || typeof body.result !== "object")
      throw new CaptureError("文献库的回复无法识别。", "invalid-reply");
    return body.result as Record<string, unknown>;
  }
  private call(path: string, request: unknown, auth = true) {
    return this.send(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(auth ? { protocol_version: 1, request } : request),
      },
      auth,
    );
  }
  async exchange(pairing_code: string): Promise<string> {
    const result = await this.call(
      "/api/v1/device-connections/exchange",
      { pairing_code },
      false,
    );
    if (typeof result.token !== "string")
      throw new CaptureError("文献库没有给出令牌。", "invalid-reply");
    return result.token;
  }
  /** The library's view of this page's bibliography: in the library or not, with or without a PDF. */
  async lookup(metadata: Record<string, unknown>): Promise<Lookup> {
    return (await this.call("/api/v1/intake/pages/preview", {
      metadata,
    })) as unknown as Lookup;
  }
  async save(request: {
    request_id: string;
    metadata: Record<string, unknown>;
    folder_ids: string[];
    file: { file_name: string; size_bytes: number; sha256: string } | null;
  }): Promise<CaptureResult> {
    return (await this.call(
      "/api/v1/intake/pages/save",
      request,
    )) as unknown as CaptureResult;
  }
  /** The saved PDF goes through the batch the save formed: its hash, or its bytes. */
  async hash(saved: CaptureResult, sha256: string): Promise<FileStatus> {
    return (await this.call(`${fileRoute(saved)}/hash`, { sha256 }))
      .file as FileStatus;
  }
  async bytes(saved: CaptureResult, file: Blob): Promise<FileStatus> {
    return (
      await this.send(`${fileRoute(saved)}/bytes`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      })
    ).file as FileStatus;
  }
}
const fileRoute = (saved: CaptureResult) => {
  if (!saved.file)
    throw new CaptureError("这次收藏没有登记 PDF。", "invalid-reply");
  return `/api/v1/intake/batches/${encodeURIComponent(saved.batch_id)}/files/${encodeURIComponent(saved.file.file_id)}`;
};

/** Folders in tree order, each with its depth for indentation. */
export function folderTree(
  folders: Folder[],
): { folder: Folder; depth: number }[] {
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders)
    children.set(folder.parent_id, [
      ...(children.get(folder.parent_id) ?? []),
      folder,
    ]);
  const ids = new Set(folders.map((folder) => folder.folder_id));
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      out.push({ folder, depth });
      walk(folder.folder_id, depth + 1);
    }
  };
  walk(null, 0);
  // Folders whose parent is not in the list still show, at the top level.
  for (const folder of folders)
    if (
      folder.parent_id &&
      !ids.has(folder.parent_id) &&
      !out.some((o) => o.folder === folder)
    ) {
      out.push({ folder, depth: 0 });
      walk(folder.folder_id, 1);
    }
  return out;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A last path segment usable as the upload's file name. */
export function pdfName(url: string, identifiers: Identifier[]): string {
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    name = "";
  }
  name = name.replace(/[\\/]/gu, "_").slice(0, 200);
  if (!name) name = (identifiers[0]?.value ?? "paper").replace(/[\\/:]/gu, "_");
  return /\.pdf$/iu.test(name) ? name : `${name}.pdf`;
}
