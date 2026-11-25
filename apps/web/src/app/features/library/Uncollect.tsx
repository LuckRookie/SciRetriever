import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, useToast } from "../../components/index.js";
import { useApi, invalidateMaterials } from "../../data/query.js";
import { uncollectLiteratures } from "../../data/library.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";

/** What leaves the library: the papers and how to name them in a sentence. */
export interface LibraryRemovalRequest {
  ids: readonly string[];
  /** “《题名》” for one paper, “已选的 12 篇文献” for several. */
  label: string;
}
/**
 * “移出文献库” (ADR 0067 section 5): the papers become candidates again. It is
 * always confirmed, as their folders are not given back when they return.
 */
export function useLibraryRemoval(
  onRemoved?: (ids: readonly string[]) => void,
) {
  const api = useApi(),
    shell = useShell(),
    toast = useToast(),
    queries = useQueryClient();
  const [pending, setPending] = useState<LibraryRemovalRequest | null>(null);
  const remove = useMutation({
    mutationFn: ({ ids }: LibraryRemovalRequest) =>
      uncollectLiteratures(api, ids),
    onSuccess: (removed, { ids, label }) => {
      setPending(null);
      shell.setSelected(new Set());
      onRemoved?.(ids);
      invalidateMaterials(queries);
      toast({
        message:
          ids.length === 1
            ? `已把${label}移出文献库`
            : `已把 ${removed.toLocaleString()} 篇移出文献库`,
        replace: "library-uncollect",
      });
    },
  });
  const request = useCallback(
    (target: LibraryRemovalRequest) => {
      if (!target.ids.length) return;
      remove.reset();
      setPending(target);
    },
    [remove],
  );
  const dialog = (
    <ConfirmDialog
      title="移出文献库"
      isOpen={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      confirmLabel="移出"
      isPending={remove.isPending}
      {...(remove.isError && pending
        ? { errorMessage: errorMessage(remove.error) }
        : {})}
      description={
        <>
          <p>将把{pending?.label}移出文献库。</p>
          <p>
            它们回到候选：不再列在文献库和文件夹里，仍然能搜索到，书目、PDF、全文、批注和标签都保留。以后再加入文献库时，原来所在的文件夹不会恢复。
          </p>
        </>
      }
      onConfirm={() => {
        if (pending) remove.mutate(pending);
      }}
    />
  );
  return { request, dialog };
}
