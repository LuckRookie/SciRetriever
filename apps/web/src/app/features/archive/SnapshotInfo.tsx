import { folderPaths, useFolders } from "../library/Folders.js";
import { useQuery } from "@tanstack/react-query";
import { parseSnapshotDefinition } from "@sciretriever/contracts";
import { useApi } from "../../data/query.js";
import { RichTitle } from "../../components/index.js";
import { paperTitleParts, readLiterature } from "../../data/library.js";
import { statusLabels } from "../../strings.js";

export function PaperName({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
  });
  return (
    <span>
      {query.data ? (
        <RichTitle parts={paperTitleParts(query.data)} />
      ) : query.error ? (
        "文献标题暂不可读"
      ) : (
        "正在读取标题…"
      )}
    </span>
  );
}

const labels: Record<string, string> = {
  text: "关键词",
  title: "标题",
  author: "作者",
  author_orcids: "作者 ORCID",
  identifiers: "标识符",
  publication_year_from: "起始年份",
  publication_year_to: "截止年份",
  venue: "期刊或会议",
  publisher: "出版商",
  publication_forms: "出版形式",
  article_kinds: "文章性质",
  languages: "语言",
  keywords: "关键词",
  version_roles: "版本类型",
  statuses: "材料状态",
  missing_steps: "待完成步骤",
  needs_manual_pdf: "无法获取 PDF",
  discovery_run_ids: "发现批次",
  tags: "标签",
  folder: "文件夹",
  recently_opened: "最近阅读",
};
export function SnapshotDefinition({ value }: { value: unknown }) {
  const definition = parseSnapshotDefinition(value);
  const folders = useFolders();
  if (definition.kind === "literatures")
    return (
      <p>
        生成条件：手动选择 {definition.literature_ids.length}{" "}
        篇文献，固定其中的就绪成员。
      </p>
    );
  const filters = Object.entries(definition.query).filter(
    ([, v]) =>
      v !== null &&
      v !== undefined &&
      v !== "" &&
      v !== false &&
      (!Array.isArray(v) || v.length),
  );
  return (
    <div aria-label="快照生成条件">
      <strong>生成条件</strong>
      {filters.length ? (
        <dl className="ui-definition-list">
          {filters.map(([key, value]) => (
            <div key={key}>
              <dt>{labels[key] ?? "筛选条件"}</dt>
              <dd>
                {key === "folder" && definition.query.folder
                  ? `${
                      folderPaths(folders.data?.items ?? []).find(
                        (path) => path.id === definition.query.folder!.id,
                      )?.label ?? "已删除的文件夹"
                    }${definition.query.folder.include_descendants ? "（含子文件夹）" : "（只看本层）"}`
                  : key === "recently_opened"
                    ? "最近 30 天打开过的文献"
                    : key === "identifiers"
                      ? definition.query.identifiers
                          .map((i) => `${i.namespace}: ${i.value}`)
                          .join("、")
                      : key === "tags"
                        ? `${definition.query.tags?.mode === "primary" ? "主标签" : "任意标签"} · ${definition.query.tags?.ids.length ?? 0} 个`
                        : Array.isArray(value)
                          ? value
                              .map((v) => statusLabels[String(v)] ?? String(v))
                              .join("、")
                          : typeof value === "boolean"
                            ? value
                              ? "是"
                              : "否"
                            : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>全部文献中的就绪成员。</p>
      )}
    </div>
  );
}
