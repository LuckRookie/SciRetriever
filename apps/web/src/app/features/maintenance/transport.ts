import { record } from "../../data/wire.js";
import { parseStrictJsonValue } from "@sciretriever/contracts";
import type { ApiClient } from "../../data/api.js";
import { boundedResponseBytes } from "./delivery.js";
/** Uses the existing maintenance CSRF contract in both hosted and independent entries. */
export async function maintain(
  api: ApiClient,
  operation: string,
  request: unknown,
  signal?: AbortSignal,
) {
  const session = await api.read("/api/v1/maintenance/session", signal);
  if (session.protocol_version !== 1 || typeof session.csrf !== "string")
    throw new Error("维护会话无效");
  const response = await api.fetch(`/api/v1/maintenance/${operation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sciretriever-Protocol-Version": "1",
      "X-Sciretriever-Csrf": session.csrf,
    },
    body: JSON.stringify(
      ["parse-document", "document-default"].includes(operation)
        ? request
        : { protocol_version: 1, request },
    ),
    ...(signal ? { signal } : {}),
  });
  const value = record(
    parseStrictJsonValue(
      await boundedResponseBytes(response, response.ok ? 1300 * 1024 : 8192),
    ),
    "maintenance response",
  );
  if (value.protocol_version !== 1) throw new Error("维护回执无效");
  if (!response.ok)
    throw new Error(
      typeof value.reason === "string"
        ? value.reason
        : String(value.code ?? "维护请求未完成"),
    );
  return value;
}
