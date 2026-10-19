import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiteratureSearchItem } from "@sciretriever/contracts";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SegmentedControl,
  Tabs,
  TechDetails,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  loadCitationNetwork,
  type CitationNetwork,
} from "../../data/citations.js";
import {
  emptyQuery,
  paperTitle,
  readLiterature,
  searchLibrary,
} from "../../data/library.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage, statusLabels } from "../../strings.js";
import "./insights.css";

export default function Insights() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const [tab, setTab] = useState("stats"),
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
    const group = (values: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const value of values)
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts]
        .sort((a, b) =>
          a[0] === "未提供" ? 1 : b[0] === "未提供" ? -1 : b[1] - a[1],
        )
        .slice(0, 12)
        .map(([label, count]) => ({ label, count }));
    };
    return [
      {
        id: "year",
        title: "年份分布",
        rows: group(
          items.map((item) =>
            String(item.literature.metadata.publication_year ?? "未提供"),
          ),
        ),
      },
      {
        id: "tag",
        title: "元数据关键词",
        rows: group(
          items.flatMap((item) => [
            ...new Set(item.literature.metadata.keywords),
          ]),
        ),
      },
      {
        id: "venue",
        title: "期刊",
        rows: group(
          items.map((item) => item.literature.metadata.venue ?? "未提供"),
        ),
      },
      {
        id: "state",
        title: "材料状态",
        rows: group(
          items.map((item) =>
            item.needs_manual_pdf
              ? "无法获取"
              : (statusLabels[item.literature.status] ?? "未提供"),
          ),
        ),
      },
    ];
  }, [papers.data]);
  return (
    <section className="insights-page">
      <PageHeader
        title="洞察"
        description="查看已有文献的分布和库内引用关系，不推断缺失事实。"
      />
      <Tabs
        label="洞察视图"
        value={tab}
        onChange={setTab}
        items={[
          { id: "stats", label: "统计" },
          { id: "network", label: "引用网络" },
        ]}
      />
      <p>
        范围：{scopeName}
        {!all && (selection || scopeName !== "全部文献库") && (
          <Button
            variant="text"
            onPress={() => {
              setCenter(null);
              navigate({ view: "ins", scope: "all" });
            }}
          >
            查看全部文献库
          </Button>
        )}
      </p>
      {papers.isPending ? (
        <p role="status">正在读取当前范围…</p>
      ) : papers.isError ? (
        <ErrorNotice
          message={errorMessage(papers.error)}
          onRetry={() => void papers.refetch()}
        />
      ) : (
        <>
          <p className="muted">
            基于当前范围 {papers.data.items.length} 篇已读取文献
            {papers.data.total > papers.data.items.length
              ? `（范围共 ${papers.data.total.toLocaleString()} 篇，本次最多读取 1,000 篇）`
              : ""}
            。计数不推断缺失字段。
          </p>
          {tab === "stats" ? (
            <div className="insight-charts">
              {groups.map((group) => (
                <Distribution
                  key={group.id}
                  {...group}
                  onSelect={(label) => apply(group.id, label)}
                />
              ))}
            </div>
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
function Distribution({
  title,
  rows,
  onSelect,
}: {
  title: string;
  rows: { label: string; count: number }[];
  onSelect: (label: string) => void;
}) {
  const [view, setView] = useState("chart"),
    max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="distribution">
      <header>
        <h2>{title}</h2>
        <SegmentedControl
          label={`${title}展示`}
          value={view}
          onChange={setView}
          items={[
            { id: "chart", label: "图表" },
            { id: "table", label: "表格" },
          ]}
        />
      </header>
      {view === "table" ? (
        <DataTable
          label={title}
          rows={rows}
          getRowId={(row) => row.label}
          columns={[
            { id: "label", header: "分类", value: (row) => row.label },
            { id: "count", header: "篇数", value: (row) => row.count },
          ]}
        />
      ) : rows.length ? (
        <div className="distribution-bars">
          {rows.map((row) => (
            <button
              className="distribution-bar"
              key={row.label}
              title={`${row.label}：${row.count} 篇`}
              onClick={() => onSelect(row.label)}
              data-missing={row.label === "未提供" || undefined}
            >
              <span>{row.label}</span>
              <span className="distribution-track">
                <i style={{ transform: `scaleX(${row.count / max})` }} />
              </span>
              <b>{row.count}</b>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">尚未提供这类元数据。</p>
      )}
    </section>
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
              {paperTitle(node.item)}
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
