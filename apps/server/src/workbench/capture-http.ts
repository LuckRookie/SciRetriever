import type { IncomingMessage, ServerResponse } from "node:http";
import {
  INTAKE_HTTP_ENDPOINTS,
  INTAKE_PAGE_MAX_REQUEST_BYTES,
  INTAKE_ERROR_STATUSES,
  IntakeItemEmptyError,
} from "@sciretriever/contracts";
import { CaptureError, type CaptureService } from "../entry/capture.js";
import { importHttpBody, importHttpFailure } from "./import-http.js";
import { type DeviceRoute } from "./device-http.js";
import { withActivity } from "../logging/activity.js";
export function captureHttpRoutes(service: CaptureService): DeviceRoute[] {
  return INTAKE_HTTP_ENDPOINTS.filter(
    (e) => e[2] === "page-preview" || e[2] === "page-save",
  ).map(([method, path, operation]) => {
    const execute = async (
      req: IncomingMessage,
      res: ServerResponse,
      connectionId: string | null,
    ) => {
      try {
        if (operation === "page-save" && !connectionId) {
          res.writeHead(403, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              protocol_version: 1,
              code: "device-purpose-forbidden",
            }),
          );
          return;
        }
        const request = await importHttpBody(
          req,
          INTAKE_PAGE_MAX_REQUEST_BYTES,
        );
        const result =
          operation === "page-preview"
            ? await service.lookup(request)
            : await withActivity({ actor: `device:${connectionId}` }, () =>
                service.save(connectionId!, request),
              );
        if (!res.destroyed) {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(JSON.stringify({ protocol_version: 1, result }));
        }
      } catch (error) {
        if (
          error instanceof CaptureError ||
          error instanceof IntakeItemEmptyError
        ) {
          const code = Object.hasOwn(INTAKE_ERROR_STATUSES, error.code)
            ? error.code
            : "intake-unavailable";
          if (!res.destroyed && !res.headersSent) {
            res.writeHead(
              INTAKE_ERROR_STATUSES[code as keyof typeof INTAKE_ERROR_STATUSES],
              {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              },
            );
            res.end(JSON.stringify({ protocol_version: 1, code }));
          } else res.destroy();
        } else importHttpFailure(res, error);
      }
    };
    return {
      method,
      path,
      purposes: ["intake"],
      handle: (req, res, connection) =>
        execute(req, res, connection.connection_id),
      handleWeb: (req, res) => execute(req, res, null),
    };
  });
}
