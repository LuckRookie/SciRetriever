import { copyText } from "../../../browser-platform.js";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  ErrorNotice,
  SegmentedControl,
  Skeleton,
  TextArea,
} from "../../components/index.js";
import { archiveQuery, archiveWrite, rows } from "../../data/archive.js";
import { useApi, invalidateMaterials } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { registerNavigationGuard } from "../../data/url.js";
import { errorMessage } from "../../strings.js";
import { markdown } from "../../../reading/markdown.js";

interface EditorText {
  proofread: string;
  pages: string[];
}
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
  const read = async (
    version: string | null,
    signal?: AbortSignal,
  ): Promise<EditorText> => {
    let start = 0,
      proofread: string | null = version,
      total = 0,
      pageCount = 0,
      text = "";
    const ranges: Record<string, unknown>[] = [];
    do {
      const chunk = record(
        await archiveQuery(
          api,
          "proofread-text",
          { asset_id: asset, proofread_id: proofread, start, max_bytes: 65536 },
          signal,
        ),
        "editor text",
      );
      if (
        chunk.asset_id !== asset ||
        typeof chunk.proofread_id !== "string" ||
        (proofread && proofread !== chunk.proofread_id) ||
        chunk.start !== start ||
        typeof chunk.text !== "string" ||
        typeof chunk.end !== "number" ||
        chunk.end < start ||
        new TextEncoder().encode(chunk.text).length !== chunk.end - start ||
        Number(chunk.total_bytes) > 8 * 1024 * 1024
      )
        throw new Error("校订稿分块不一致，请重新读取。");
      proofread = chunk.proofread_id;
      text += chunk.text;
      total = Number(chunk.total_bytes);
      pageCount = Number(chunk.page_count);
      ranges.push(...rows(chunk, "ranges"));
      if (
        chunk.next_start !== null &&
        (chunk.next_start !== chunk.end || chunk.end === start)
      )
        throw new Error("校订稿续读位置无效。");
      start = chunk.end;
      if (chunk.next_start === null) break;
    } while (start < total);
    const bytes = new TextEncoder().encode(text);
    if (
      bytes.length !== total ||
      !proofread ||
      !Number.isSafeInteger(pageCount) ||
      pageCount < 1 ||
      pageCount > 10000
    )
      throw new Error("校订稿未完整读取。");
    const pages = Array.from({ length: pageCount }, () => "");
    for (const r of ranges) {
      const n = Number(r.page),
        from = Number(r.start_utf8),
        to = Number(r.end_utf8);
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        n >= pageCount ||
        from < 0 ||
        to > bytes.length ||
        to < from
      )
        throw new Error("校订稿页定位无效。");
      pages[n] += new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.slice(from, to),
      );
    }
    if (!ranges.length && !text.trim()) pages[0] = text;
    if (pages.join("") !== text)
      throw new Error("校订稿页内容不完整，未打开编辑。");
    return { proofread, pages };
  };
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
      unregister();
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
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
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const pages = draft.pages.map((t) =>
          t.trimEnd() ? t.trimEnd() + "\n\n" : "",
        ),
        starts: number[] = [];
      let offset = 0;
      for (const text of pages) {
        starts.push(offset);
        offset += new TextEncoder().encode(text).length;
      }
      if (offset > 8 * 1024 * 1024)
        throw new Error("校订稿超过单份文档大小限制，请缩减后保存。");
      const response = record(
        await archiveWrite(api, "proofread-save", {
          literature_id: id,
          asset_id: asset,
          proofread_id: draft.proofread,
          markdown: pages.join(""),
          page_starts_utf8: starts,
          actor: api.actor,
        }),
        "saved proofreading",
      );
      if (response.saved !== true || typeof response.proofread_id !== "string")
        throw new Error("没有收到校订保存确认，草稿仍保留。");
      setDraft({ ...draft, proofread: response.proofread_id, pages });
      setDirty(false);
      try {
        setDraft(await read(response.proofread_id));
      } catch (error) {
        setFailure(`修订已保存，但重新读取未完成：${errorMessage(error)}`);
      }
      const rebuilt = record(response.rebuild, "rebuild");
      setMessage(
        rebuilt.status === "failed"
          ? "修订已保存；全文重建尚未完成，可从单步处理继续。"
          : response.changed
            ? "修订已保存，全文、结构与引用已重建。"
            : "内容没有变化。",
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
  return (
    <section className="proofread-editor" aria-label="校订稿编辑">
      <header className="proofread-editor-header">
        <h2>校订稿</h2>
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
          <Button
            variant="primary"
            isPending={busy}
            isDisabled={!dirty || !api.workspace.capabilities.maintenance}
            onPress={() => void save()}
          >
            保存修订
          </Button>
        </div>
        <p className="ui-description">
          保存后，读取这篇的算子结果会标为过时。保存与重建不调用模型。
        </p>
        {message ? <p role="status">{message}</p> : null}
        {failure || data.error ? (
          <>
            <ErrorNotice message={failure || errorMessage(data.error)} />
            {dirty && draft ? (
              <Button
                onPress={() => {
                  void copyText(draft.pages.join("\n\n"))
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
          <Skeleton label="正在完整读取校订稿" />
        ) : null}
        {draft?.pages.map((text, index) => (
          <section
            key={index}
            data-edit-page={index + 1}
            className="proofread-editor-page"
          >
            <h3>第 {index + 1} 页</h3>
            {preview ? (
              <div
                className="reader-prose"
                dangerouslySetInnerHTML={{ __html: markdown.parse(text) }}
              />
            ) : (
              <div onFocus={() => onPage(index + 1)}>
                <TextArea
                  label={`第 ${index + 1} 页校订稿`}
                  value={text}
                  onChange={(value) => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            pages: current.pages.map((t, i) =>
                              i === index ? value : t,
                            ),
                          }
                        : current,
                    );
                    setDirty(true);
                    setMessage("");
                  }}
                  isDisabled={busy}
                />
              </div>
            )}
          </section>
        ))}
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
