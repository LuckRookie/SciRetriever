import { Assignment } from "../tags/Assignment.js";
import {
  openBatch,
  openFolder,
  folderPaths,
  useFolders,
} from "../library/Folders.js";
import { MetadataFields } from "../archive/MetadataFields.js";
import { StepActions } from "../archive/StepActions.js";
import { OperationDialog } from "../library/OperationDialog.js";
import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ARTICLE_KIND_LABELS,
  PUBLICATION_FORM_LABELS,
  parseLiteratureSearchItem,
  parseReferenceDetail,
  type DocumentReadingRef,
  type LiteratureDetail,
  type TextLevel,
} from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Icon,
  IconButton,
  TechDetails,
  Popover,
  RichTitle,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  emptyQuery,
  paperAuthors,
  paperCitation,
  paperTitleParts,
} from "../../data/library.js";
import { navigate } from "../../data/url.js";
import { titleParts } from "../../../reading/title.js";
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
              <RichTitle parts={paperTitleParts(row.item)} />
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
                    : `全文参考文献第 ${support.source.reference_index + 1} 项`}
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
/**
 * “关联” (reading-experience 1.4, 3.7): always there, since citations between
 * papers need no processing. Of the overview, the rows 被引用 and 引用; the
 * rest (一致, 矛盾, the topic pages, by key point) waits for processing.
 * The counts are the information panel's 参考文献 and 库内被引.
 */
export function ReaderRelations({ detail }: { detail: LiteratureDetail }) {
  const [open, setOpen] = useState<"references" | "cited-by" | null>(null);
  const id = detail.literature.literature_id;
  const rows = [
    {
      key: "cited-by" as const,
      label: "被引用",
      total: null,
      library: detail.cited_by_count,
    },
    {
      key: "references" as const,
      label: "引用",
      total: detail.reference_count,
      library: null,
    },
  ];
  return (
    <section className="reader-relations-overview" aria-label="库内概况">
      <h3>库内概况</h3>
      <table className="reader-relations-table">
        <thead>
          <tr>
            <td />
            <th scope="col">总数</th>
            <th scope="col">库内数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <Button
                  variant="text"
                  size="compact"
                  aria-expanded={open === row.key}
                  onPress={() =>
                    setOpen((value) => (value === row.key ? null : row.key))
                  }
                >
                  {row.label}
                </Button>
              </th>
              <td>{row.total === null ? "—" : row.total.toLocaleString()}</td>
              <td>
                {row.library === null ? "—" : row.library.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open ? <Relations key={open} id={id} direction={open} /> : null}
    </section>
  );
}
/** One archive fact: done, in progress, needs attention, or not yet. */
function Step({
  state,
  children,
}: {
  state: "done" | "pending" | "warning" | "todo";
  children: ReactNode;
}) {
  return (
    <li className="reader-step" data-state={state}>
      <span aria-hidden="true">
        {state === "done" ? (
          <Icon name="check" />
        ) : state === "warning" ? (
          <Icon name="warning" />
        ) : null}
      </span>
      <div>{children}</div>
    </li>
  );
}
export function ReaderInformation({
  detail,
  document,
  resources,
  archivePrimaryElsewhere = false,
}: {
  detail: LiteratureDetail;
  document: DocumentReadingRef | null;
  resources: readonly ReaderResourceEntry[];
  /** The text area already shows “建立文献档案” as the screen's one primary button. */
  archivePrimaryElsewhere?: boolean;
}) {
  const api = useApi(),
    shell = useShell(),
    folders = useFolders(),
    [expanded, setExpanded] = useState(false),
    [editing, setEditing] = useState<"metadata" | "tags" | null>(null),
    [relation, setRelation] = useState<"versions" | "resources" | null>(null),
    [operation, setOperation] = useState<
      "archive" | "export" | "identity" | null
    >(null);
  const assetId = detail.primary_pdf?.asset.asset_id ?? null,
    maintenance = api.workspace.capabilities.maintenance;
  // Where the reading text came from; absent before a corrected text exists.
  const reading = useQuery({
    queryKey: ["document", "reading-status", assetId],
    queryFn: ({ signal }) => readReadingStatus(api, assetId!, signal),
    // A proofread text's account; a draft has none (technical 04 §8.10).
    enabled:
      !!assetId &&
      (detail.literature.status === "READY" ||
        detail.text_level === "proofread"),
    retry: false,
  });
  const id = detail.literature.literature_id,
    m = detail.literature.metadata,
    doi = m.identifiers.find((value) => value.namespace === "doi")?.value,
    otherIdentifiers = m.identifiers.filter(
      (value) => value.namespace !== "doi",
    );
  // Archiving parses first when needed (Owner 2026-10-30): one next step.
  const next = detail.literature.status === "ASSET_READY" ? "archive" : null,
    unparsed = next && detail.missing_step === "raw-parse";
  // The parts with a default text: the main text, then each supplement.
  const supplements = detail.additional_assets.filter(
    (part) => part.default_text !== undefined,
  );
  const levels: [string, TextLevel][] = [
    ...(detail.text_level
      ? [["全文", detail.text_level] as [string, TextLevel]]
      : []),
    ...supplements.flatMap((part, index): [string, TextLevel][] =>
      part.default_text
        ? [[`补充材料 ${index + 1}`, part.default_text.text_level]]
        : [],
    ),
  ];
  const identity = detail.primary_pdf
    ? (detail.primary_pdf.article_identity_status ?? "unverified")
    : null;
  const tags = [...(detail.tags ?? [])].sort((a, b) => a.rank - b.rank),
    paths = new Map(
      folderPaths(folders.data?.items ?? []).map((p) => [p.id, p.label]),
    ),
    memberOf = (detail.folder_ids ?? []).filter((f) => paths.has(f));
  const kind = [
    m.publication_form ? PUBLICATION_FORM_LABELS[m.publication_form] : null,
    m.article_kind ? ARTICLE_KIND_LABELS[m.article_kind] : null,
  ].filter(Boolean);
  /** Each term opens the library filtered by it. */
  const terms = (
    field: "keywords" | "subject_terms",
    values: readonly string[],
  ) => (
    <span className="reader-terms" data-field={field}>
      {values.map((value) => (
        <Button
          key={value}
          variant="text"
          size="compact"
          className="reader-term"
          aria-label={`在文献库查看${field === "keywords" ? "作者关键词" : "主题词"}“${value}”`}
          onPress={() =>
            navigate({
              view: "lib",
              literature: null,
              query: JSON.stringify({ ...emptyQuery(), [field]: [value] }),
            })
          }
        >
          {value}
        </Button>
      ))}
    </span>
  );
  // Only what the metadata holds: a missing field is left out, not "未提供".
  const fields: [string, ReactNode][] = [
    ["作者", paperAuthors(detail)],
    ...(m.venue
      ? [["期刊", <cite key="venue">{m.venue}</cite>] as [string, ReactNode]]
      : []),
    ...(m.publication_date || m.publication_year
      ? [
          ["发表", m.publication_date ?? String(m.publication_year)] as [
            string,
            ReactNode,
          ],
        ]
      : []),
    ...(m.volume || m.issue
      ? [
          [
            "卷期",
            [m.volume && `第 ${m.volume} 卷`, m.issue && `第 ${m.issue} 期`]
              .filter(Boolean)
              .join("，"),
          ] as [string, ReactNode],
        ]
      : []),
    ...(m.pages ? [["页码", m.pages] as [string, ReactNode]] : []),
    ...(m.publisher ? [["出版方", m.publisher] as [string, ReactNode]] : []),
    ...(kind.length ? [["类型", kind.join("，")] as [string, ReactNode]] : []),
    ...(m.language ? [["语言", m.language] as [string, ReactNode]] : []),
    ...(doi
      ? [
          [
            "DOI",
            <span className="reader-doi" key="doi">
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
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...otherIdentifiers.map(
      (i) => [i.namespace.toUpperCase(), i.value] as [string, ReactNode],
    ),
    ...(m.keywords.length
      ? [["作者关键词", terms("keywords", m.keywords)] as [string, ReactNode]]
      : []),
    ...(m.subject_terms.length
      ? [
          ["主题词", terms("subject_terms", m.subject_terms)] as [
            string,
            ReactNode,
          ],
        ]
      : []),
    ...(detail.intake_batches.length
      ? [
          [
            "入库",
            <span className="reader-batches" key="batches">
              {detail.intake_batches.map((batch) => (
                <Button
                  key={batch.batch_id}
                  variant="text"
                  size="compact"
                  onPress={() => openBatch(batch.batch_id)}
                >
                  {batch.label}
                </Button>
              ))}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
  ];
  // Citations between papers are in the “关联” tab (spec 1.4); the
  // paper's other versions and its figure resources are part of 材料.
  const relations: {
    key: "versions" | "resources";
    label: string;
    count: number;
    unit: string;
  }[] = [
    {
      key: "versions",
      label: "其他版本",
      count: detail.other_versions.length,
      unit: "个",
    },
    {
      key: "resources",
      label: "图表资源",
      count: resources.length,
      unit: "项",
    },
  ];
  return (
    <>
      <section className="reader-info-metadata" aria-label="元数据">
        {/* The title is already on the tab and the page; the panel adds the rest. */}
        <dl className="reader-fields">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="reader-action-group">
          <Button
            variant="text"
            size="compact"
            onPress={() => {
              void copyText(paperCitation(detail))
                .then(() => shell.notify("引用已复制"))
                .catch(() =>
                  shell.notify("浏览器未允许复制，可选择书目信息手动复制。"),
                );
            }}
          >
            复制引用
          </Button>
          {api.kind === "workspace" ? (
            <Button
              variant="text"
              size="compact"
              onPress={() => setOperation("export")}
            >
              导出书目
            </Button>
          ) : null}
          <Button
            variant="text"
            size="compact"
            aria-expanded={editing === "metadata"}
            onPress={() =>
              setEditing((value) => (value === "metadata" ? null : "metadata"))
            }
          >
            {editing === "metadata" ? "收起元数据编辑" : "编辑元数据"}
          </Button>
        </div>
        {editing === "metadata" ? <MetadataFields id={id} /> : null}
      </section>
      <section>
        <h3>摘要</h3>
        {m.abstract ? (
          <>
            <p className={expanded ? "" : "reader-abstract-clamped"}>
              {m.abstract}
            </p>
            <Button
              size="compact"
              variant="text"
              onPress={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起摘要" : "展开摘要"}
            </Button>
          </>
        ) : (
          <p className="reader-quiet">
            {detail.literature.status === "READY"
              ? "元数据里没有摘要，可在“编辑元数据”中补上。"
              : "元数据里没有摘要，生成全文时会从全文补上。"}
          </p>
        )}
      </section>
      <section>
        <h3>标签</h3>
        <div className="paper-tags reader-tags">
          {tags.map((t) => (
            <span
              key={t.tag_id}
              className={t.rank === 1 ? "paper-tag primary" : "paper-tag"}
              title={t.rank === 1 ? "主标签" : undefined}
            >
              {t.name}
            </span>
          ))}
          {!tags.length ? (
            <span className="reader-quiet">还没有标签。</span>
          ) : null}
        </div>
        <Button
          variant="text"
          size="compact"
          aria-expanded={editing === "tags"}
          onPress={() =>
            setEditing((value) => (value === "tags" ? null : "tags"))
          }
        >
          {editing === "tags" ? "收起标签编辑" : "编辑标签"}
        </Button>
        {editing === "tags" ? <Assignment id={id} /> : null}
      </section>
      {memberOf.length ? (
        <section>
          <h3>文件夹</h3>
          <ul className="reader-folders">
            {memberOf.map((folder) => (
              <li key={folder}>
                <Button
                  variant="text"
                  size="compact"
                  icon={<Icon name="folder" />}
                  onPress={() => openFolder(folder)}
                >
                  {paths.get(folder)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="reader-info-archive">
        <h3>材料</h3>
        <ul className="reader-steps">
          <Step state={detail.primary_pdf ? "done" : "todo"}>
            {detail.primary_pdf ? "原始 PDF 已保存" : "还没有原始 PDF"}
          </Step>
          {identity ? (
            <Step
              state={
                identity === "match-supported"
                  ? "done"
                  : identity === "conflict"
                    ? "warning"
                    : "todo"
              }
            >
              {
                {
                  unverified: "尚未核对这份 PDF 是否就是这篇文章",
                  "match-supported": "已核对：PDF 就是这篇文章",
                  conflict: "PDF 与这篇文章可能不符",
                  "insufficient-evidence":
                    "核对过，但证据不足以确认 PDF 就是这篇",
                }[identity]
              }
              {detail.primary_pdf?.article_identity_assessment ? (
                <Disclosure title="核对依据">
                  <p>{detail.primary_pdf.article_identity_assessment.reason}</p>
                  <div className="reader-evidence-list">
                    {detail.primary_pdf.article_identity_assessment.evidence.map(
                      (item, index) => (
                        <Popover
                          key={index}
                          label={`核对依据 ${index + 1}`}
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
              ) : null}
              {identity !== "match-supported" && maintenance ? (
                <Button
                  variant="text"
                  size="compact"
                  onPress={() => setOperation("identity")}
                >
                  核对身份
                </Button>
              ) : null}
            </Step>
          ) : null}
          <Step
            state={
              detail.literature.status === "READY"
                ? "done"
                : detail.literature.status === "ARCHIVE_FAILED"
                  ? "warning"
                  : detail.literature.status === "ARCHIVING"
                    ? "pending"
                    : "todo"
            }
          >
            {(
              {
                READY: statusLabels.READY!,
                ARCHIVING: statusLabels.ARCHIVING!,
                ARCHIVE_FAILED: "全文生成失败，可以重新生成",
              } as Record<string, string>
            )[detail.literature.status] ??
              (next && !unparsed ? "已解析，还没有生成全文" : "还没有生成全文")}
            {detail.literature.status === "READY" && detail.long_document ? (
              <p className="ui-description">
                长文档（{detail.long_document.pages} 页）·
                未逐页校订，文字可能含解析错误；以 PDF 为准
              </p>
            ) : null}
            {/* Reading-experience 1.4, 3.4: each part's default text, by level. */}
            {levels.map(([part, level]) => (
              <p key={part} className="ui-description reader-text-level">
                {part}：{level === "draft" ? "未校对" : "已校对"}
              </p>
            ))}
            {levels.some(([, level]) => level === "draft") ? (
              <p className="ui-description">
                未校对的全文不接受改字，生成全文并校对后再修改
              </p>
            ) : null}
          </Step>
        </ul>
        <ul className="reader-relation-list">
          {relations
            .filter((r) => r.key !== "resources" || r.count > 0)
            .map((r) => (
              <li key={r.key}>
                {r.count > 0 ? (
                  <Button
                    variant="text"
                    size="compact"
                    aria-label={`${r.label} ${r.count.toLocaleString()} ${r.unit}`}
                    aria-expanded={relation === r.key}
                    onPress={() =>
                      setRelation((value) => (value === r.key ? null : r.key))
                    }
                  >
                    <span>{r.label}</span>
                    <span className="reader-count">
                      {r.count.toLocaleString()} {r.unit}
                    </span>
                  </Button>
                ) : (
                  <span className="reader-relation-empty">
                    <span>{r.label}</span>
                    <span className="reader-count">无</span>
                  </span>
                )}
              </li>
            ))}
        </ul>
        {relation === "versions" ? (
          <div className="reader-relations">
            {detail.other_versions.map((version) => (
              <div key={version.literature.literature_id}>
                <Button
                  variant="text"
                  onPress={() =>
                    shell.openPaper(version.literature.literature_id)
                  }
                >
                  <RichTitle parts={paperTitleParts(version)} />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {relation === "resources" ? (
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
        ) : null}
        {reading.data ? (
          <dl className="reader-fields">
            <div>
              <dt>文字来源</dt>
              <dd>
                解析 {reading.data.blocks.parser} 块，Agent 矫正{" "}
                {reading.data.blocks.agent} 块，人工{" "}
                {reading.data.blocks.manual} 块
              </dd>
            </div>
            <div>
              <dt>PDF 自带的文字</dt>
              <dd>
                {reading.data.text_layer_pages} / {reading.data.total_pages}{" "}
                页有自带的文字
              </dd>
            </div>
            <div>
              <dt>人工修改</dt>
              <dd>
                {reading.data.last_manual_edit
                  ? `${reading.data.last_manual_edit.actor_label}，${localTime(reading.data.last_manual_edit.at)}`
                  : "尚无"}
              </dd>
            </div>
          </dl>
        ) : null}
        {next && maintenance ? (
          <div className="reader-next-step">
            <p>
              {/* Reading-experience 3.4: what archiving adds to a draft. */}
              {detail.text_level === "draft"
                ? "已有未校对的全文，可以阅读和翻译；生成全文后得到已校对的全文，可以改字和运行算子。"
                : "生成全文后可以读全文、翻译和运行算子。"}
              {unparsed
                ? "会先用 MinerU 解析版面，再调用模型校订全文、补全元数据。"
                : "会调用模型校订全文、补全元数据。"}
            </p>
          </div>
        ) : null}
        {maintenance ? (
          <div className="reader-action-group">
            {next ? (
              <Button
                variant={archivePrimaryElsewhere ? "text" : "primary"}
                onPress={() => setOperation(next)}
              >
                生成全文
              </Button>
            ) : null}
            <StepActions id={id} />
          </div>
        ) : null}
        {operation ? (
          <OperationDialog
            ids={[id]}
            kind={operation}
            onClose={() => setOperation(null)}
          />
        ) : null}
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
            <p>
              <RichTitle parts={titleParts(observation.metadata.title)} />
            </p>
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
