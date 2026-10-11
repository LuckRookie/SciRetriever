import type {
  AuthorizedPdfClientPort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import {
  targetsForDefinition,
  articleHintTargets,
  uniqueTargets,
} from "../shared/acquisition-locators.js";
import {
  AuthorizedProviderError,
  download,
  hasPdfHeader,
  interpretDownloadResponse,
  mediaType,
  rateLimitedResponse,
  safeIdentity,
  type AuthorizedDownloadLocator,
  type AuthorizedDownloadResult,
  type AuthorizedLookupResult,
  type AuthorizedLookupTarget,
  type AuthorizedTransport,
} from "../shared/authorized-pdf.js";
import { definition, services } from "./definition.js";
function elsevierHeaders(
  apiKey: string,
  institutionToken: string | null,
  accept: string,
): Readonly<Record<string, string>> {
  return {
    accept,
    "x-els-apikey": apiKey,
    ...(institutionToken ? { "x-els-insttoken": institutionToken } : {}),
  };
}
/** Only direct scalar children describe the PDF; nested preview images have their own fields. */
function xmlFields(block: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  const xml = block.replace(/<!--[\s\S]*?-->/gu, "");
  const stack: string[] = [];
  let textStart = 0;
  let scalar = false;
  for (const tag of xml.matchAll(
    /<(\/?)([a-z_][a-z0-9_.:-]*)(?:\s[^<>]*?)?(\/?)>/giu,
  )) {
    const name = tag[2]!;
    if (tag[1] === "/") {
      if (stack.pop() !== name)
        throw new AuthorizedProviderError({ code: "response-schema" });
      if (stack.length === 0 && scalar) {
        const value = xml.slice(textStart, tag.index).trim();
        const localName = name.split(":").at(-1)!.toLowerCase();
        if (!value) continue;
        if (
          value.includes("<") ||
          (fields.has(localName) && fields.get(localName) !== value)
        )
          throw new AuthorizedProviderError({ code: "response-schema" });
        fields.set(localName, value);
      }
    } else {
      if (stack.length === 0) {
        textStart = tag.index + tag[0].length;
        scalar = true;
      } else scalar = false;
      if (tag[3] !== "/") stack.push(name);
    }
  }
  if (stack.length)
    throw new AuthorizedProviderError({ code: "response-schema" });
  return fields;
}
function elsevierMainObjects(bytes: Uint8Array): readonly string[] | null {
  if (bytes.byteLength > 4 * 1024 * 1024) return null;
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
    throw new AuthorizedProviderError({ code: "response-schema" });
  if (!/<(?:[a-z][a-z0-9_.-]*:)?full-text-retrieval-response\b/iu.test(xml))
    return null;
  const elementCount = [...xml.matchAll(/<[a-z][^!?/][^>]*>/giu)].length;
  if (elementCount > 10_000)
    throw new AuthorizedProviderError({ code: "response-schema" });
  const result: string[] = [];
  for (const match of xml.matchAll(
    /<(?:[a-z][a-z0-9_.-]*:)?web-pdf(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/(?:[a-z][a-z0-9_.-]*:)?web-pdf>/giu,
  )) {
    const fields = xmlFields(match[1]!);
    const purpose = fields.get("web-pdf-purpose")?.toLowerCase();
    const extension = fields.get("extension")?.toLowerCase();
    const filename = fields.get("filename");
    const eid = fields.get("attachment-eid");
    if (
      purpose !== "main" ||
      extension !== "pdf" ||
      !filename?.toLowerCase().endsWith(".pdf") ||
      !eid ||
      !/^[a-zA-Z0-9._()-]{1,1024}\.pdf$/u.test(eid)
    )
      continue;
    const identity = `${eid} ${filename}`.toLowerCase();
    if (
      ["supplement", "graphical", "-mmc", "_mmc"].some((marker) =>
        identity.includes(marker),
      )
    )
      continue;
    if (!result.includes(eid)) result.push(eid);
  }
  return Object.freeze(result);
}
export class ElsevierAuthorizedPdfClient implements AuthorizedPdfClientPort {
  readonly provider = "elsevier" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly apiKey: string,
    private readonly institutionToken: string | null = null,
    private readonly origin = services["elsevier-article"].endpoint,
  ) {
    if (!apiKey.trim()) throw new TypeError("Elsevier API key is required");
    if (new URL(origin).origin !== services["elsevier-article"].endpoint)
      throw new TypeError("Elsevier origin is fixed");
  }
  lookup(target: AuthorizedLookupTarget): AuthorizedLookupResult {
    const value = safeIdentity(target.value);
    if (!["doi", "pii", "elsevier-article-eid"].includes(target.namespace))
      throw new AuthorizedProviderError({ code: "response-schema" });
    const namespace =
      target.namespace === "doi"
        ? "elsevier-article-pdf-doi"
        : target.namespace === "pii"
          ? "elsevier-article-pdf-pii"
          : "elsevier-article-pdf-eid";
    return {
      kind: "downloads",
      target: { namespace: target.namespace, value },
      entitlement: "unknown",
      downloads: [
        {
          namespace,
          value,
          declared_media_type: "application/pdf",
          source_record_id: value,
        },
      ],
    };
  }
  async download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult> {
    const mapping: Record<string, string> = {
      "elsevier-article-pdf-doi": "doi",
      "elsevier-article-pdf-pii": "pii",
      "elsevier-article-pdf-eid": "eid",
    };
    const kind = mapping[locator.namespace];
    if (!kind && locator.namespace !== "elsevier-main-pdf-object")
      throw new AuthorizedProviderError({ code: "response-schema" });
    if (locator.namespace === "elsevier-main-pdf-object")
      return download(
        this.transport,
        locator,
        `${this.origin}/content/object/eid/${encodeURIComponent(safeIdentity(locator.value))}`,
        elsevierHeaders(this.apiKey, this.institutionToken, "application/pdf"),
        signal,
      );
    const articleUrl = `${this.origin}/content/article/${kind}/${encodeURIComponent(safeIdentity(locator.value))}?view=FULL`;
    if (signal?.aborted)
      throw new AuthorizedProviderError({ code: "cancelled" });
    const lookup = await this.transport.request(articleUrl, {
      headers: elsevierHeaders(
        this.apiKey,
        this.institutionToken,
        "application/xml",
      ),
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted)
      throw new AuthorizedProviderError({ code: "cancelled" });
    if (rateLimitedResponse(lookup))
      return interpretDownloadResponse(locator, lookup, articleUrl);
    if ([204, 404, 410].includes(lookup.status))
      return interpretDownloadResponse(locator, lookup, articleUrl);
    if (lookup.status !== 200)
      return interpretDownloadResponse(locator, lookup, articleUrl);
    const representation = mediaType(lookup);
    if (
      hasPdfHeader(lookup) ||
      (representation === "application/pdf" &&
        !new TextDecoder()
          .decode(lookup.body.subarray(0, 1024))
          .trimStart()
          .startsWith("<"))
    )
      return interpretDownloadResponse(locator, lookup, articleUrl);
    const objects = elsevierMainObjects(lookup.body);
    if (objects?.length) {
      let normalMiss: AuthorizedDownloadResult | null = null;
      for (const value of objects) {
        const objectLocator: AuthorizedDownloadLocator = {
          namespace: "elsevier-main-pdf-object",
          value,
          declared_media_type: "application/pdf",
          source_record_id: locator.source_record_id,
        };
        const result = await this.download(objectLocator, signal);
        if (result.kind === "download") return result;
        normalMiss ??= result;
      }
      if (normalMiss) return normalMiss;
    }
    return download(
      this.transport,
      locator,
      articleUrl,
      elsevierHeaders(this.apiKey, this.institutionToken, "application/pdf"),
      signal,
    );
  }
}
export function targets(
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  return uniqueTargets([
    ...targetsForDefinition(definition, request),
    ...articleHintTargets(
      request,
      services["elsevier-article"].endpoint,
      (path) => {
        const match = /^\/content\/article\/(doi|pii|eid)(?:\/|:)(.+)$/iu.exec(
          path,
        );
        if (!match) return null;
        const value = safeIdentity(decodeURIComponent(match[2]!));
        if (
          match[1]!.toLowerCase() !== "doi" &&
          !/^[a-zA-Z0-9._()-]+$/u.test(value)
        )
          return null;
        return {
          namespace:
            match[1]!.toLowerCase() === "eid"
              ? "elsevier-article-eid"
              : match[1]!.toLowerCase(),
          value,
        };
      },
    ),
  ]);
}
export function candidateUrl(locator: AuthorizedDownloadLocator): string {
  const value = encodeURIComponent(locator.value);

  const kind = locator.namespace.endsWith("-doi")
    ? "doi"
    : locator.namespace.endsWith("-pii")
      ? "pii"
      : "eid";
  return `${services["elsevier-article"].endpoint}/content/article/${kind}/${value}?view=FULL`;
}
