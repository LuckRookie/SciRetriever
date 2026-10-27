import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi, invalidateMaterials } from "./query.js";
import type { ApiClient } from "./api.js";
import { record } from "./wire.js";
/** All actions pass through the same server application boundary as CLI and MCP. */
export async function archiveQuery(
  api: ApiClient,
  name: string,
  request: unknown,
  signal?: AbortSignal,
) {
  return (await api.query(name, request, signal)).result;
}
export async function archiveWrite(
  api: ApiClient,
  name: string,
  request: unknown,
  signal?: AbortSignal,
) {
  const response = await api.fetch(`/api/v1/maintenance/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sciretriever-Protocol-Version": "1",
    },
    body: JSON.stringify({ protocol_version: 1, request }),
    ...(signal ? { signal } : {}),
  });
  const result = await api.json(response);
  if (result.protocol_version !== 1) throw new Error("操作协议版本不匹配");
  return result.result;
}
export function useArchiveAction() {
  const api = useApi(),
    queries = useQueryClient();
  return useMutation({
    mutationFn: ({ name, request }: { name: string; request: unknown }) =>
      archiveWrite(api, name, request),
    onSuccess: () => {
      invalidateMaterials(queries);
      void queries.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
export function rows(value: unknown, key = "items") {
  const result = record(value, "page");
  if (!Array.isArray(result[key])) throw new Error("列表回执无效");
  return result[key].map((v) => record(v, "item"));
}
/** Archive V2 reads return one JSON value split into UTF-8 windows; only the joined text parses. */
export async function archiveJsonStream(
  api: ApiClient,
  name: string,
  request: Record<string, unknown>,
  continuation: "cursor" | "offset",
  signal?: AbortSignal,
): Promise<{ header: Record<string, unknown>; value: unknown }> {
  let text = "",
    header: Record<string, unknown> | null = null,
    next: string | number | null = null;
  for (let round = 0; round < 256; round++) {
    const page = record(
      await archiveQuery(
        api,
        name,
        continuation === "cursor"
          ? { ...request, cursor: next }
          : { ...request, offset: next ?? 0 },
        signal,
      ),
      "archive stream",
    );
    if (typeof page.text !== "string" || page.encoding !== "json-utf8")
      throw new Error("整理数据回执无效");
    header ??= page;
    text += page.text;
    next =
      continuation === "cursor"
        ? typeof page.next_cursor === "string"
          ? page.next_cursor
          : null
        : typeof page.next_offset === "number"
          ? page.next_offset
          : null;
    if (next === null) return { header, value: JSON.parse(text) };
  }
  throw new Error("整理数据过大，请通过 CLI 分页读取");
}
