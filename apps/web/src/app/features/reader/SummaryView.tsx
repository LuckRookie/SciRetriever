import type { EvidenceRef, ProcessorCitation } from "@sciretriever/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { randomId } from "../../../browser-platform.js";
import { markdown } from "../../../reading/markdown.js";
import { sourceParameters, type FixedSource } from "../../../reading/source.js";
import type { ReadingPosition } from "../../../reading/state.js";
import {
  nextEvidencePage,
  readEvidencePage,
  type EvidencePageCursor,
} from "../../../reading/transport.js";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Popover,
  Skeleton,
  TechDetails,
} from "../../components/index.js";
import {
  readProcessorResult,
  resultReference,
} from "../../data/processor-results.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { record } from "../../data/wire.js";
import { useShell } from "../../shell/context.js";
import {
  errorMessage,
  valueCheckReason,
  valueCheckLabels,
  valueCheckBasisLabels,
} from "../../strings.js";

function readableClaim(text: string, sources: readonly ProcessorCitation[]) {
  // Verified citations already have numbered controls below the paragraph.
  // Remove only their redundant model-written markers, never arbitrary IDs.
  for (const citation of sources) {
    if (
      citation.kind === "document" &&
      citation.evidence.target_kind === "document" &&
      citation.evidence.locator.kind === "segment"
    )
      text = text.replaceAll(`【${citation.evidence.locator.segment_id}】`, "");
  }
  return text;
}

/**
 * An internal summary keeps a citation whose segment did not exist in its fixed
 * input; it has no content hash and must not open the normal segment reader.
 */
function unavailable(evidence: EvidenceRef) {
  return (
    evidence.target_kind === "document" && evidence.content_sha256 === null
  );
}
function UnavailableCitation({ label }: { label: string }) {
  return (
    <span className="reader-evidence-unavailable" title="引用片段不可用">
      {label} 引用片段不可用
    </span>
  );
}
export function EvidencePreview({
  evidence,
  index,
}: {
  evidence: EvidenceRef;
  index: number;
}) {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const result = useInfiniteQuery({
    queryKey: ["document", "evidence", evidence],
    initialPageParam: {
      continuation: null,
      expectedStart: null,
    } as EvidencePageCursor,
    retry: false,
    queryFn: ({ signal, pageParam }) =>
      readEvidencePage(
        { api, signal, root: document.body, refresh: () => {} },
        evidence,
        pageParam,
      ),
    getNextPageParam: nextEvidencePage,
  });
  const open = () => {
    const resolved = result.data?.pages[0];
    if (!resolved) return;
    const previous = Object.fromEntries(
      ["from", "result", "resultHash", "collection"].flatMap((key) =>
        route.parameters.has(key) ? [[key, route.parameters.get(key)!]] : [],
      ),
    );
    if (
      evidence.target_kind === "document" &&
      resolved.document &&
      resolved.target_range
    ) {
      const d = resolved.document;
      shell.openPaper(d.source_material_ref.literature_id, "doc", {
        ...previous,
        returnReader: "know",
        ...sourceParameters({
          kind: "document",
          literature_id: d.source_material_ref.literature_id,
          asset_id: d.source_material_ref.asset_id,
          asset_sha256: d.source_material_ref.asset_sha256,
          document_version_id: d.document_version_id,
          representation_sha256: d.representation_sha256,
          start_utf8: resolved.target_range!.start_utf8,
          end_utf8: resolved.target_range!.end_utf8,
        }),
      });
    } else if (evidence.target_kind === "material") {
      shell.openPaper(evidence.material.literature_id, "pdf", {
        ...previous,
        returnReader: "know",
        asset: evidence.material.asset_id,
        assetHash: evidence.material.asset_sha256,
      });
    }
  };
  return (
    <div className="reader-evidence-preview">
      <h3>证据 {index}</h3>
      {result.isPending ? (
        <Skeleton label="正在核对原文" rows={2} />
      ) : result.error && !result.data ? (
        <ErrorNotice
          message={errorMessage(result.error)}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : (
        <>
          <blockquote
            className="reader-prose"
            dangerouslySetInnerHTML={{
              __html: markdown.parse(
                result.data?.pages.map((page) => page.text ?? "").join("") ||
                  "这份证据来自原始材料，没有可显示的解析片段。",
              ),
            }}
          />
          <p className="ui-description">
            {result.data?.pages[0]?.document
              ? "定位到固定文档段落；不推测 PDF 页码。"
              : "打开同一份已核验原始材料。"}
            {result.hasNextPage ? "已读取部分证据。" : "已读取完整证据。"}
          </p>
          {result.error && (
            <ErrorNotice
              message={errorMessage(result.error)}
              retained="已读取证据保留。"
            />
          )}
          {result.hasNextPage && (
            <Button
              isPending={result.isFetchingNextPage}
              onPress={() => result.fetchNextPage().then(() => {})}
            >
              继续读取证据
            </Button>
          )}
          <Button onPress={open}>在原文中核对</Button>
          {result.data?.pages[0]?.location && result.data.pages[0].document ? (
            <Button
              onPress={() => {
                const first = result.data!.pages[0]!,
                  material = first.document!.source_material_ref;
                shell.openPaper(material.literature_id, "pdf", {
                  asset: material.asset_id,
                  assetHash: material.asset_sha256,
                  page: String(first.location!.page),
                  ...(first.location!.region
                    ? { region: JSON.stringify(first.location!.region) }
                    : {}),
                });
              }}
            >
              在 PDF 中核对区域
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
export function SummaryView({
  id,
  source,
  search,
  position,
}: {
  id: string;
  source: FixedSource | null;
  search: string;
  position: ReadingPosition;
}) {
  const api = useApi(),
    route = useUrlState();
  const root = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const query = useQuery({
    queryKey: [
      "processors",
      "summary",
      id,
      route.parameters.get("result"),
      route.parameters.get("resultHash"),
    ],
    queryFn: async ({ signal }) => {
      const fixed = route.parameters.get("result");
      let ref;
      if (fixed)
        ref = resultReference(
          record(
            (await api.processors("read", { result_id: fixed }, signal)).result,
            "summary",
          ).ref,
        );
      else {
        let after = "";
        const rows: Record<string, unknown>[] = [];
        do {
          const page = record(
            (
              await api.processors(
                "results",
                { literature_id: id, limit: 200, after },
                signal,
              )
            ).result,
            "summary list",
          );
          if (!Array.isArray(page.items)) throw new Error("总结列表无效");
          rows.push(
            ...page.items
              .map((v) => record(v, "summary"))
              .filter((v) => v.processor_id === "summary"),
          );
          after = typeof page.next_after === "string" ? page.next_after : "";
        } while (after);
        rows.sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)),
        );
        if (!rows.length) return null;
        ref = resultReference(rows[0]);
      }
      const expectedHash = route.parameters.get("resultHash");
      if (fixed && expectedHash && expectedHash !== ref.content_sha256)
        throw new Error("总结内容与固定引用不匹配");
      const saved = await readProcessorResult(api, ref, signal);
      if (
        saved.result.invocation.processor.id !== "summary" ||
        !saved.result.literature_ids.includes(id) ||
        saved.result.content.kind !== "report"
      )
        throw new Error("总结不属于当前文献");
      return saved;
    },
  });
  const generate = async () => {
    setBusy(true);
    setFailure("");
    try {
      await api.submitProcessor(
        {
          schema_version: 1,
          idempotency_key: randomId(),
          name: "文献总结",
          processor: { id: "summary", version: "2" },
          spec: { purpose: "overview", question: null },
          inputs: [{ kind: "literature", literature_id: id }],
        },
        true,
      );
      navigate({ view: "task", literature: null });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  useLayoutEffect(() => {
    const container = root.current?.closest<HTMLElement>(".reading-scroll");
    if (!container || !query.data) return;
    container.scrollTop = position.scroll;
    const remember = () => {
      position.scroll = container.scrollTop;
    };
    container.addEventListener("scroll", remember, { passive: true });
    return () => container.removeEventListener("scroll", remember);
  }, [query.data, position]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    for (const mark of element.querySelectorAll("mark[data-summary-match]")) {
      mark.replaceWith(...mark.childNodes);
    }
    element.normalize();
    if (!search.trim()) return;
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(".reader-statement, .reader-prose") &&
        !n.parentElement.closest("button")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.data,
        needle = search.toLocaleLowerCase(),
        lower = text.toLocaleLowerCase();
      let start = 0,
        index = lower.indexOf(needle);
      if (index < 0) continue;
      const fragment = document.createDocumentFragment();
      while (index >= 0) {
        fragment.append(text.slice(start, index));
        const mark = document.createElement("mark");
        mark.dataset.summaryMatch = "";
        mark.textContent = text.slice(index, index + search.length);
        fragment.append(mark);
        start = index + search.length;
        index = lower.indexOf(needle, start);
      }
      fragment.append(text.slice(start));
      node.replaceWith(fragment);
    }
  }, [query.data, search]);
  if (query.isPending) return <Skeleton label="正在读取已保存总结" rows={5} />;
  if (query.error)
    return (
      <ErrorNotice
        message={errorMessage(query.error)}
        onRetry={() => query.refetch().then(() => {})}
      />
    );
  const saved = query.data,
    content = saved?.result.content;
  return (
    <section
      ref={root}
      className="reading-article reader-summary"
      aria-label="文献总结"
    >
      {failure ? <ErrorNotice message={failure} /> : null}
      {!saved ? (
        <EmptyState
          title="尚无已保存总结"
          description="解析全文后可以手动生成总结；阅读不会触发模型调用。"
        />
      ) : null}
      {saved?.freshness.state === "stale" ? (
        <p role="status">
          已过时：本文的内容版本已变化。现有总结仍可阅读与核对。
        </p>
      ) : null}
      <Button isDisabled={busy} onPress={() => void generate()}>
        {busy ? "正在提交…" : saved ? "重新生成" : "生成总结"}
      </Button>
      {saved && content?.kind === "report" ? (
        <>
          {content.claims.length ? (
            content.claims.map((claim, index) => (
              <section
                key={claim.record_id}
                className="reader-statement"
                aria-label={`总结条目 ${index + 1}`}
              >
                <div
                  className="reader-prose"
                  dangerouslySetInnerHTML={{
                    __html: markdown.parse(
                      readableClaim(claim.text, claim.sources),
                    ),
                  }}
                />
                {saved.result.value_checks
                  .filter((c) => c.record_id === claim.record_id)
                  .map((c) => (
                    <details
                      key={c.pointer}
                      className="reader-value-check"
                      data-status={c.status}
                    >
                      <summary>{valueCheckLabels[c.status]}</summary>
                      <p>{valueCheckReason(c.reason)}</p>
                      {c.sources.map((source, sourceIndex) => (
                        <div key={sourceIndex} className="reader-check-source">
                          <p>
                            来源 {sourceIndex + 1}：
                            {valueCheckLabels[source.status]}
                            {source.basis
                              ? `（${valueCheckBasisLabels[source.basis]}）`
                              : ""}
                            。{valueCheckReason(source.reason)}
                          </p>
                          {source.citation.kind === "document" &&
                          unavailable(source.citation.evidence) ? (
                            <UnavailableCitation
                              label={`来源 ${index + 1}.${sourceIndex + 1}`}
                            />
                          ) : source.citation.kind === "document" ? (
                            <Popover
                              label={`核对来源 ${index + 1}.${sourceIndex + 1}`}
                              trigger="查看对应原文"
                            >
                              <EvidencePreview
                                evidence={source.citation.evidence}
                                index={sourceIndex + 1}
                              />
                            </Popover>
                          ) : null}
                        </div>
                      ))}
                    </details>
                  ))}
                <div
                  className="reader-evidence-list"
                  aria-label={`条目 ${index + 1} 的证据`}
                >
                  {claim.sources.map((citation, i) =>
                    citation.kind === "document" &&
                    unavailable(citation.evidence) ? (
                      <UnavailableCitation
                        key={i}
                        label={`[${index + 1}.${i + 1}]`}
                      />
                    ) : citation.kind === "document" ? (
                      <Popover
                        key={i}
                        label={`证据 ${index + 1}.${i + 1}`}
                        trigger={`[${index + 1}.${i + 1}]`}
                      >
                        <EvidencePreview
                          evidence={citation.evidence}
                          index={i + 1}
                        />
                      </Popover>
                    ) : null,
                  )}
                </div>
              </section>
            ))
          ) : (
            <div
              className="reader-prose"
              dangerouslySetInnerHTML={{ __html: markdown.parse(content.text) }}
            />
          )}
          <TechDetails>
            <pre>
              {JSON.stringify(
                {
                  result_id: saved.ref.result_id,
                  coverage: saved.result.coverage,
                  freshness: saved.freshness,
                  source,
                  search,
                },
                null,
                2,
              )}
            </pre>
          </TechDetails>
        </>
      ) : null}
    </section>
  );
}
