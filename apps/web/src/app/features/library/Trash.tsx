import { useCallback, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Icon,
  useToast,
} from "../../components/index.js";
import { useApi, invalidateMaterials } from "../../data/query.js";
import {
  listTrash,
  trashLiteratures,
  useTrashCount,
} from "../../data/library-trash.js";
import { useShell } from "../../shell/context.js";
import { errorMessage, localTime, shortTime } from "../../strings.js";

/** What is being deleted: the papers and how to name them in a sentence. */
export interface DeletionRequest {
  ids: readonly string[];
  /** “《题名》” for one paper, “已选的 12 篇文献” for several. */
  label: string;
}
/**
 * Deleting moves papers to 最近删除; nothing is erased. One paper goes at
 * once, with 撤销 in the notice. Several are confirmed first (`pending`), as
 * a slip there costs more to notice.
 */
export function useDeletion() {
  const api = useApi(),
    shell = useShell(),
    toast = useToast(),
    queries = useQueryClient();
  const [pending, setPending] = useState<DeletionRequest | null>(null);
  const refresh = useCallback(() => invalidateMaterials(queries), [queries]);
  const remove = useMutation({
    mutationFn: async ({ ids }: DeletionRequest) => {
      const changed = await trashLiteratures(api, "delete", ids);
      return { ids, changed };
    },
    onSuccess: ({ ids, changed }, { label }) => {
      setPending(null);
      // Their tabs close with them: a deleted paper cannot be read.
      for (const id of ids)
        if (shell.tabs.list.some((tab) => tab.id === id))
          shell.tabs.close("one", id);
      shell.setSelected(new Set());
      refresh();
      toast({
        message:
          ids.length === 1
            ? `已删除${label}，可在“最近删除”里恢复`
            : `已删除 ${changed.toLocaleString()} 篇，可在“最近删除”里恢复`,
        replace: "library-trash",
        action: {
          label: "撤销",
          onPress: () =>
            void trashLiteratures(api, "restore", ids)
              .then((restored) => {
                refresh();
                toast(`已恢复 ${restored.toLocaleString()} 篇`);
              })
              .catch((error: unknown) => toast(errorMessage(error))),
        },
      });
    },
    onError: (error) => {
      // One paper has no dialog to carry the failure; several do.
      if (!pending) toast(`没有删除。${errorMessage(error)}`);
    },
  });
  const request = useCallback(
    (target: DeletionRequest) => {
      if (!target.ids.length) return;
      if (target.ids.length === 1) remove.mutate(target);
      else {
        remove.reset();
        setPending(target);
      }
    },
    [remove],
  );
  const dialog = (
    <ConfirmDialog
      title="删除文献"
      isOpen={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      confirmLabel="删除"
      isPending={remove.isPending}
      {...(remove.isError && pending
        ? { errorMessage: errorMessage(remove.error) }
        : {})}
      description={
        <>
          <p>将删除{pending?.label}。</p>
          <p>
            它们会从文献库、文件夹和搜索结果里移走，放进“最近删除”；书目、PDF、全文和批注都保留，可以在那里恢复。
          </p>
        </>
      }
      onConfirm={() => {
        if (pending) remove.mutate(pending);
      }}
    />
  );
  return { request, dialog, isPending: remove.isPending };
}
/**
 * The sidebar's way into 最近删除, under the folders; shown only while it
 * holds something, so an untouched library carries no empty bin.
 */
export function TrashEntry() {
  const count = useTrashCount();
  const [open, setOpen] = useState(false);
  if (!count.data && !open) return null;
  return (
    <>
      <Button
        variant="text"
        className="folder-open folder-trash"
        icon={<Icon name="trash" />}
        onPress={() => setOpen(true)}
      >
        <span className="folder-name">最近删除</span>
        <span className="navigation-count">
          {count.data?.toLocaleString() ?? ""}
        </span>
      </Button>
      {open ? <TrashDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
function TrashDialog({ onClose }: { onClose: () => void }) {
  const api = useApi(),
    toast = useToast(),
    queries = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: ["library", "trash", "list"],
    queryFn: ({ pageParam, signal }) => listTrash(api, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
  const restore = useMutation({
    mutationFn: (ids: readonly string[]) =>
      trashLiteratures(api, "restore", ids),
    onSuccess: (restored) => {
      invalidateMaterials(queries);
      toast(`已恢复 ${restored.toLocaleString()} 篇`);
    },
    onError: (error) => toast(`没有恢复。${errorMessage(error)}`),
  });
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Dialog
      title="最近删除"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <p>
        删除的文献放在这里，书目、PDF、全文和批注都还在。恢复后回到原来的文件夹。
      </p>
      {pages.isError ? (
        <p className="ui-error-text" role="alert">
          {errorMessage(pages.error)}
        </p>
      ) : pages.isPending ? (
        <p>正在读取…</p>
      ) : !items.length ? (
        <p>这里没有文献。</p>
      ) : (
        <ul className="trash-list">
          {items.map((item) => (
            <li key={item.literature_id}>
              <span className="trash-title">
                {item.title ?? "（没有题名）"}
                {item.year ? `（${item.year}）` : ""}
              </span>
              <time
                dateTime={item.deleted_at}
                title={localTime(item.deleted_at)}
              >
                {shortTime(item.deleted_at)} 删除
              </time>
              <Button
                isDisabled={restore.isPending}
                aria-label={`恢复：${item.title ?? item.literature_id}`}
                onPress={() => restore.mutate([item.literature_id])}
              >
                恢复
              </Button>
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage ? (
        <Button
          variant="text"
          isPending={pages.isFetchingNextPage}
          onPress={() => void pages.fetchNextPage()}
        >
          显示更多
        </Button>
      ) : null}
    </Dialog>
  );
}
