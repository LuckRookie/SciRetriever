import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DocumentMaterialBytesRequest,
  DocumentMaterialRef,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";

export function materialBytesPath(
  pathname: string,
): DocumentMaterialBytesRequest | null {
  const match =
    /^\/api\/v1\/query\/material-bytes\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(
      pathname,
    );
  if (!match) return null;
  return {
    literature_id: decodeURIComponent(match[1]!),
    asset_id: decodeURIComponent(match[2]!),
    asset_sha256: decodeURIComponent(match[3]!),
  };
}

function materialIdentityHeaders(material: DocumentMaterialRef) {
  return {
    "X-Sciretriever-Protocol-Version": "1",
    "X-Sciretriever-Asset-Id": material.asset_id,
    "X-Sciretriever-Asset-Sha256": material.asset_sha256,
    "X-Sciretriever-Byte-Size": String(material.byte_size),
  };
}

export function pdfMaterialHeaders(material: DocumentMaterialRef) {
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${material.asset_id}.pdf"`,
    ...materialIdentityHeaders(material),
  };
}

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  const header = value?.trim();
  if (!header) return false;
  if (header === "*") return true;
  // Compare weakly and keep commas inside opaque tags inside the item.
  const tags = /[ \t]*(?:(?:W\/)?"([!#-~\u0080-\u00ff]*)"[ \t]*)?(?:,|$)/gy;
  let matched = false;
  while (tags.lastIndex < header.length) {
    const item = tags.exec(header);
    if (!item) return false;
    if (item[1] !== undefined && `"${item[1]}"` === etag) matched = true;
  }
  return matched;
}

function byteRange(value: string | undefined, size: number) {
  const header = value?.trim();
  // RFC 9110 allows ignoring Range. Use the full response for multiple ranges
  // and leave range units other than bytes to the full representation as well.
  if (!header || !/^bytes=/iu.test(header) || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header);
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length ? { start: size - length, end: size - 1 } : "unsatisfiable";
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? { start, end } : "unsatisfiable";
}

export async function sendMaterialBytes(
  request: IncomingMessage,
  response: ServerResponse,
  documentRead: Pick<DocumentReadService, "withMaterialFile">,
  selected: DocumentMaterialBytesRequest,
  signal: AbortSignal,
) {
  const finish = await documentRead.withMaterialFile(
    selected,
    async (material, chunks) => {
      const size = material.byte_size;
      const etag = `"${material.asset_sha256}"`;
      const identityHeaders = {
        "Accept-Ranges": "bytes",
        ...materialIdentityHeaders(material),
      };
      const cacheHeaders = {
        ETag: etag,
        "Cache-Control": "private, max-age=31536000, immutable",
        Vary: "Cookie, Authorization, Origin, Sec-Fetch-Site",
      };
      if (matchesIfNoneMatch(request.headers["if-none-match"], etag))
        return {
          status: 304,
          headers: { ...identityHeaders, ...cacheHeaders },
        };
      const ifRange = request.headers["if-range"];
      const range =
        ifRange === undefined || ifRange === etag
          ? byteRange(request.headers.range, size)
          : null;
      if (range === "unsatisfiable")
        return {
          status: 416,
          headers: { ...identityHeaders, "Content-Range": `bytes */${size}` },
        };
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      const length = end - start + 1;
      response.writeHead(range ? 206 : 200, {
        "Accept-Ranges": "bytes",
        ...pdfMaterialHeaders(material),
        ...cacheHeaders,
        "Content-Length": length,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      let read = 0;
      let last: Uint8Array | undefined;
      for await (const chunk of chunks(start, length)) {
        if (signal.aborted) throw new DocumentReadError("document-cancelled");
        read += chunk.length;
        // With Content-Length the client can finish before end(). Hold the
        // last chunk until both the digest (for whole files) and file checks pass.
        if (read === length) last = chunk;
        else if (!response.write(chunk))
          await once(response, "drain", { signal });
      }
      if (!last || read !== length)
        throw new DocumentReadError("document-integrity");
      return last;
    },
    signal,
  );
  if (finish instanceof Uint8Array) response.end(finish);
  else {
    response.writeHead(finish.status, finish.headers);
    response.end();
  }
}
