import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiteratureSearchItem } from "@sciretriever/contracts";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorNotice,
  Figure,
  PageHeader,
  PageNote,
  SegmentedControl,
  Tabs,
  TechDetails,
  RichTitle,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  loadCitationNetwork,
  type CitationNetwork,
} from "../../data/citations.js";
import {
  emptyQuery,
  paperTitle,
  paperTitleParts,
  readLiterature,
  searchLibrary,
} from "../../data/library.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import "./insights.css";

export default function Insights() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const [tab, setTab] = useState("stats"),
    [asTable, setAsTable] = useState(false),
    [networkMode, setNetworkMode] = useState<"within-scope" | "neighbors">(
      "within-scope",
    ),
    [center, setCenter] = useState<LiteratureSearchItem | null>(null);
  const all = route.parameters.get("scope") === "all",
    selection =
      !all &&
      route.parameters.get("scope") === "selection" &&
      shell.selected.size > 0;
  const query = all ? emptyQuery() : route.query,
    ids = selection ? [...shell.selected].sort() : [];
  const scopeName = all
    ? "全部文献库"
    : selection
      ? "已选文献"
      : JSON.stringify(query) === JSON.stringify(emptyQuery())
        ? "全部文献库"
        : "文献库当前筛选";
  const papers = useQuery({
    queryKey: ["insights", query, route.sort, ids],
    queryFn: async ({ signal }) => {
      const items: LiteratureSearchItem[] = [];
      let cursor: string | null = null,
        total = ids.length;
      if (selection) {
        for (const id of ids.slice(0, 1000))
          items.push(await readLiterature(api, id, signal));
      } else {
        const seen = new Set<string>();
        do {
          const page = await searchLibrary(
            api,
            query,
            route.sort,
            cursor,
            signal,
          );
          total = page.total;
          items.push(...page.items);
          cursor = page.cursor;
          if (cursor) {
            if (seen.has(cursor)) throw new Error("统计续读游标重复");
            seen.add(cursor);
          }
        } while (cursor && items.length < 1000);
      }
      signal.throwIfAborted();
      return { items: items.slice(0, 1000), total };
    },
  });
  const seeds = useMemo(
    () => (center ? [center] : (papers.data?.items.slice(0, 40) ?? [])),
    [center, papers.data],
  );
  const network = useQuery({
    queryKey: [
      "citations",
      seeds.map((item) => item.literature.literature_id),
      networkMode,
    ],
    queryFn: ({ signal }) =>
      loadCitationNetwork(api, { seeds, mode: networkMode, signal }),
    enabled: tab === "network" && papers.isSuccess,
  });
  const apply = (kind: string, label: string) => {
    if (label === "未提供") return;
    const changed =
      kind === "year"
        ? {
            ...query,
            publication_year_from: Number(label),
            publication_year_to: Number(label),
          }
        : kind === "tag"
          ? { ...query, keywords: [label] }
          : kind === "venue"
            ? { ...query, venue: label }
            : null;
    if (changed)
      navigate(
        { view: "lib", query: JSON.stringify(changed), literature: null },
        { clearSource: true },
      );
  };
  const groups = useMemo(() => {
    const items = papers.data?.items ?? [];
    const count = (values: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const value of values)
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts].map(([label, count]) => ({ label, count }));
    };
    const ranked = (rows: Row[]) =>
      rows
        .filter((row) => row.label !== MISSING)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, 10);
    const years = count(
      items.map((item) =>
        String(item.literature.metadata.publication_year ?? MISSING),
      ),
    );
    return {
      year: [
        ...years
          .filter((row) => row.label !== MISSING)
          .sort((a, b) => Number(a.label) - Number(b.label)),
        ...years.filter((row) => row.label === MISSING),
      ],
      venue: ranked(
        count(items.map((item) => item.literature.metadata.venue ?? MISSING)),
      ),
      venueMissing: items.filter((item) => !item.literature.metadata.venue)
        .length,
      keyword: ranked(
        count(
          items.flatMap((item) => [
            ...new Set(item.literature.metadata.keywords),
          ]),
        ),
      ),
      state: STATES.map((state) => ({
        ...state,
        count: items.filter((item) =>
          state.id === "unavailable"
            ? item.needs_manual_pdf
            : !item.needs_manual_pdf && item.literature.status === state.id,
        ).length,
      })).filter((state) => state.count > 0),
    };
  }, [papers.data]);
  return (
    <section className="insights-page">
      <PageHeader title="洞察" />
      <div className="insights-toolbar">
        <Tabs
          label="洞察视图"
          value={tab}
          onChange={setTab}
          items={[
            { id: "stats", label: "统计" },
            { id: "network", label: "引用网络" },
          ]}
        />
        <span className="insights-scope">
          范围：{scopeName}
          {papers.data
            ? ` · ${papers.data.items.length.toLocaleString()} 篇`
            : ""}
        </span>
        {!all && (selection || scopeName !== "全部文献库") && (
          <Button
            variant="text"
            size="compact"
            onPress={() => {
              setCenter(null);
              navigate({ view: "ins", scope: "all" });
            }}
          >
            查看全部文献库
          </Button>
        )}
        {tab === "stats" && papers.isSuccess ? (
          <Button
            variant="text"
            size="compact"
            onPress={() => setAsTable((value) => !value)}
          >
            {asTable ? "以图表查看" : "以表格查看"}
          </Button>
        ) : null}
      </div>
      {papers.isPending ? (
        <p role="status">正在读取当前范围…</p>
      ) : papers.isError ? (
        <ErrorNotice
          message={errorMessage(papers.error)}
          onRetry={() => void papers.refetch()}
        />
      ) : (
        <>
          {tab === "stats" ? (
            <>
              <div className="insight-figures">
                <Figure
                  number={1}
                  title="年份分布"
                  meta={`${papers.data.items.length.toLocaleString()} 篇`}
                >
                  {asTable ? (
                    <CountTable title="年份分布" rows={groups.year} />
                  ) : (
                    <YearColumns
                      rows={groups.year}
                      onSelect={(label) => apply("year", label)}
                    />
                  )}
                </Figure>
                <Figure
                  number={2}
                  title="材料状态"
                  meta={`${papers.data.items.length.toLocaleString()} 篇`}
                >
                  {asTable ? (
                    <CountTable title="材料状态" rows={groups.state} />
                  ) : (
                    <Proportion rows={groups.state} />
                  )}
                </Figure>
                {groups.venue.length ? (
                  <Figure number={3} title="期刊" meta="前 10">
                    {asTable ? (
                      <CountTable title="期刊" rows={groups.venue} />
                    ) : (
                      <Ranking
                        rows={groups.venue}
                        onSelect={(label) => apply("venue", label)}
                      />
                    )}
                  </Figure>
                ) : null}
                {groups.keyword.length ? (
                  <Figure
                    number={groups.venue.length ? 4 : 3}
                    title="元数据关键词"
                    meta="前 10"
                  >
                    {asTable ? (
                      <CountTable title="元数据关键词" rows={groups.keyword} />
                    ) : (
                      <Ranking
                        rows={groups.keyword}
                        onSelect={(label) => apply("tag", label)}
                      />
                    )}
                  </Figure>
                ) : null}
              </div>
              <PageNote>
                基于当前范围已读取的 {papers.data.items.length.toLocaleString()}{" "}
                篇
                {papers.data.total > papers.data.items.length
                  ? `（范围共 ${papers.data.total.toLocaleString()} 篇，单次最多读取 1,000 篇）`
                  : ""}
                。未提供的字段单独计为“未提供”，不做推断
                {groups.venueMissing
                  ? `；${groups.venueMissing.toLocaleString()} 篇未提供期刊，未计入图 3`
                  : ""}
                {groups.keyword.length
                  ? ""
                  : "；暂无关键词元数据，未生成关键词分布"}
                。点击图中的条目可在文献库中查看对应文献。
              </PageNote>
            </>
          ) : (
            <>
              <SegmentedControl
                label="引用显示范围"
                value={networkMode}
                onChange={(value) =>
                  setNetworkMode(
                    value === "neighbors" ? "neighbors" : "within-scope",
                  )
                }
                items={[
                  { id: "within-scope", label: "范围内关系" },
                  { id: "neighbors", label: "包含一跳邻居" },
                ]}
              />
              {center && (
                <p>
                  以「{paperTitle(center)}」为中心。
                  <Button variant="text" onPress={() => setCenter(null)}>
                    恢复当前范围
                  </Button>
                </p>
              )}
              {network.isPending ? (
                <p role="status">正在读取已保存的引用关系…</p>
              ) : network.isError ? (
                <ErrorNotice
                  message={errorMessage(network.error)}
                  onRetry={() => void network.refetch()}
                />
              ) : (
                network.data && (
                  <CitationMap
                    network={network.data}
                    scopeName={scopeName}
                    onCenter={(item) => {
                      setCenter(item);
                      setNetworkMode("neighbors");
                    }}
                  />
                )
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
const MISSING = "未提供";
type Row = { label: string; count: number };
const STATES = [
  { id: "READY", label: "已就绪", tone: "ready" },
  { id: "ASSET_READY", label: "有 PDF", tone: "asset" },
  { id: "ARCHIVING", label: "建档中", tone: "archiving" },
  { id: "ARCHIVE_FAILED", label: "建档失败", tone: "failed" },
  { id: "unavailable", label: "无法获取", tone: "unavailable" },
  { id: "UNREVIEWED", label: "仅元数据", tone: "raw" },
  { id: "EXCLUDED", label: "已排除", tone: "excluded" },
] as const;
const percent = (count: number, total: number) =>
  total
    ? `${((count / total) * 100).toFixed(count / total < 0.1 ? 1 : 0)}%`
    : "0%";
function CountTable({ title, rows }: { title: string; rows: readonly Row[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <DataTable
      label={title}
      rows={[...rows]}
      getRowId={(row) => row.label}
      columns={[
        { id: "label", header: "分类", value: (row) => row.label },
        {
          id: "count",
          header: "篇数",
          numeric: true,
          value: (row) => row.count.toLocaleString(),
        },
        {
          id: "share",
          header: "占比",
          numeric: true,
          value: (row) => percent(row.count, total),
        },
      ]}
    />
  );
}
function YearColumns({
  rows,
  onSelect,
}: {
  rows: readonly Row[];
  onSelect: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  // Narrow columns cannot fit every year; label every nth column in full.
  const step = Math.max(1, Math.ceil(rows.length / 10));
  return (
    <div className="year-columns" role="list">
      {rows.map((row, index) => (
        <button
          key={row.label}
          role="listitem"
          className="year-column"
          data-missing={row.label === MISSING || undefined}
          title={`${row.label}：${row.count.toLocaleString()} 篇`}
          aria-label={`${row.label}，${row.count.toLocaleString()} 篇`}
          onClick={() => onSelect(row.label)}
        >
          <span className="year-column-value">
            {row.count.toLocaleString()}
          </span>
          <span className="year-column-track">
            <i style={{ height: `${Math.max(2, (row.count / max) * 100)}%` }} />
          </span>
          <span className="year-column-label" aria-hidden="true">
            {index % step === 0 || index === rows.length - 1 ? row.label : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
function Ranking({
  rows,
  onSelect,
}: {
  rows: readonly Row[];
  onSelect: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <ol className="ranking">
      {rows.map((row, index) => (
        <li key={row.label}>
          <button
            className="ranking-row"
            title={`${row.label}：${row.count.toLocaleString()} 篇`}
            onClick={() => onSelect(row.label)}
          >
            <span className="ranking-index">{index + 1}</span>
            <span className="ranking-label">{row.label}</span>
            <b>{row.count.toLocaleString()}</b>
            <span className="ranking-track" aria-hidden="true">
              <i style={{ width: `${(row.count / max) * 100}%` }} />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
function Proportion({ rows }: { rows: readonly (Row & { tone: string })[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="proportion">
      <div className="proportion-bar" aria-hidden="true">
        {rows.map((row) => (
          <i
            key={row.label}
            data-tone={row.tone}
            style={{ flexGrow: row.count }}
          />
        ))}
      </div>
      <ul className="proportion-legend">
        {rows.map((row) => (
          <li key={row.label}>
            <span className="proportion-dot" data-tone={row.tone} />
            <span>{row.label}</span>
            <b>{row.count.toLocaleString()}</b>
            <span className="proportion-share">
              {percent(row.count, total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function CitationMap({
  network,
  scopeName,
  onCenter,
}: {
  network: CitationNetwork;
  scopeName: string;
  onCenter: (item: LiteratureSearchItem) => void;
}) {
  const shell = useShell();
  const points = new Map(
    network.nodes.map((node, index) => [
      node.item.literature.literature_id,
      {
        x: 400 + 300 * Math.cos((index / network.nodes.length) * Math.PI * 2),
        y: 250 + 190 * Math.sin((index / network.nodes.length) * Math.PI * 2),
      },
    ]),
  );
  return (
    <div className="citation-network">
      <p>
        查看{scopeName}的 {network.coverage.included_seeds} 篇起始文献
        {network.mode === "neighbors" ? "及其库内一跳邻居" : "之间的关系"}
        ，已读取 {network.coverage.pages} 页引用，显示 {network.nodes.length}{" "}
        个节点、{network.edges.length} 条已确认关系。
      </p>
      <p className="muted">
        引用来自已保存的元数据关系，不要求 PDF 已解析或分析。
        {network.coverage.truncation.length
          ? "本次显示已达到读取或图规模上限；这不是全库引用图。"
          : "当前范围以外的关系未在这里全部展示。"}
      </p>
      {!network.edges.length ? (
        <EmptyState
          title="此范围暂未显示引用连线"
          description="未找到当前范围内的关系，不表示全库没有引用。可选择包含一跳邻居或其他文献范围。"
        />
      ) : (
        <svg
          className="citation-map"
          viewBox="0 0 800 500"
          role="img"
          aria-label="库内引用网络"
        >
          {network.edges.map((edge) => {
            const source = points.get(edge.source),
              target = points.get(edge.target);
            return source && target ? (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
              />
            ) : null;
          })}
          {network.nodes.map((node, index) => {
            const point = points.get(node.item.literature.literature_id)!;
            return (
              <g
                key={node.item.literature.literature_id}
                tabIndex={0}
                role="button"
                aria-label={`打开 ${paperTitle(node.item)}`}
                onClick={() =>
                  shell.openPaper(
                    node.item.literature.literature_id,
                    "pdf",
                    undefined,
                    paperTitle(node.item),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    shell.openPaper(
                      node.item.literature.literature_id,
                      "pdf",
                      undefined,
                      paperTitle(node.item),
                    );
                  }
                }}
              >
                <circle cx={point.x} cy={point.y} r={node.in_scope ? 7 : 5} />
                <text x={point.x + 11} y={point.y + 5}>
                  {index + 1}
                </text>
                <title>{paperTitle(node.item)}</title>
              </g>
            );
          })}
        </svg>
      )}
      <ol className="citation-papers">
        {network.nodes.map((node) => (
          <li key={node.item.literature.literature_id}>
            <Button
              variant="text"
              onPress={() =>
                shell.openPaper(
                  node.item.literature.literature_id,
                  "pdf",
                  undefined,
                  paperTitle(node.item),
                )
              }
            >
              <RichTitle parts={paperTitleParts(node.item)} />
            </Button>
            {!node.in_scope && <span className="muted">库内邻居</span>}
            <Button
              variant="text"
              size="compact"
              onPress={() => onCenter(node.item)}
            >
              以这篇为中心
            </Button>
          </li>
        ))}
      </ol>
      <TechDetails>
        <pre>{JSON.stringify(network.coverage, null, 2)}</pre>
      </TechDetails>
    </div>
  );
}
