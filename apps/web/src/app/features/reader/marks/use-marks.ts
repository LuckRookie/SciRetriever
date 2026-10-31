import { useCallback, useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  markTags,
  parseReadingMark,
  sortMarks,
  type MarkColor,
  type MarkDocumentAnchor,
  type MarkKind,
  type MarkPdfAnchor,
  type ReadingMark,
} from "@sciretriever/contracts";
import { archiveQuery, archiveWrite } from "../../../data/archive.js";
import { useApi } from "../../../data/query.js";
import { record } from "../../../data/wire.js";

export interface MarkDraft {
  readonly kind: MarkKind;
  readonly color: MarkColor;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly pdf: MarkPdfAnchor | null;
  readonly document: MarkDocumentAnchor | null;
  readonly note?: string;
}
export interface MarkPatch {
  readonly color?: MarkColor;
  readonly note?: string;
  readonly pdf?: MarkPdfAnchor;
  readonly document?: MarkDocumentAnchor;
}
type Command =
  | { operation: "create"; mark: ReadingMark }
  | { operation: "update"; id: string; patch: MarkPatch }
  | { operation: "delete" | "restore"; id: string };

/**
 * One paper's marks (ADR 0046). Changes show at once and are saved behind
 * them; a failed save puts the list back and says so.
 */
// One empty list while marks load: effects keyed on the list must not rerun every render.
const NO_MARKS: readonly ReadingMark[] = [];
export function useMarks(
  literatureId: string,
  enabled: boolean,
  notify: (message: string) => void,
) {
  const api = useApi(),
    queries = useQueryClient();
  const key: QueryKey = useMemo(() => ["marks", literatureId], [literatureId]);
  const list = useQuery({
    queryKey: key,
    enabled: enabled && !!literatureId,
    queryFn: async ({ signal }) => {
      const value = record(
        await archiveQuery(
          api,
          "marks",
          { operation: "list", request: { literature_id: literatureId } },
          signal,
        ),
        "marks",
      );
      if (!Array.isArray(value.items)) throw new Error("批注回执无效");
      return value.items.map(parseReadingMark);
    },
  });
  const apply = (marks: readonly ReadingMark[], command: Command) => {
    if (command.operation === "create")
      return sortMarks([...marks, command.mark]);
    return marks.flatMap((m) => {
      if (m.mark_id !== command.id) return [m];
      if (command.operation !== "update")
        return command.operation === "delete" ? [] : [m];
      const note = command.patch.note ?? m.note;
      return [{ ...m, ...command.patch, note, tags: markTags(note) }];
    });
  };
  const write = useMutation({
    mutationFn: async (command: Command) => {
      const request =
        command.operation === "create"
          ? {
              literature_id: literatureId,
              mark_id: command.mark.mark_id,
              kind: command.mark.kind,
              color: command.mark.color,
              note: command.mark.note,
              quote: command.mark.quote,
              quote_prefix: command.mark.quote_prefix,
              quote_suffix: command.mark.quote_suffix,
              pdf: command.mark.pdf,
              document: command.mark.document,
            }
          : command.operation === "update"
            ? { mark_id: command.id, ...command.patch }
            : { mark_id: command.id };
      return parseReadingMark(
        await archiveWrite(api, "marks", {
          operation: command.operation,
          request,
        }),
      );
    },
    onMutate: async (command) => {
      await queries.cancelQueries({ queryKey: key });
      const before = queries.getQueryData<readonly ReadingMark[]>(key);
      if (before && command.operation !== "restore")
        queries.setQueryData(key, apply(before, command));
      return { before };
    },
    onError: (_error, _command, context) => {
      if (context?.before) queries.setQueryData(key, context.before);
      notify("批注没有保存，已恢复到之前的状态。");
    },
    onSuccess: (saved, command) => {
      queries.setQueryData<readonly ReadingMark[]>(key, (marks = []) =>
        saved.deleted_at
          ? marks.filter((m) => m.mark_id !== saved.mark_id)
          : sortMarks([
              ...marks.filter((m) => m.mark_id !== saved.mark_id),
              saved,
            ]),
      );
      if (command.operation === "restore") void list.refetch();
    },
  });
  const create = useCallback(
    (draft: MarkDraft): ReadingMark => {
      const now = new Date().toISOString(),
        note = draft.note ?? "";
      const mark: ReadingMark = {
        mark_id: crypto.randomUUID(),
        literature_id: literatureId,
        kind: draft.kind,
        color: draft.color,
        note,
        tags: markTags(note),
        quote: draft.quote,
        quote_prefix: draft.prefix.slice(-200),
        quote_suffix: draft.suffix.slice(0, 200),
        pdf: draft.pdf,
        document: draft.document,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      write.mutate({ operation: "create", mark });
      return mark;
    },
    [literatureId, write],
  );
  return {
    marks: list.data ?? NO_MARKS,
    ready: list.isSuccess,
    saving: write.isPending,
    create,
    update: (id: string, patch: MarkPatch) =>
      write.mutate({ operation: "update", id, patch }),
    remove: (id: string) => write.mutate({ operation: "delete", id }),
    restore: (id: string) => write.mutate({ operation: "restore", id }),
    exportText: async (format: "markdown" | "json") =>
      String(
        record(
          await archiveQuery(api, "marks", {
            operation: "export",
            request: { literature_id: literatureId, format },
          }),
          "marks export",
        ).content,
      ),
  };
}
