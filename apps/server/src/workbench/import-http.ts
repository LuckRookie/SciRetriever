import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContractValidationError,
  IMPORT_LIMITS,
  INTAKE_HTTP_ENDPOINTS,
  INTAKE_ERROR_STATUSES,
  WEB_PAGE_LIMITS,
  importObject,
  importInteger,
  importHash,
  parseAssetId,
  parseLiteratureId,
  parseStrictJsonObject,
  type DeviceConnection,
} from "@sciretriever/contracts";
import {
  ImportSessionError,
  type ImportActor,
  type ImportSessionService,
} from "../entry/import-sessions.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";
import {
  assertRequestContentType,
  RequestContentTypeError,
  deviceFailure,
  type DeviceRoute,
} from "./device-http.js";
import {
  DeviceConnectionError,
  type DeviceConnectionService,
} from "./device-connections.js";
const endpoints = INTAKE_HTTP_ENDPOINTS.filter(
  (e) =>
    ![
      "agent-guide",
      "skill",
      "extension",
      "page-preview",
      "page-save",
    ].includes(e[2]),
);
const model = `WebPageData = {url:string,title:string|null,meta:{attribute:name|property,key:string,content:string}[],json_ld:string[],is_pdf:boolean}
IntakeData = { records: IntakeItem[], groups?: IntakeGroup[], excluded?: {kind:string,count:number}[] }
IntakeGroup = {external_id:string,parent_external_id:string|null,name:string}
IntakeItem = {external_id:string,metadata:LiteratureMetadata,source_type?:string|null,groups?:string[],user_tags?:string[],files?:IntakeFile[],annotations?:IntakeAnnotation[]}
LiteratureMetadata = {title:string|null,authors:Author[],abstract:string|null,publication_date:string|null,publication_year:number|null,publication_form:journal-article|conference-paper|book-or-chapter|thesis|patent|report-or-standard|null,article_kind:research-article|review|letter-or-communication|perspective-or-commentary|correction-or-editorial|null,language:string|null,venue:string|null,publisher:string|null,volume:string|null,issue:string|null,pages:string|null,identifiers:{namespace:string,value:string}[],keywords:string[],subject_terms:string[]}
Author = {kind:person|organization|unknown,display_name:string,given_name:string|null,family_name:string|null,orcid:string|null,affiliations:{name:string,ror:string|null}[]}
IntakeFile = {external_id:string,file_name:string,media_type:string,preferred:boolean,size_bytes?:number|null,sha256?:string|null}
IntakeAnnotation = {external_id:string,file_external_id:string,kind:highlight|underline|region|note|text|ink,quote?:string,note?:string,color?:string|null,page_index?:number|null,coordinate_space?:pdf-bottom-left|normalized-top-left,rects?:[number,number,number,number][]}
IntakeBatch = {batch_id:string,kind:topic|citation|import|legacy,source:{system:string,library_id:string,identity:global|local|adhoc,name:string}|null,confirmation:batch|per-item|null,state:collecting|awaiting-confirmation|running|finished|cancelled|withdrawn,result:completed|partial|failed|interrupted|null,initiated_by:string,created_at:string,confirmed_at:string|null,finished_at:string|null,label:string,default_label:string,renamed:boolean,request:object,counts:{hits:number,created:number,enriched:number,matched:number,rejected:number,restored:number,conflicts:number,possible_duplicates:number,pending_decision:number,needs_metadata:number},pdf:{has_pdf:number,unavailable:number,pending:number},full_text:{total:number,obtained:number,missing:number,exhausted:number},estimates:{acquire_pdf:number,parse:number},progress:{phase:metadata|files|closing,processed_items:number,total_items:number,files:object}|null}
IntakeFileStatus = {file_id:string,external_id:string,record_external_id:string,literature_id:string,file_name:string,size_bytes:number|null,expected_sha256:string|null,action:upload|hash,status:pending|uploaded|existing|conflict,sha256:string|null,reason:string|null}
IntakeItemResult = {sequence:number,record_index:number,external_id:string,disposition:created|enriched|matched|restored|conflict|rejected|pending-decision|excluded,literature_id:string|null,meta_literature_id:string|null,reason:string|null}
IntakeSummary = {full_text:{total:number,obtained:number,missing:number,exhausted:number},records:{created:number,enriched:number,matched:number,conflicts:number,rejected:number,restored:number,possible_duplicates:number,pending_decision:number,needs_metadata:number},files:{upload:number,hash:number,uploaded:number,existing:number,conflicts:number,missing:number,unpaired:number},annotations:{supported:number,unsupported:number,imported:0,deferred:number},excluded:{kind:string,count:number}[]}`;
const errorStatuses: Readonly<Record<string, number>> = INTAKE_ERROR_STATUSES;
export function importInterface(formats: readonly string[]) {
  return {
    protocol_version: 1,
    model_version: 1,
    formats,
    limits: IMPORT_LIMITS,
    authentication: {
      device:
        "Authorization: Bearer <device token>; intake purpose required; no URL credentials",
      web: "Existing login, workbench cookie, client_id, same Origin and X-Workbench-Csrf on POST; never send a device Authorization header with Web credentials",
    },
    json: "X-Sciretriever-Protocol-Version: 1; Content-Type: application/json; {protocol_version:1,request:...}. Response: {protocol_version:1,result:...}; failures: {protocol_version:1,code}.",
    model,
    errors: errorStatuses,
    catalog_corrupt: { status: 503, maintenance_hint: "verify-catalog" },
    endpoints: INTAKE_HTTP_ENDPOINTS.map(
      ([method, path, operation, request, result]) => ({
        method,
        path,
        operation,
        request,
        result,
      }),
    ),
    semantics: [
      "records is a public format for neutral items. When a source has a dedicated adapter, send its original data instead of rewriting it into records.",
      `web-page data is original WebPageData. Its server adapter interprets bibliographic tags and supported JSON-LD, counts invalid JSON blocks and returns file-required for a PDF page. Limits: ${WEB_PAGE_LIMITS.meta} meta tags, ${WEB_PAGE_LIMITS.json_ld} JSON-LD blocks, ${WEB_PAGE_LIMITS.json_ld_bytes} UTF-8 bytes per block, ${WEB_PAGE_LIMITS.bytes} canonical JSON bytes in total.`,
      "Preview is read-only and estimated; confirm decides again and checkpoints each record.",
      "Batch confirmation returns running with progress immediately; the service resumes checkpoints and expires batches. Local CLI/stdio bibliography imports finish synchronously without recovering unrelated batches.",
      "The literature PDF supplement endpoint is Web-only, requires the percent-encoded UTF-8 X-Sciretriever-File-Name header and returns {batch_id,file}; devices are not granted this route. It shares the streaming file channel and a per-entry daily open batch.",
      "One active batch per source library. Repeating a sequence with identical data is idempotent; different data is rejected with intake-data-conflict, without replacing the staged part.",
      "Global source library IDs are independent of device; local library IDs are scoped to device connection. source=null creates an isolated one-off source; it cannot resume a source namespace and uses bibliographic-import semantics, except web-page fields retain user/web-capture provenance.",
      "Import adds observations, folders/members and missing primary PDFs; never deletes or replaces accepted materials.",
      "metadata_only defaults to false and is fixed in batch.request. When true, attachment references are counted as metadata-only-attachment without creating file entries; bibliography-only CLI/stdio/legacy Web wrappers always set it.",
      "Upload the preferred PDF only when action=upload; action=hash needs only sha256. Missing files are paginated; repeat uploads are idempotent.",
      "No file-size ceiling; data requests and batch items have the limits above. Interrupted files restart from byte zero; accepted files remain durable.",
      "Unconfirmed batches cancel after seven days; running batches finish after seven days without a newly settled file. Raw staged data is deleted at the end.",
      "Supported annotations are counted and deferred until the annotation import release; no reading marks are written.",
      "POST /folders lists the full folder tree through the FolderService; it requires intake or authenticated Web, without a batch owner check.",
      "Full-text counts deduplicate papers and inspect all current versions. Batch estimates count eligible versions; explicit acquire-pdf/parse-documents tasks freeze the batch query scope and do not run on import.",
      "Reports retain actual record outcomes and per-file status. Use files with pending=false for the final file report, including missing files.",
    ],
  };
}
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
export function importHttpFailure(res: ServerResponse, error: unknown) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  if (error instanceof RequestContentTypeError) {
    json(res, 415, { protocol_version: 1, code: error.code });
    return;
  }
  if (catalogCorruption(error)) {
    json(res, 503, {
      protocol_version: 1,
      code: "catalog-corrupt",
      maintenance_hint: "verify-catalog",
    });
    return;
  }
  const candidate =
    error instanceof ImportSessionError
      ? error.code
      : error instanceof ContractValidationError
        ? "intake-input-invalid"
        : "intake-unavailable";
  const code = Object.hasOwn(errorStatuses, candidate)
    ? candidate
    : "intake-unavailable";
  const status = errorStatuses[code]!;
  if (status === 413) res.setHeader("Connection", "close");
  json(res, status, { protocol_version: 1, code });
}
export async function importHttpBody(
  req: IncomingMessage,
  maxBytes: number = IMPORT_LIMITS.request_bytes,
) {
  assertRequestContentType(req);
  if (
    req.headers["x-sciretriever-protocol-version"] !== "1" ||
    req.headers["content-encoding"] !== undefined
  )
    throw new ContractValidationError();
  const chunks: Buffer[] = [];
  let total = 0;
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) {
    req.resume();
    throw new ImportSessionError("intake-request-too-large");
  }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += Buffer.byteLength(chunk);
    if (total > maxBytes) {
      req.resume();
      throw new ImportSessionError("intake-request-too-large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const value = importObject(parseStrictJsonObject(Buffer.concat(chunks)), [
    "protocol_version",
    "request",
  ]);
  if (value.protocol_version !== 1) throw new ContractValidationError();
  return value.request;
}
function page(
  value: unknown,
  kind: "file" | "report" | "batch",
  pending = false,
) {
  const r = importObject(
    value,
    [],
    pending ? ["cursor", "limit", "pending"] : ["cursor", "limit"],
  );
  const limit =
    r.limit === undefined
      ? 50
      : importInteger(r.limit, IMPORT_LIMITS.page_items);
  if (
    limit < 1 ||
    (pending && r.pending !== undefined && typeof r.pending !== "boolean")
  )
    throw new ContractValidationError();
  let cursor: string | null = null;
  if (r.cursor !== undefined && r.cursor !== null) {
    if (kind === "report") {
      if (typeof r.cursor !== "string" || !/^\d{1,4}:\d{1,6}$/u.test(r.cursor))
        throw new ContractValidationError();
      cursor = r.cursor;
    } else cursor = parseAssetId(r.cursor);
  }
  return { cursor, limit, pending: r.pending !== false };
}
export async function importHttpBytes<T>(
  req: IncomingMessage,
  res: ServerResponse,
  upload: (
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    cancel: () => void,
  ) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  assertRequestContentType(req, "bytes");
  if (
    req.headers["x-sciretriever-protocol-version"] !== "1" ||
    req.headers["content-encoding"] !== undefined
  )
    throw new ContractValidationError();
  const stop = new AbortController(),
    abort = () => stop.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    return await upload(
      req,
      externalSignal
        ? AbortSignal.any([stop.signal, externalSignal])
        : stop.signal,
      () => {
        // Revocation already sent a Connection: close response; let Node flush it.
        if (externalSignal?.aborted) return;
        if (!req.destroyed) req.destroy();
      },
    );
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

/** Both authentication modes dispatch this exact handler after their own admission. */
export function importHttpRoutes(
  service: ImportSessionService,
  devices?: DeviceConnectionService,
): DeviceRoute[] {
  return endpoints.map(([method, path, operation]) => {
    const execute = async (
      req: IncomingMessage,
      res: ServerResponse,
      parameters: Readonly<Record<string, string>>,
      actor: ImportActor,
    ) => {
      let revoked = false;
      let unsubscribe: (() => void) | undefined;
      try {
        if (operation === "instructions") {
          json(res, 200, {
            protocol_version: 1,
            result: importInterface(service.formats()),
          });
          return;
        }
        const id =
          parameters.batch_id === undefined
            ? null
            : parseAssetId(parameters.batch_id);
        if (id !== null) await service.requireOwner(id, actor);
        let result: unknown;
        if (operation === "bytes" || operation === "supplement") {
          const stop = new AbortController();
          if (actor.kind === "device") {
            if (!devices) throw new DeviceConnectionError("device-unavailable");
            const revoke = () => {
              revoked = true;
              if (!res.headersSent && !res.destroyed) {
                res.setHeader("Connection", "close");
                deviceFailure(res, new DeviceConnectionError("device-revoked"));
              }
              stop.abort();
            };
            unsubscribe = devices.onRevoked((connectionId) => {
              if (connectionId === actor.connection_id) revoke();
            });
            try {
              await devices.requireActive(actor.connection_id);
            } catch (error) {
              if (
                error instanceof DeviceConnectionError &&
                error.code === "device-revoked"
              ) {
                revoke();
                return;
              }
              throw error;
            }
          }
          if (operation === "supplement") {
            const header = req.headers["x-sciretriever-file-name"];
            let name: string;
            try {
              name = decodeURIComponent(
                typeof header === "string" ? header : "",
              );
            } catch {
              throw new ContractValidationError();
            }
            if (
              !name.trim() ||
              Buffer.byteLength(name) > 255 ||
              /[/\\\p{Cc}\p{Cf}]/u.test(name) ||
              name === "." ||
              name === ".."
            )
              throw new ContractValidationError();
            result = await importHttpBytes(req, res, (chunks, signal, cancel) =>
              service.supplementPdf(
                parseLiteratureId(parameters.literature_id),
                chunks,
                "web",
                signal,
                cancel,
                undefined,
                { file_name: name },
              ),
            );
          } else
            result = {
              file: await importHttpBytes(
                req,
                res,
                (chunks, signal, cancel) =>
                  service.upload(
                    id!,
                    parseAssetId(parameters.file_id),
                    chunks,
                    signal,
                    cancel,
                  ),
                stop.signal,
              ),
            };
        } else {
          const request = await importHttpBody(
            req,
            operation === "data"
              ? IMPORT_LIMITS.request_bytes
              : IMPORT_LIMITS.json_request_bytes,
          );
          if (operation === "create")
            result = { batch: await service.create(request, actor) };
          else if (operation === "folders") {
            importObject(request, []);
            result = await service.listFolders();
          } else if (operation === "list") {
            const p = page(request, "batch");
            result = await service.list(p.cursor, p.limit, actor);
          } else if (operation === "data") {
            const r = importObject(request, ["sequence", "data"]);
            result = {
              batch: await service.putData(
                id!,
                importInteger(r.sequence, IMPORT_LIMITS.parts - 1),
                r.data,
              ),
            };
          } else if (operation === "hash") {
            const r = importObject(request, ["sha256"]);
            result = {
              file: await service.reportHash(
                id!,
                parseAssetId(parameters.file_id),
                importHash(r.sha256),
              ),
            };
          } else if (operation === "files") {
            const p = page(request, "file", true);
            result = await service.missingFiles(
              id!,
              p.cursor,
              p.limit,
              p.pending,
            );
          } else if (operation === "report") {
            const p = page(request, "report");
            result = await service.report(id!, p.cursor, p.limit);
          } else {
            importObject(request, []);
            if (operation === "status")
              result = { batch: await service.status(id!) };
            else if (operation === "preview")
              result = await service.preview(id!);
            else if (operation === "confirm")
              result = { batch: await service.confirmInBackground(id!) };
            else if (operation === "finish")
              result = { batch: await service.finish(id!) };
            else result = { batch: await service.cancel(id!) };
          }
        }
        json(res, 200, { protocol_version: 1, result });
      } catch (error) {
        if (!revoked) {
          if (error instanceof DeviceConnectionError) deviceFailure(res, error);
          else importHttpFailure(res, error);
        }
      } finally {
        unsubscribe?.();
      }
    };
    return {
      method,
      path,
      purposes: operation === "supplement" ? [] : ["intake"],
      handle: (req, res, connection: DeviceConnection, p) =>
        execute(req, res, p, {
          kind: "device",
          connection_id: connection.connection_id,
        }),
      handleWeb: (req, res, p) =>
        execute(req, res, p, { kind: "local", origin: "web" }),
    };
  });
}
