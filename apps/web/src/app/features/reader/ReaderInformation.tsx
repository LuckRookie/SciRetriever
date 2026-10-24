import { Assignment } from "../tags/Assignment.js";
import { MetadataFields } from "../archive/MetadataFields.js";
import { StepActions } from "../archive/StepActions.js";
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  parseLiteratureSearchItem,
  parseReferenceDetail,
  type DocumentReadingRef,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Icon,
  IconButton,
  TechDetails,
  Popover,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { paperAuthors, paperTitle } from "../../data/library.js";
import { useShell } from "../../shell/context.js";
import { record } from "../../data/wire.js";
import { errorMessage, localTime, statusLabels } from "../../strings.js";
import type { ReaderResourceEntry } from "../../../reading/contract.js";
import { copyText } from "../../../browser-platform.js";
import { EvidencePreview } from "./SummaryView.js";
import { readReadingStatus } from "../../data/reading-status.js";

function Relations({
  id,
  direction,
}: {
  id: string;
  direction: "references" | "cited-by";
}) {
  const api = useApi(),
    shell = useShell(),
    [selected, setSelected] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["literature", id, "references", direction],
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }) => {
      const value = await api.query(
        "references",
        { literature_id: id, direction, limit: 25, cursor: pageParam },
        signal,
      );
      const p = record(value.page, "references");
      if (
        !Array.isArray(p.items) ||
        (p.next_cursor !== null && typeof p.next_cursor !== "string")
      )
        throw new Error("引用分页回执无效");
      return {
        items: p.items.map((raw) => {
          const r = record(raw, "reference");
          return {
            reference: record(r.reference, "reference id"),
            item: parseLiteratureSearchItem(r.related_literature),
            supports: Number(r.support_count),
          };
        }),
        cursor: p.next_cursor as string | null,
      };
    },
    getNextPageParam: (page) => page.cursor,
  });
  const evidence = useQuery({
    queryKey: ["literature", "reference", selected],
    enabled: !!selected,
    queryFn: async ({ signal }) => {
      const value = parseReferenceDetail(
        (await api.query("reference", { reference_id: selected }, signal))
          .detail,
      );
      if (value.reference.reference_id !== selected)
        throw new Error("引用来源不匹配");
      return value;
    },
  });
  return (
    <div className="reader-relations">
      {query.error && (
        <ErrorNotice
          message={errorMessage(query.error)}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.data?.pages
        .flatMap((page) => page.items)
        .map((row) => (
          <div key={String(row.reference.reference_id)}>
            <Button
              variant="text"
              onPress={() => shell.openPaper(row.item.literature.literature_id)}
            >
              {paperTitle(row.item)}
            </Button>
            <Button
              variant="text"
              size="compact"
              onPress={() => setSelected(String(row.reference.reference_id))}
            >
              来源证据（{row.supports}）
            </Button>
          </div>
        ))}
      {!query.isPending &&
        !query.data?.pages.some((page) => page.items.length) && (
          <p>没有已保存的关系；这不表示原文没有参考文献。</p>
        )}
      {query.hasNextPage && (
        <Button
          isPending={query.isFetchingNextPage}
          onPress={async () => {
            await query.fetchNextPage();
          }}
        >
          加载更多引用
        </Button>
      )}
      {evidence.error && <ErrorNotice message={errorMessage(evidence.error)} />}{" "}
      {evidence.data && (
        <Disclosure title="所选引用的来源证据" defaultExpanded>
          <ul>
            {evidence.data.supports.map((support, index) => (
              <li key={index}>
                {support.source.kind === "provider_relation"
                  ? "由元数据供应商提供的关系"
                  : support.source.kind === "metadata_reference_text"
                    ? `元数据参考文献第 ${support.source.reference_index + 1} 项`
                    : `校订稿参考文献第 ${support.source.reference_index + 1} 项`}
              </li>
            ))}
          </ul>
          <TechDetails
            copyText={JSON.stringify(evidence.data.supports, null, 2)}
          >
            <pre>{JSON.stringify(evidence.data.supports, null, 2)}</pre>
          </TechDetails>
        </Disclosure>
      )}
    </div>
  );
}
export function ReaderInformation({
  detail,
  document,
  resources,
}: {
  detail: LiteratureDetail;
  document: DocumentReadingRef | null;
  resources: readonly ReaderResourceEntry[];
}) {
  const api = useApi(),
    shell = useShell(),
    [expanded, setExpanded] = useState(false),
    [relation, setRelation] = useState<"references" | "cited-by" | null>(null);
  const assetId = detail.primary_pdf?.asset.asset_id ?? null;
  // Where the reading text came from; absent before a corrected text exists.
  const reading = useQuery({
    queryKey: ["document", "reading-status", assetId],
    queryFn: ({ signal }) => readReadingStatus(api, assetId!, signal),
    enabled: !!assetId && detail.literature.status === "READY",
    retry: false,
  });
  const id = detail.literature.literature_id,
    m = detail.literature.metadata,
    doi = m.identifiers.find((value) => value.namespace === "doi")?.value;
  const identity = detail.primary_pdf
    ? {
        unverified: "未核验",
        "match-supported": "有证据支持",
        conflict: "存在冲突",
        "insufficient-evidence": "证据不足",
      }[detail.primary_pdf.article_identity_status ?? "unverified"]
    : null;
  return (
    <>
      <section className="reader-info-status">
        <h3>状态</h3>
        <span className="paper-status" data-state={detail.literature.status}>
          {statusLabels[detail.literature.status]}
        </span>
        <dl className="reader-facts">
          <div>
            <dt>原始 PDF</dt>
            <dd>{detail.primary_pdf ? "已保存" : "未获取"}</dd>
          </div>
          {identity ? (
            <div>
              <dt>文章身份</dt>
              <dd>{identity}</dd>
            </div>
          ) : null}
          <div>
            <dt>全文</dt>
            <dd>
              {(
                {
                  READY: "已建档",
                  ARCHIVING: "建档中",
                  ARCHIVE_FAILED: "建档失败",
                } as Record<string, string>
              )[detail.literature.status] ?? "尚未建档"}
            </dd>
          </div>
          {reading.data ? (
            <>
              <div>
                <dt>文字来源</dt>
                <dd>
                  解析 {reading.data.blocks.parser} · Agent 矫正{" "}
                  {reading.data.blocks.agent} · 人工{" "}
                  {reading.data.blocks.manual} 块
                </dd>
              </div>
              <div>
                <dt>文字层</dt>
                <dd>
                  {reading.data.text_layer_pages} / {reading.data.total_pages}{" "}
                  页有文字层
                </dd>
              </div>
              <div>
                <dt>最后人工修改</dt>
                <dd>
                  {reading.data.last_manual_edit
                    ? `${reading.data.last_manual_edit.actor_label} · ${localTime(reading.data.last_manual_edit.at)}`
                    : "尚无"}
                </dd>
              </div>
            </>
          ) : null}
          {resources.length > 0 ? (
            <div>
              <dt>图表资源</dt>
              <dd>{resources.length} 项</dd>
            </div>
          ) : null}
        </dl>
        {api.workspace.capabilities.maintenance ? (
          <StepActions id={id} />
        ) : null}
      </section>
      <section className="reader-info-bibliography">
        <h3>书目</h3>
        {/* The title is already on the tab and the page; the panel adds the rest. */}
        <dl className="reader-facts">
          <div>
            <dt>作者</dt>
            <dd>{paperAuthors(detail)}</dd>
          </div>
          <div>
            <dt>期刊</dt>
            <dd>
              {m.venue ?? <span className="paper-venue-missing">未提供</span>}
            </dd>
          </div>
          <div>
            <dt>年份</dt>
            <dd>{m.publication_year ?? "未提供"}</dd>
          </div>
          {doi ? (
            <div>
              <dt>DOI</dt>
              <dd className="reader-doi">
                <a
                  href={`https://doi.org/${encodeURIComponent(doi)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {doi}
                </a>
                <IconButton
                  size="inline"
                  variant="text"
                  aria-label="复制 DOI"
                  icon={<Icon name="copy" />}
                  onPress={() => {
                    void copyText(doi)
                      .then(() => shell.notify("DOI 已复制"))
                      .catch(() =>
                        shell.notify("浏览器未允许复制，可选择 DOI 文本复制。"),
                      );
                  }}
                />
              </dd>
            </div>
          ) : null}
        </dl>
        <h4>摘要</h4>
        <p className={expanded ? "" : "reader-abstract-clamped"}>
          {m.abstract || "此来源未提供摘要。"}
        </p>
        {m.abstract && (
          <Button
            size="compact"
            variant="text"
            onPress={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起摘要" : "展开摘要"}
          </Button>
        )}
      </section>
      <section>
        <h3>标签</h3>
        <Disclosure title="编辑标签">
          <Assignment id={id} />
        </Disclosure>
      </section>
      <section>
        <h3>元数据</h3>
        <Disclosure title="字段、来源与锁定">
          <MetadataFields id={id} />
        </Disclosure>
        {detail.primary_pdf?.article_identity_assessment && (
          <Disclosure title="身份核验证据">
            <p>{detail.primary_pdf.article_identity_assessment.reason}</p>
            <div className="reader-evidence-list">
              {detail.primary_pdf.article_identity_assessment.evidence.map(
                (item, index) => (
                  <Popover
                    key={index}
                    label={`核验证据 ${index + 1}`}
                    trigger={<span>[{index + 1}]</span>}
                  >
                    <EvidencePreview
                      evidence={item.evidence}
                      index={index + 1}
                    />
                  </Popover>
                ),
              )}
            </div>
          </Disclosure>
        )}
        {detail.other_versions.length > 0 && (
          <Disclosure title={`其他版本（${detail.other_versions.length}）`}>
            {detail.other_versions.map((version) => (
              <Button
                key={version.literature.literature_id}
                variant="text"
                onPress={() =>
                  shell.openPaper(version.literature.literature_id)
                }
              >
                {paperTitle(version)}
              </Button>
            ))}
          </Disclosure>
        )}
      </section>
      <section>
        <h3>参考文献</h3>
        <div className="reader-action-group">
          <Button variant="text" onPress={() => setRelation("references")}>
            参考文献 {detail.reference_count.toLocaleString()} 条
          </Button>
          <Button variant="text" onPress={() => setRelation("cited-by")}>
            库内被引 {detail.cited_by_count.toLocaleString()} 次
          </Button>
        </div>
        {relation && <Relations key={relation} id={id} direction={relation} />}
        {resources.length > 0 && (
          <Disclosure title={`图表资源（${resources.length}）`}>
            <div className="reader-resources">
              {resources.map((resource) => (
                <Button
                  key={resource.reference}
                  variant="text"
                  onPress={resource.open}
                >
                  {resource.reference}
                </Button>
              ))}
            </div>
          </Disclosure>
        )}
      </section>
      <TechDetails
        copyText={JSON.stringify(
          {
            literature_id: id,
            metadata_revision: detail.metadata_revision,
            metadata_sha256: detail.metadata_sha256,
            document,
          },
          null,
          2,
        )}
      >
        <dl>
          <dt>文献标识</dt>
          <dd>{id}</dd>
          <dt>元数据修订</dt>
          <dd>{detail.metadata_revision}</dd>
          <dt>元数据指纹</dt>
          <dd>{detail.metadata_sha256}</dd>
          {document && (
            <>
              <dt>文档版本</dt>
              <dd>{document.document_version_id}</dd>
              <dt>表示指纹</dt>
              <dd>{document.representation_sha256}</dd>
            </>
          )}
        </dl>
        <h4>元数据来源</h4>
        {detail.metadata_observations.map((observation) => (
          <section className="reader-source" key={observation.observation_id}>
            <h4>{observation.provenance.source_name}</h4>
            <p>{observation.metadata.title}</p>
            <p>
              {observation.metadata.venue} ·{" "}
              {observation.metadata.publication_year}
            </p>
            <p>采集于 {localTime(observation.provenance.observed_at)}</p>
            {observation.metadata.abstract && (
              <Disclosure title="此来源的摘要">
                <p>{observation.metadata.abstract}</p>
              </Disclosure>
            )}
          </section>
        ))}
      </TechDetails>
    </>
  );
}
