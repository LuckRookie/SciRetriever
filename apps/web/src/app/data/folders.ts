import {
  parseFolderOperation,
  parseFolderNode,
  parseFolderImpact,
  parseReadingOpen,
  parseUtcTimestamp,
} from "@sciretriever/contracts";
import { ApiError, type ApiClient } from "./api.js";
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
/**
 * The whole folder tree and its members as one file (user organization 9.5):
 * the service writes it from one read-only snapshot and streams it; the page
 * only takes the bytes to save, nothing is built or written here.
 */
export async function exportFolders(api: ApiClient): Promise<Blob> {
  const response = await api.fetch("/api/v1/query/folders-export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sciretriever-Protocol-Version": "1",
    },
    body: JSON.stringify({ protocol_version: 1, request: {} }),
  });
  if (!response.ok) {
    // The service's own failure when it sent one; its status otherwise.
    const failure = await api.json(response).then(
      () => null,
      (error: unknown) => error,
    );
    throw failure instanceof ApiError
      ? failure
      : new Error(`服务没有给出文件（HTTP ${response.status}）。`);
  }
  // A stream cut short rejects here, so a partial file is never saved.
  return response.blob();
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
      Number(r.changed) > command.request.literature_ids.length ||
      !Array.isArray(r.changed_ids) ||
      r.changed_ids.length !== Number(r.changed) ||
      !r.changed_ids.every((id) => typeof id === "string")
    )
      throw new Error("文件夹成员回执无效");
    return {
      folder_id: command.request.folder_id,
      changed: Number(r.changed),
      changed_ids: r.changed_ids as string[],
    };
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
