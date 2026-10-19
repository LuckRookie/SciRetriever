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
  TechDetails,
  Popover,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { paperAuthors, paperTitle } from "../../data/library.js";
import { navigate } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { record } from "../../data/wire.js";
import { errorMessage } from "../../strings.js";
import type { ReaderResourceEntry } from "../../../reading/contract.js";
import { copyText } from "../../../browser-platform.js";
import { EvidencePreview } from "./SummaryView.js";

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
                    : `已保存正文参考文献第 ${support.source.reference_index + 1} 项`}
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
  onOperation,
  resources,
}: {
  detail: LiteratureDetail;
  document: DocumentReadingRef | null;
  resources: readonly ReaderResourceEntry[];
  onOperation: (kind: string) => void;
}) {
  const api = useApi(),
    shell = useShell(),
    [expanded, setExpanded] = useState(false),
    [relation, setRelation] = useState<"references" | "cited-by" | null>(null);
  const id = detail.literature.literature_id,
    m = detail.literature.metadata,
    doi = m.identifiers.find((value) => value.namespace === "doi")?.value;
  const results = useInfiniteQuery({
    queryKey: ["processors", "reader-related", id],
    initialPageParam: null as string | null,
    enabled: api.workspace.capabilities.query === true,
    queryFn: async ({ signal, pageParam }) => {
      const value = record(
        (
          await api.processors(
            "results",
            {
              literature_id: id,
              limit: 10,
              ...(pageParam ? { after: pageParam } : {}),
            },
            signal,
          )
        ).result,
        "related results",
      );
      if (!Array.isArray(value.items)) throw new Error("处理结果列表无效");
      if (value.next_after !== null && typeof value.next_after !== "string")
        throw new Error("处理结果续读游标无效");
      return {
        items: value.items.map((raw) => record(raw, "result")),
        next: value.next_after as string | null,
      };
    },
    getNextPageParam: (page) => page.next,
  });
  const resultItems = results.data?.pages.flatMap((page) => page.items);
  return (
    <>
      <header>
        <p className="reader-eyebrow">文献信息</p>
        <h2>{paperTitle(detail)}</h2>
        <p>{paperAuthors(detail)}</p>
        <p>
          <i>{m.venue}</i>
          {m.publication_year ? ` · ${m.publication_year}` : ""}
        </p>
        {doi && (
          <div className="reader-action-group">
            <Button
              variant="text"
              size="compact"
              onPress={() => {
                void copyText(doi)
                  .then(() => shell.notify("DOI 已复制"))
                  .catch(() =>
                    shell.notify("浏览器未允许复制，可选择 DOI 文本复制。"),
                  );
              }}
            >
              复制 DOI
            </Button>
          </div>
        )}
        {doi && (
          <a
            href={`https://doi.org/${encodeURIComponent(doi)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {doi}
          </a>
        )}
      </header>
      <section>
        <h3>摘要</h3>
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
        <p className="ui-description">摘要来自书目元数据，不是 Agent 总结。</p>
      </section>
      <section>
        <h3>可读材料</h3>
        <ul className="reader-materials">
          <li>
            {detail.primary_pdf
              ? "原始 PDF 已保存，可随时核对。"
              : "暂无 PDF，可显式获取或上传。"}
          </li>
          {detail.primary_pdf && (
            <li>
              {
                {
                  unverified: "文章身份未验证",
                  "match-supported": "文章身份有证据支持",
                  conflict: "文章身份存在冲突",
                  "insufficient-evidence": "文章身份证据不足",
                }[detail.primary_pdf.article_identity_status ?? "unverified"]
              }
              ；保存 PDF 不等于已核对文章身份。
            </li>
          )}
          <li>
            {document
              ? "全文已解析，可连续阅读。"
              : "全文可用性以打开后的固定文档查询为准。"}
          </li>
          <li>总结只展示已发布结果，阅读不会启动分析。</li>
        </ul>
      </section>
      {resources.length > 0 && (
        <Disclosure title={`文档资源（${resources.length}）`}>
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
      <section>
        <h3>日常操作</h3>
        <div className="reader-action-group">
          {api.kind === "workspace" && (
            <Button variant="text" onPress={() => onOperation("export")}>
              导出书目
            </Button>
          )}
          <Button variant="text" onPress={() => setRelation("references")}>
            查看参考文献
          </Button>
          <Button variant="text" onPress={() => setRelation("cited-by")}>
            查看库内被引
          </Button>
        </div>
        {api.kind !== "workspace" && (
          <p className="ui-description">
            此独立入口支持材料阅读和下载；书目导出请使用主工作台、CLI 或 MCP。
          </p>
        )}
        {relation && <Relations key={relation} id={id} direction={relation} />}
      </section>
      {api.workspace.capabilities.maintenance && (
        <section>
          <h3>加工材料</h3>
          <p className="ui-description">
            加工需确认，可能调用已配置的解析或模型服务。
          </p>
          <div className="reader-action-group">
            {[
              { kind: "acquire", label: "获取 PDF", reason: "" },
              { kind: "upload", label: "上传 PDF", reason: "" },
              {
                kind: "parse",
                label: "解析",
                reason: detail.primary_pdf ? "" : "没有 PDF，无法解析",
              },
              {
                kind: "analyze",
                label: "分析",
                reason: detail.primary_pdf ? "" : "没有 PDF，无法分析",
              },
              {
                kind: "identity",
                label: "核验身份",
                reason: detail.primary_pdf ? "" : "没有 PDF，无法核验",
              },
            ].map((action) => (
              <Button
                key={action.kind}
                variant="process"
                confirm={false}
                isDisabled={!!action.reason}
                disabledReason={action.reason || undefined}
                onPress={() => onOperation(action.kind)}
              >
                {action.label}
              </Button>
            ))}
            <Button
              variant="text"
              onPress={() => {
                shell.setSelected(new Set([id]));
                navigate(
                  { view: "syn", literature: null, scope: "selection" },
                  { clearSource: true },
                );
              }}
            >
              加入综合
            </Button>
            <Button
              variant="text"
              onPress={() => {
                shell.setSelected(new Set([id]));
                navigate(
                  { view: "ext", literature: null, scope: "selection" },
                  { clearSource: true },
                );
              }}
            >
              加入提取
            </Button>
          </div>
        </section>
      )}
      {detail.primary_pdf?.article_identity_assessment && (
        <Disclosure title="已保存的身份核验">
          <p>{detail.primary_pdf.article_identity_assessment.reason}</p>
          <div className="reader-evidence-list">
            {detail.primary_pdf.article_identity_assessment.evidence.map(
              (item, index) => (
                <Popover
                  key={index}
                  label={`核验证据 ${index + 1}`}
                  trigger={<span>[{index + 1}]</span>}
                >
                  <EvidencePreview evidence={item.evidence} index={index + 1} />
                </Popover>
              ),
            )}
          </div>
        </Disclosure>
      )}
      <Disclosure title="已有处理结果">
        {results.error ? (
          <ErrorNotice
            message={errorMessage(results.error)}
            onRetry={() => {
              void results.refetch();
            }}
          />
        ) : resultItems?.length ? (
          resultItems.map((row) => (
            <Button
              key={String(row.result_id)}
              variant="text"
              onPress={() =>
                navigate(
                  {
                    view: "ext",
                    literature: null,
                    result: String(row.result_id),
                    resultHash: String(row.content_sha256),
                  },
                  { clearSource: true },
                )
              }
            >
              {String(row.processor_id)} · {row.complete ? "完整" : "部分覆盖"}
            </Button>
          ))
        ) : (
          <p>暂无已保存处理结果。</p>
        )}
        {results.hasNextPage && (
          <Button
            isPending={results.isFetchingNextPage}
            onPress={async () => {
              await results.fetchNextPage();
            }}
          >
            更多结果
          </Button>
        )}
      </Disclosure>
      {detail.other_versions.length > 0 && (
        <Disclosure title={`其他版本（${detail.other_versions.length}）`}>
          {detail.other_versions.map((version) => (
            <Button
              key={version.literature.literature_id}
              variant="text"
              onPress={() => shell.openPaper(version.literature.literature_id)}
            >
              {paperTitle(version)}
            </Button>
          ))}
        </Disclosure>
      )}
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
            <p>
              采集于{" "}
              {new Date(observation.provenance.observed_at).toLocaleString()}
            </p>
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
