import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContractValidationError,
  IMPORT_LIMITS,
  importObject,
  importInteger,
  importHash,
  parseAssetId,
  parseStrictJsonObject,
  type DeviceConnection,
} from "@sciretriever/contracts";
import {
  ImportSessionError,
  type ImportActor,
  type ImportSessionService,
} from "../entry/import-sessions.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";
import type { DeviceRoute } from "./device-http.js";
const endpoints = [
  ["GET", "/api/v1/import/instructions", "instructions", ""],
  [
    "POST",
    "/api/v1/import/sessions",
    "create",
    "{format,library:null|{system,library_id,identity:global|local,name},scope,import_user_tags?:boolean,file_name?:string|null}",
  ],
  [
    "POST",
    "/api/v1/import/sessions/list",
    "list",
    "{cursor?:session_id|null,limit?:1..200}",
  ],
  ["POST", "/api/v1/import/sessions/:session_id/status", "status", "{}"],
  [
    "POST",
    "/api/v1/import/sessions/:session_id/data",
    "data",
    "{sequence:0..1023,data:ImportData|string}",
  ],
  ["POST", "/api/v1/import/sessions/:session_id/preview", "preview", "{}"],
  ["POST", "/api/v1/import/sessions/:session_id/confirm", "confirm", "{}"],
  [
    "POST",
    "/api/v1/import/sessions/:session_id/files",
    "files",
    "{cursor?:file_id|null,limit?:1..200,pending?:boolean}",
  ],
  [
    "POST",
    "/api/v1/import/sessions/:session_id/files/:file_id/hash",
    "hash",
    "{sha256}",
  ],
  [
    "POST",
    "/api/v1/import/sessions/:session_id/files/:file_id/bytes",
    "bytes",
    "raw application/pdf or application/octet-stream, no JSON envelope",
  ],
  ["POST", "/api/v1/import/sessions/:session_id/finish", "finish", "{}"],
  ["POST", "/api/v1/import/sessions/:session_id/cancel", "cancel", "{}"],
  [
    "POST",
    "/api/v1/import/sessions/:session_id/report",
    "report",
    "{cursor?:sequence:record_index|null,limit?:1..200}",
  ],
] as const;
const model = `ImportData = { records: ImportRecord[], groups?: ImportGroup[], excluded?: {kind:string,count:number}[] }
ImportGroup = {external_id:string,parent_external_id:string|null,name:string}
ImportRecord = {external_id:string,metadata:LiteratureMetadata,source_type?:string|null,groups?:string[],user_tags?:string[],files?:ImportFile[],annotations?:ImportAnnotation[]}
LiteratureMetadata = {title:string|null,authors:Author[],abstract:string|null,publication_date:string|null,publication_year:number|null,publication_form:journal-article|conference-paper|book-or-chapter|thesis|patent|report-or-standard|null,article_kind:research-article|review|letter-or-communication|perspective-or-commentary|correction-or-editorial|null,language:string|null,venue:string|null,publisher:string|null,volume:string|null,issue:string|null,pages:string|null,identifiers:{namespace:string,value:string}[],keywords:string[],subject_terms:string[]}
Author = {kind:person|organization|unknown,display_name:string,given_name:string|null,family_name:string|null,orcid:string|null,affiliations:{name:string,ror:string|null}[]}
ImportFile = {external_id:string,file_name:string,media_type:string,preferred:boolean,size_bytes?:number|null,sha256?:string|null}
ImportAnnotation = {external_id:string,file_external_id:string,kind:highlight|underline|region|note|text|ink,quote?:string,note?:string,color?:string|null,page_index?:number|null,coordinate_space?:pdf-bottom-left|normalized-top-left,rects?:[number,number,number,number][]}
ImportSession = {session_id:string,library_key:string,library:{system:string,library_id:string,identity:global|local|adhoc,name:string},format:string,scope:string,file_name:string|null,import_user_tags:boolean,state:collecting|awaiting-confirmation|importing|completed|cancelled,created_at:string,updated_at:string,confirmed_at:string|null,finished_at:string|null,last_file_at:string|null,initiated_by:string,intake_batch_id:string|null,metadata_complete:boolean,record_count:number,processed_records:number,pending_files:number}
ImportFileStatus = {file_id:string,external_id:string,record_external_id:string,literature_id:string,file_name:string,size_bytes:number|null,expected_sha256:string|null,action:upload|hash,status:pending|uploaded|existing|conflict,sha256:string|null,reason:string|null}
ImportRecordResult = {sequence:number,record_index:number,external_id:string,disposition:created|enriched|matched|conflict|rejected,literature_id:string|null,meta_literature_id:string|null,reason:string|null}
ImportSummary = {records:{created:number,enriched:number,matched:number,conflicts:number,rejected:number},files:{upload:number,hash:number,uploaded:number,existing:number,conflicts:number,missing:number},annotations:{supported:number,unsupported:number,imported:0,deferred:number},excluded:{kind:string,count:number}[]}`;
const errorStatuses: Readonly<Record<string, number>> = {
  "import-input-invalid": 400,
  "import-format-unsupported": 400,
  "import-local-identity-required": 400,
  "import-session-missing": 404,
  "import-file-missing": 404,
  "import-literature-missing": 404,
  "import-library-busy": 409,
  "import-session-state": 409,
  "import-data-changed": 409,
  "import-data-conflict": 400,
  "import-group-missing": 400,
  "import-group-cycle": 400,
  "import-group-depth": 400,
  "import-folder-target-missing": 400,
  "import-request-too-large": 413,
  "import-session-limit": 413,
  "import-metadata-pending": 409,
  "import-file-hash-required": 409,
  "import-file-upload-required": 409,
  "import-file-hash-mismatch": 400,
  "import-file-size-mismatch": 400,
  "import-file-conflict": 409,
  "import-pdf-invalid": 422,
  "import-source-stale": 409,
  "import-upload-cancelled": 400,
  "import-disk-space": 507,
  "import-disk-unavailable": 503,
  "import-unavailable": 503,
  "import-closed": 503,
};
const resultShapes: Readonly<Record<string, string>> = {
  instructions: "Interface reference",
  create: "{session:ImportSession}",
  list: "{items:ImportSession[],next_cursor:string|null}",
  status: "{session:ImportSession}",
  data: "{session:ImportSession}",
  preview: "{session:ImportSession,estimated:true,summary:ImportSummary}",
  confirm: "{session:ImportSession}",
  files: "{items:ImportFileStatus[],next_cursor:string|null}",
  hash: "{file:ImportFileStatus}",
  bytes: "{file:ImportFileStatus}",
  finish: "{session:ImportSession}",
  cancel: "{session:ImportSession}",
  report:
    "{session:ImportSession,estimated:false,summary:ImportSummary,items:ImportRecordResult[],next_cursor:string|null}",
};
export function importInterface(formats: readonly string[]) {
  return {
    protocol_version: 1,
    model_version: 1,
    formats,
    limits: IMPORT_LIMITS,
    authentication: {
      device:
        "Authorization: Bearer <device token>; import purpose required; no URL credentials",
      web: "Existing login, workbench cookie, client_id, same Origin and X-Workbench-Csrf on POST; never send a device Authorization header with Web credentials",
    },
    json: "X-Sciretriever-Protocol-Version: 1; Content-Type: application/json; {protocol_version:1,request:...}. Response: {protocol_version:1,result:...}; failures: {protocol_version:1,code}.",
    model,
    errors: errorStatuses,
    catalog_corrupt: { status: 503, maintenance_hint: "verify-catalog" },
    endpoints: endpoints.map(([method, path, operation, request]) => ({
      method,
      path,
      operation,
      request,
      result: resultShapes[operation],
    })),
    semantics: [
      "Preview is read-only and estimated; confirm decides again and checkpoints each record.",
      "One active session per source library. A repeated sequence replaces that part until confirmation.",
      "Global library IDs are independent of device; local IDs are scoped to device connection. library=null creates an isolated one-off file source; it cannot resume a source namespace and uses bibliographic-import semantics.",
      "Import adds observations, folders/members and missing primary PDFs; never deletes or replaces accepted materials.",
      "Upload the preferred PDF only when action=upload; action=hash needs only sha256. Missing files are paginated; repeat uploads are idempotent.",
      "No file-size ceiling; data requests and session records have the limits above. Interrupted files restart from byte zero; accepted files remain durable.",
      "Unconfirmed sessions cancel after seven days; importing sessions finish after seven days without a newly settled file. Raw staged data is deleted at the end.",
      "Supported annotations are counted and deferred until the annotation import release; no reading marks are written.",
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
        ? "import-input-invalid"
        : "import-unavailable";
  const code = Object.hasOwn(errorStatuses, candidate)
    ? candidate
    : "import-unavailable";
  const status = errorStatuses[code]!;
  if (status === 413) res.setHeader("Connection", "close");
  json(res, status, { protocol_version: 1, code });
}
async function body(req: IncomingMessage) {
  if (
    req.headers["x-sciretriever-protocol-version"] !== "1" ||
    req.headers["content-type"] !== "application/json" ||
    req.headers["content-encoding"] !== undefined
  )
    throw new ContractValidationError();
  const chunks: Buffer[] = [];
  let total = 0;
  if (
    Number(req.headers["content-length"] ?? 0) > IMPORT_LIMITS.request_bytes
  ) {
    req.resume();
    throw new ImportSessionError("import-request-too-large");
  }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += Buffer.byteLength(chunk);
    if (total > IMPORT_LIMITS.request_bytes) {
      req.resume();
      throw new ImportSessionError("import-request-too-large");
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
  kind: "file" | "report" | "session",
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
/** Both authentication modes dispatch this exact handler after their own admission. */
export function importHttpRoutes(service: ImportSessionService): DeviceRoute[] {
  return endpoints.map(([method, path, operation]) => {
    const execute = async (
      req: IncomingMessage,
      res: ServerResponse,
      parameters: Readonly<Record<string, string>>,
      actor: ImportActor,
    ) => {
      try {
        if (operation === "instructions") {
          json(res, 200, {
            protocol_version: 1,
            result: importInterface(service.formats()),
          });
          return;
        }
        const id =
          parameters.session_id === undefined
            ? null
            : parseAssetId(parameters.session_id);
        let result: unknown;
        if (operation === "bytes") {
          if (
            req.headers["x-sciretriever-protocol-version"] !== "1" ||
            !["application/pdf", "application/octet-stream"].includes(
              String(req.headers["content-type"]),
            ) ||
            req.headers["content-encoding"] !== undefined
          )
            throw new ContractValidationError();
          const stop = new AbortController(),
            abort = () => stop.abort();
          req.once("aborted", abort);
          res.once("close", abort);
          try {
            result = {
              file: await service.upload(
                id!,
                parseAssetId(parameters.file_id),
                req,
                stop.signal,
                () => {
                  if (!req.destroyed) req.destroy();
                },
              ),
            };
          } finally {
            req.off("aborted", abort);
            res.off("close", abort);
          }
        } else {
          const request = await body(req);
          if (operation === "create")
            result = { session: await service.create(request, actor) };
          else if (operation === "list") {
            const p = page(request, "session");
            result = await service.list(p.cursor, p.limit);
          } else if (operation === "data") {
            const r = importObject(request, ["sequence", "data"]);
            result = {
              session: await service.putData(
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
              result = { session: await service.status(id!) };
            else if (operation === "preview")
              result = await service.preview(id!);
            else if (operation === "confirm")
              result = { session: await service.confirm(id!) };
            else if (operation === "finish")
              result = { session: await service.finish(id!) };
            else result = { session: await service.cancel(id!) };
          }
        }
        json(res, 200, { protocol_version: 1, result });
      } catch (error) {
        importHttpFailure(res, error);
      }
    };
    return {
      method,
      path,
      purposes: ["import"],
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
