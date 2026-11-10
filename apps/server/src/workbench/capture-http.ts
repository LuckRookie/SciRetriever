import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CAPTURE_MAX_REQUEST_BYTES,
  ContractValidationError,
  CaptureIdentifierRequiredError,
  importObject,
  importHash,
  parseAssetId,
} from "@sciretriever/contracts";
import { CaptureError, type CaptureService } from "../entry/capture.js";
import { ImportSessionError } from "../entry/import-files.js";
import { importHttpBody, importHttpBytes } from "./import-http.js";
import {
  downloadDeviceArtifact,
  DEVICE_ARTIFACT_DIRECTORY,
  deviceFailure,
  type DeviceRoute,
} from "./device-http.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";
import { withActivity } from "../logging/activity.js";
const errors: Readonly<Record<string, number>> = {
  "capture-input-invalid": 400,
  "capture-identifier-required": 400,
  "capture-request-too-large": 413,
  "capture-identity-conflict": 409,
  "capture-request-conflict": 409,
  "capture-pending": 409,
  "capture-missing": 404,
  "capture-file-missing": 404,
  "capture-literature-missing": 404,
  "capture-file-conflict": 409,
  "capture-file-hash-required": 409,
  "capture-file-upload-required": 409,
  "capture-file-hash-mismatch": 400,
  "capture-file-size-mismatch": 400,
  "capture-source-stale": 409,
  "capture-pdf-invalid": 422,
  "capture-upload-cancelled": 400,
  "capture-disk-space": 507,
  "capture-disk-unavailable": 503,
  "capture-unavailable": 503,
  "capture-closed": 503,
};
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
function failure(res: ServerResponse, error: unknown) {
  if (catalogCorruption(error)) {
    deviceFailure(res, error);
    return;
  }
  const raw =
    error instanceof CaptureError
      ? error.code
      : error instanceof ImportSessionError
        ? error.code.replace(/^import-/u, "capture-")
        : error instanceof CaptureIdentifierRequiredError
          ? error.code
          : error instanceof ContractValidationError
            ? "capture-input-invalid"
            : "capture-unavailable";
  const code = Object.hasOwn(errors, raw) ? raw : "capture-unavailable";
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  if (errors[code] === 413) res.setHeader("Connection", "close");
  json(res, errors[code]!, { protocol_version: 1, code });
}
export function captureHttpRoutes(
  service: CaptureService,
  artifactDirectory = DEVICE_ARTIFACT_DIRECTORY,
): DeviceRoute[] {
  const extension = async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      await downloadDeviceArtifact(res, "extension", artifactDirectory);
    } catch (error) {
      deviceFailure(res, error);
    }
  };
  const routes: DeviceRoute[] = [
    {
      method: "GET",
      path: "/api/v1/capture/extension",
      purposes: ["capture"],
      handle: extension,
      handleWeb: extension,
    },
  ];
  for (const [suffix, operation] of [
    ["lookup", "lookup"],
    ["folders", "folders"],
    ["save", "save"],
    ["items/:capture_id/status", "status"],
    ["items/:capture_id/file/hash", "hash"],
    ["items/:capture_id/file/bytes", "bytes"],
  ] as const) {
    routes.push({
      method: "POST",
      path: `/api/v1/capture/${suffix}`,
      purposes: ["capture"],
      async handle(req, res, connection, parameters) {
        try {
          const actor = connection.connection_id,
            captureId = parameters.capture_id
              ? parseAssetId(parameters.capture_id)
              : null;
          let result: unknown;
          if (operation === "bytes")
            result = {
              file: await importHttpBytes(req, res, (chunks, signal, cancel) =>
                service.upload(actor, captureId!, chunks, signal, cancel),
              ),
            };
          else {
            const request = await importHttpBody(
              req,
              CAPTURE_MAX_REQUEST_BYTES,
            );
            if (operation === "lookup") result = await service.lookup(request);
            else if (operation === "folders")
              result = await service.listFolders(request);
            else if (operation === "save")
              result = await withActivity({ actor: `device:${actor}` }, () =>
                service.save(actor, request),
              );
            else if (operation === "hash") {
              const r = importObject(request, ["sha256"]);
              result = {
                file: await service.reportHash(
                  actor,
                  captureId!,
                  importHash(r.sha256),
                ),
              };
            } else {
              importObject(request, []);
              result = await service.status(actor, captureId!);
            }
          }
          json(res, 200, { protocol_version: 1, result });
        } catch (error) {
          failure(res, error);
        }
      },
    });
  }
  return routes;
}
