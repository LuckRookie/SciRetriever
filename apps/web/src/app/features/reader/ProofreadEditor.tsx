import { randomId } from "../../../browser-platform.js";
import { copyText } from "../../../browser-platform.js";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  ErrorNotice,
  SegmentedControl,
  Skeleton,
  Switch,
  TextArea,
} from "../../components/index.js";
import { archiveWrite } from "../../data/archive.js";
import { useApi, invalidateMaterials } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { registerNavigationGuard } from "../../data/url.js";
import { errorMessage } from "../../strings.js";
import { markdown } from "../../../reading/markdown.js";
import { readProofreadText, type EditorText } from "./proofread-text.js";
import { unsavedPapers } from "../../shell/paper-tabs.js";
import {
  DroppedLeaves,
  readDroppedLeaves,
  type DroppedLeaf,
} from "./dropped-leaves.js";

const MAPPING_CONFLICT =
  "这处修改对应不到原文区块，没有保存。这里只能改已有段落里的文字；新增段落、调整顺序或改章节标题，请撤回这处修改。草稿仍保留。";
export function ProofreadEditor({
  id,
  asset,
  page,
  onPage,
}: {
  id: string;
  asset: string;
  page: number;
  onPage: (page: number) => void;
}) {
  const api = useApi(),
    queries = useQueryClient(),
    scroll = useRef<HTMLDivElement>(null),
    scrolling = useRef(false);
  const [draft, setDraft] = useState<EditorText | null>(null),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState(""),
    [leave, setLeave] = useState(false);
  const decision = useRef<((allowed: boolean) => void) | null>(null);
  const read = (version: string | null, signal?: AbortSignal) =>
    readProofreadText(api, asset, version, signal);
  const [showDropped, setShowDropped] = useState(false),
    [pendingPages, setPendingPages] = useState<number[]>([]);
  const data = useQuery({
    queryKey: ["document", "editor", asset],
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => read(null, signal),
  });
  useEffect(() => {
    if (data.data && !draft) setDraft(data.data);
  }, [data.data, draft]);
  useEffect(() => {
    if (!dirty) return;
    // A batch close of tabs leaves this one open (reading-experience 1.8.3).
    unsavedPapers.add(id);
    const unregister = registerNavigationGuard(
      () =>
        new Promise((resolve) => {
          decision.current = resolve;
          setLeave(true);
        }),
    );
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      unsavedPapers.delete(id);
      unregister();
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty, id]);
  useEffect(
    () => () => {
      decision.current?.(false);
      decision.current = null;
    },
    [],
  );
  useEffect(() => {
    const root = scroll.current,
      section = root?.querySelector<HTMLElement>(`[data-edit-page="${page}"]`);
    if (!root || !section || root.contains(document.activeElement)) return;
    scrolling.current = true;
    root.scrollTop +=
      section.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const frame = requestAnimationFrame(() => {
      scrolling.current = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      scrolling.current = false;
    };
  }, [page, draft?.proofread]);
  const editable =
    draft?.format === "arranged-v2" && api.workspace.capabilities.maintenance;
  const dropped = useQuery({
    queryKey: ["document", "dropped", asset, draft?.proofread],
    enabled: showDropped && draft?.format === "arranged-v2",
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      readDroppedLeaves(api, asset, draft!.proofread, signal),
  });
  const droppedByPage = new Map<number, DroppedLeaf[]>();
  for (const leaf of dropped.data ?? [])
    droppedByPage.set(leaf.page, [
      ...(droppedByPage.get(leaf.page) ?? []),
      leaf,
    ]);
  const reload = async (proofread: string, saved: string) => {
    try {
      setDraft(await read(proofread));
    } catch (error) {
      setFailure(`${saved}，但重新读取未完成：${errorMessage(error)}`);
    }
    invalidateMaterials(queries);
  };
  const save = async () => {
    if (!draft || busy || !editable) return;
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const text = draft.segments.map((s) => s.text).join("");
      if (new TextEncoder().encode(text).length > 8 * 1024 * 1024)
        throw new Error("全文超过单份文档大小限制，请缩减后保存。");
      const response = record(
        await archiveWrite(api, "proofread-save", {
          schema_version: 2,
          literature_id: id,
          asset_id: asset,
          proofread_id: draft.proofread,
          expected_arrangement_id: draft.arrangement,
          expected_manual_revision: draft.manualRevision,
          markdown: text,
        }),
        "saved proofreading",
      );
      if (response.saved === false && response.conflict) {
        setFailure(MAPPING_CONFLICT);
        return;
      }
      if (response.saved !== true || typeof response.proofread_id !== "string")
        throw new Error("没有收到校订保存确认，草稿仍保留。");
      setDirty(false);
      const rebuilt = record(response.rebuild, "rebuild");
      setMessage(
        !response.changed
          ? "内容没有变化。"
          : rebuilt.status === "failed"
            ? "修订已保存；全文没有重新生成，可从“单步处理”发布全文。"
            : "修订已保存，全文已重新生成。",
      );
      await reload(response.proofread_id, "修订已保存");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (leaf: DroppedLeaf) => {
    if (!draft || busy || dirty || !editable) return;
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const response = record(
        await archiveWrite(api, "archive-arrangement-edit", {
          schema_version: 2,
          literature_id: id,
          asset_id: asset,
          expected_proofread_id: draft.proofread,
          expected_arrangement_id: draft.arrangement,
          expected_manual_revision: draft.manualRevision,
          changes: [
            {
              kind: "restore",
              leaf_id: leaf.leafId,
              target: leaf.target,
              presentation: { kind: "content" },
            },
          ],
        }),
        "restored leaf",
      );
      if (typeof response.proofread_id !== "string")
        throw new Error("没有收到恢复确认。");
      const pending = Array.isArray(response.pending_page_indexes)
        ? response.pending_page_indexes.map(Number)
        : [];
      setPendingPages(pending);
      const rebuilt = record(response.rebuild, "rebuild");
      setMessage(
        pending.length
          ? `已恢复并锁定。第 ${pending.map((p) => p + 1).join("、")} 页要重新校订，之后才会出现在全文里。`
          : rebuilt.status === "failed"
            ? "已恢复并锁定；全文没有重新生成，可从“单步处理”发布全文。"
            : "已恢复并锁定，全文已重新生成。",
      );
      await reload(response.proofread_id, "已恢复");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const continueProofread = async () => {
    setBusy(true);
    setFailure("");
    try {
      await archiveWrite(api, "archive", {
        operation: "build",
        request: {
          schema_version: 2,
          selector: { kind: "literatures", literature_ids: [id] },
          mode: "full",
          from_step: "proofread",
          idempotency_key: randomId(),
        },
      });
      setPendingPages([]);
      setMessage(
        "已提交解析全文的任务：只重新校订待处理的页，其余页复用。进度见任务。",
      );
      invalidateMaterials(queries);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const decide = (allow: boolean) => {
    setLeave(false);
    decision.current?.(allow);
    decision.current = null;
  };
  const restoreBlocked = busy
    ? "正在保存"
    : dirty
      ? "先保存或放弃当前修订，再恢复已删除的内容。"
      : !editable
        ? "这份全文不能在这里修改。"
        : null;
  const shownPages = new Set<number>();
  return (
    <section className="proofread-editor" aria-label="修改全文">
      <header className="proofread-editor-header">
        <h2>修改全文</h2>
        <div className="form-actions">
          <SegmentedControl
            label="校订显示"
            value={preview ? "preview" : "edit"}
            onChange={(v) => setPreview(v === "preview")}
            items={[
              { id: "edit", label: "编辑" },
              { id: "preview", label: "预览" },
            ]}
          />
          {draft?.format === "arranged-v2" ? (
            <Switch isSelected={showDropped} onChange={setShowDropped}>
              显示已删除
            </Switch>
          ) : null}
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={!dirty || !editable}
            onPress={() => void save()}
          >
            保存修订
          </Button>
        </div>
        <p className="ui-description">
          {draft?.format === "legacy-v1"
            ? "这份全文来自旧的流程，只能阅读。重新解析全文后可以在这里修改。"
            : "只能改已有段落里的文字。保存后，读取这篇的算子结果会标为过时；保存与重新解析全文不调用模型。"}
        </p>
        {message ? <p role="status">{message}</p> : null}
        {pendingPages.length ? (
          <Button
            isPending={busy}
            isDisabled={!api.workspace.capabilities.maintenance}
            onPress={() => void continueProofread()}
          >
            重新校订 {pendingPages.length} 页（调用模型）
          </Button>
        ) : null}
        {showDropped && dropped.error ? (
          <ErrorNotice message={errorMessage(dropped.error)} />
        ) : null}
        {failure || data.error ? (
          <>
            <ErrorNotice message={failure || errorMessage(data.error)} />
            {dirty && draft ? (
              <Button
                onPress={() => {
                  void copyText(draft.segments.map((s) => s.text).join(""))
                    .then(() => setMessage("当前草稿已复制。"))
                    .catch(() =>
                      setMessage(
                        "浏览器未允许复制，请选中编辑区内容手动复制。",
                      ),
                    );
                }}
              >
                复制当前草稿
              </Button>
            ) : null}
          </>
        ) : null}
      </header>
      <div
        className="proofread-editor-scroll"
        ref={scroll}
        onScroll={() => {
          if (scrolling.current) return;
          const root = scroll.current!;
          const top = root.getBoundingClientRect().top;
          const sections = [
            ...root.querySelectorAll<HTMLElement>("[data-edit-page]"),
          ];
          const current = sections.find(
            (s) => s.getBoundingClientRect().bottom > top + 40,
          );
          if (current) {
            const n = Number(current.dataset.editPage);
            if (n !== page) onPage(n);
          }
        }}
      >
        {!draft && data.isPending ? (
          <Skeleton label="正在完整读取全文" />
        ) : null}
        {showDropped && dropped.isPending ? (
          <Skeleton label="正在读取已删除的内容" />
        ) : null}
        {draft
          ? pageOrder(draft, droppedByPage).map(({ index, pageIndex }) => {
              const segment = index === null ? null : draft.segments[index]!,
                first = !shownPages.has(pageIndex);
              shownPages.add(pageIndex);
              const label = `第 ${pageIndex + 1} 页${segment?.repeat ? `（续 ${segment.repeat}）` : ""}`;
              return (
                <section
                  key={
                    index === null ? `dropped-${pageIndex}` : `segment-${index}`
                  }
                  data-edit-page={pageIndex + 1}
                  className="proofread-editor-page"
                >
                  <h3>{label}</h3>
                  {segment === null ? null : preview ? (
                    <div
                      className="reader-prose"
                      dangerouslySetInnerHTML={{
                        __html: markdown.parse(segment.text),
                      }}
                    />
                  ) : (
                    <div onFocus={() => onPage(pageIndex + 1)}>
                      <TextArea
                        label={`${label}全文`}
                        width="full"
                        value={segment.text}
                        onChange={(value) => {
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  segments: current.segments.map((s, i) =>
                                    i === index ? { ...s, text: value } : s,
                                  ),
                                }
                              : current,
                          );
                          setDirty(true);
                          setMessage("");
                        }}
                        isDisabled={busy || !editable}
                      />
                    </div>
                  )}
                  {showDropped && first ? (
                    <DroppedLeaves
                      leaves={droppedByPage.get(pageIndex) ?? []}
                      disabled={restoreBlocked}
                      onRestore={(leaf) => void restore(leaf)}
                    />
                  ) : null}
                </section>
              );
            })
          : null}
        {showDropped && dropped.data && !dropped.data.length ? (
          <p className="ui-description">这份全文没有删除任何内容。</p>
        ) : null}
      </div>
      <Dialog
        title="保留未保存的校订？"
        isOpen={leave}
        onOpenChange={(open) => {
          if (!open) decide(false);
        }}
        footer={
          <>
            <Button onPress={() => decide(false)}>继续编辑</Button>
            <Button onPress={() => decide(true)}>放弃草稿并离开</Button>
          </>
        }
      >
        <p>当前修订还没有保存。离开后这些改动会丢失。</p>
      </Dialog>
    </section>
  );
}

/** Segments in text order, with pages that only hold dropped content slotted in by page number. */
function pageOrder(
  draft: EditorText,
  dropped: ReadonlyMap<number, readonly DroppedLeaf[]>,
): { index: number | null; pageIndex: number }[] {
  const order: { index: number | null; pageIndex: number }[] =
    draft.segments.map((s, index) => ({ index, pageIndex: s.page }));
  const present = new Set(draft.segments.map((s) => s.page));
  for (const pageIndex of [...dropped.keys()].sort((a, b) => a - b)) {
    if (present.has(pageIndex)) continue;
    const at = order.findIndex((o) => o.pageIndex > pageIndex);
    order.splice(at < 0 ? order.length : at, 0, { index: null, pageIndex });
  }
  return order;
}
