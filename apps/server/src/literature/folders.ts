import { randomUUID } from "node:crypto";
import {
  parseFolderOperation,
  parseReadingOpen,
  parseFolderExportRequest,
  parseFolderExportNode,
  parseFolderExportPage,
  parseAssetId,
  parseLiteratureId,
  parseUtcTimestamp,
  encodeCursor,
  decodeCursor,
  FOLDERS_EXPORT_FORMAT,
  type FolderExportRequest,
  type FolderExportMember,
  type FolderExportPage,
  type LiteratureBibliographySummary,
  tagRecord,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { LiteratureQueryService } from "./query.js";
import type { FolderExportStoragePage } from "../storage/sqlite/folder-engine.js";
import { activityContext } from "../logging/activity.js";

export class FolderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** User grouping and explicit reading history; never modifies literature facts. */
export class FolderService {
  constructor(private readonly database: SqliteWorker) {}
  query(value: unknown, signal?: AbortSignal) {
    const command = parseFolderOperation(value);
    if (command.operation === "export")
      return this.exportPage(command.request, signal);
    if (command.operation !== "list" && command.operation !== "delete-preview")
      throw new FolderError("folder-read-operation-invalid");
    return this.database.folders(command, signal);
  }
  manage(value: unknown, signal?: AbortSignal, intakeBatchId?: string) {
    const command = parseFolderOperation(value);
    if (
      command.operation === "list" ||
      command.operation === "delete-preview" ||
      command.operation === "export"
    )
      throw new FolderError("folder-write-operation-invalid");
    return this.database.folders(
      {
        ...command,
        actor: activityContext().actor,
        ...(intakeBatchId
          ? { intake_batch_id: parseAssetId(intakeBatchId) }
          : {}),
        now: new Date().toISOString(),
        ...(command.operation === "create" ? { folder_id: randomUUID() } : {}),
      },
      signal,
    );
  }
  private async members(
    reader: SqliteWorker,
    ids: FolderExportStoragePage["members"],
    signal?: AbortSignal,
  ): Promise<FolderExportMember[]> {
    const books = await new LiteratureQueryService(reader).bibliographies(
      ids.map((row) => row.literature_id),
      signal,
    );
    const byId = new Map<string, LiteratureBibliographySummary>(
      books.map((book) => [book.literature_id, book]),
    );
    return ids.map((row) => {
      const book = byId.get(row.literature_id);
      if (!book) throw new FolderError("folder-export-literature-missing");
      return {
        folder_id: parseAssetId(row.folder_id),
        ...book,
        identifiers: book.identifiers.filter((id) =>
          ["doi", "arxiv", "pmid", "pmcid"].includes(id.namespace),
        ),
      };
    });
  }
  private async exportPage(
    value: FolderExportRequest,
    signal?: AbortSignal,
  ): Promise<FolderExportPage> {
    const request = parseFolderExportRequest(value);
    let after: readonly [string, string] | null = null,
      exported_at = new Date().toISOString();
    if (request.cursor !== null) {
      const r = tagRecord(await decodeCursor(request.cursor, "folder-export"), [
        "after",
        "exported_at",
      ]);
      if (!Array.isArray(r.after) || r.after.length !== 2)
        throw new FolderError("folder-export-cursor-invalid");
      after = [parseAssetId(r.after[0]), parseLiteratureId(r.after[1])];
      exported_at = parseUtcTimestamp(r.exported_at);
    }
    return this.database.withReadSnapshot(async (reader) => {
      const raw = (await reader.folders(
        {
          operation: "export",
          request,
          export_after: after,
          export_include_tree: after === null,
        },
        signal,
      )) as FolderExportStoragePage;
      const members = await this.members(reader, raw.members, signal),
        last = members.at(-1);
      return parseFolderExportPage({
        format: FOLDERS_EXPORT_FORMAT,
        version: 1,
        exported_at,
        folders: raw.folders,
        members,
        next_cursor:
          raw.more && last
            ? await encodeCursor("folder-export", {
                after: [last.folder_id, last.literature_id],
                exported_at,
              })
            : null,
      });
    }, signal);
  }
  /** Hold one read snapshot through the consumer, including HTTP backpressure. */
  withExportFile<T>(
    value: unknown,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    tagRecord(value, []);
    return this.database.withReadSnapshot(async (reader) => {
      const raw = (await reader.folders(
        {
          operation: "export",
          request: { cursor: null, limit: 128 },
          export_tree_only: true,
          export_include_tree: true,
        },
        signal,
      )) as FolderExportStoragePage;
      const folders = raw.folders!.map(parseFolderExportNode),
        exported_at = new Date().toISOString();
      const readMembers = (ids: FolderExportStoragePage["members"]) =>
        this.members(reader, ids, signal);
      async function* chunks() {
        const encoder = new TextEncoder();
        const encode = (value: string) => encoder.encode(value);
        yield encode(
          `{"format":"${FOLDERS_EXPORT_FORMAT}","version":1,"exported_at":${JSON.stringify(exported_at)},"folders":[`,
        );
        for (const [index, folder] of folders.entries()) {
          signal?.throwIfAborted();
          yield encode(
            (index ? "," : "") +
              JSON.stringify(folder).slice(0, -1) +
              ',"members":[',
          );
          let after: readonly [string, string] | null = null,
            first = true;
          for (;;) {
            signal?.throwIfAborted();
            const page = (await reader.folders(
              {
                operation: "export",
                request: { cursor: null, limit: 128 },
                export_after: after,
                export_folder_id: folder.folder_id,
              },
              signal,
            )) as FolderExportStoragePage;
            const members = await readMembers(page.members);
            for (const member of members) {
              const { folder_id: _, ...book } = member;
              void _;
              yield encode((first ? "" : ",") + JSON.stringify(book));
              first = false;
            }
            if (!page.more) break;
            const last = page.members.at(-1)!;
            after = [last.folder_id, last.literature_id];
          }
          yield encode("]}");
        }
        yield encode("]}");
      }
      return consume(chunks());
    }, signal);
  }
  opened(value: unknown, signal?: AbortSignal) {
    return this.database.folders(
      {
        operation: "opened",
        request: parseReadingOpen(value),
        now: new Date().toISOString(),
      },
      signal,
    );
  }
}
