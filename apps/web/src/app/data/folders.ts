import {
  parseFolderOperation,
  parseFolderNode,
  parseFolderImpact,
  parseReadingOpen,
  parseUtcTimestamp,
} from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { archiveQuery, archiveWrite } from "./archive.js";
import { record } from "./wire.js";
export async function listFolders(api: ApiClient, signal?: AbortSignal) {
  const r = record(
    await archiveQuery(
      api,
      "folders",
      { operation: "list", request: {} },
      signal,
    ),
    "folders",
  );
  if (!Array.isArray(r.items)) throw new Error("文件夹列表回执无效");
  return { items: r.items.map(parseFolderNode) };
}
export async function previewFolderDeletion(
  api: ApiClient,
  folder_id: string,
  signal?: AbortSignal,
) {
  return parseFolderImpact(
    await archiveQuery(
      api,
      "folders",
      parseFolderOperation({
        operation: "delete-preview",
        request: { folder_id },
      }),
      signal,
    ),
  );
}
export async function manageFolder(
  api: ApiClient,
  value: unknown,
  signal?: AbortSignal,
) {
  const command = parseFolderOperation(value);
  if (command.operation === "list" || command.operation === "delete-preview")
    throw new Error("请选择文件夹写操作");
  const result = await archiveWrite(api, "folders", command, signal);
  if (command.operation === "delete") return parseFolderImpact(result);
  if (command.operation === "add" || command.operation === "remove") {
    const r = record(result, "folder members");
    if (
      r.folder_id !== command.request.folder_id ||
      !Number.isSafeInteger(r.changed) ||
      Number(r.changed) < 0 ||
      Number(r.changed) > command.request.literature_ids.length
    )
      throw new Error("文件夹成员回执无效");
    return { folder_id: command.request.folder_id, changed: Number(r.changed) };
  }
  return parseFolderNode(result);
}
/** Call once on intentional reading navigation, never as part of a query function. */
export async function recordReadingOpen(
  api: ApiClient,
  literature_id: string,
  signal?: AbortSignal,
) {
  const r = record(
    await archiveWrite(
      api,
      "reading-open",
      parseReadingOpen({ literature_id }),
      signal,
    ),
    "reading history",
  );
  if (
    r.literature_id !== literature_id ||
    !Number.isSafeInteger(r.open_count) ||
    Number(r.open_count) < 1
  )
    throw new Error("阅读记录回执无效");
  return {
    literature_id,
    last_opened_at: parseUtcTimestamp(r.last_opened_at),
    open_count: Number(r.open_count),
  };
}
