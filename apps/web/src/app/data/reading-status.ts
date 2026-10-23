import { parseReadingStatus } from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { archiveQuery } from "./archive.js";
export async function readReadingStatus(
  api: ApiClient,
  asset_id: string,
  signal?: AbortSignal,
) {
  return parseReadingStatus(
    await archiveQuery(api, "reading-status", { asset_id }, signal),
  );
}
export { parseReadingStatus };
