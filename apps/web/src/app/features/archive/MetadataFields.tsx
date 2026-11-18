import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ARTICLE_KIND_LABELS,
  PUBLICATION_FORM_LABELS,
  METADATA_FIELDS,
  parseLiteratureMetadata,
  parseMetadataFieldState,
  type LiteratureMetadata,
  type MetadataField,
  type MetadataFieldState,
} from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Select,
  Skeleton,
  TextArea,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { archiveQuery, useArchiveAction } from "../../data/archive.js";
import { record } from "../../data/wire.js";
import { archiveStrings, errorMessage } from "../../strings.js";
const names: Record<MetadataField, string> = {
  title: "标题",
  authors: "作者",
  abstract: "摘要",
  publication_date: "发表日期",
  publication_year: "发表年份",
  publication_form: "出版形式",
  article_kind: "文章性质",
  language: "语言",
  venue: "期刊／会议",
  publisher: "出版方",
  volume: "卷",
  issue: "期",
  pages: "页码",
  identifiers: "标识符",
  keywords: "关键词",
};
function text(
  field: MetadataField,
  value: LiteratureMetadata[MetadataField],
): string {
  if (field === "authors")
    return (value as LiteratureMetadata["authors"])
      .map((a) => a.display_name)
      .join("\n");
  if (field === "identifiers")
    return (value as LiteratureMetadata["identifiers"])
      .map((i) => `${i.namespace}: ${i.value}`)
      .join("\n");
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}
function parseValue(
  field: MetadataField,
  value: string,
  current: LiteratureMetadata,
): LiteratureMetadata[MetadataField] {
  const lines = value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  if (field === "authors")
    return lines.map(
      (name) =>
        current.authors.find((a) => a.display_name === name) ?? {
          kind: "person" as const,
          display_name: name,
          given_name: null,
          family_name: null,
          orcid: null,
          affiliations: [],
        },
    );
  if (field === "identifiers")
    return lines.map((line) => {
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("标识符格式应为 doi: 10.…，每行一个。");
      return {
        namespace: line.slice(0, colon).trim(),
        value: line.slice(colon + 1).trim(),
      };
    });
  if (field === "keywords") return lines;
  if (field === "publication_year") return value ? Number(value) : null;
  return value.trim() || null;
}
export function MetadataFields({ id }: { id: string }) {
  const api = useApi(),
    action = useArchiveAction();
  const [editing, setEditing] = useState<MetadataField | null>(null),
    [draft, setDraft] = useState(""),
    [failure, setFailure] = useState("");
  const query = useQuery({
    queryKey: ["metadata", id],
    queryFn: async ({ signal }) => {
      const r = record(
        await archiveQuery(
          api,
          "metadata-fields",
          { literature_id: id },
          signal,
        ),
        "metadata",
      );
      if (
        !Array.isArray(r.fields) ||
        !Number.isSafeInteger(r.metadata_revision)
      )
        throw new Error("字段回执无效");
      return {
        metadata: parseLiteratureMetadata(r.metadata),
        revision: r.metadata_revision as number,
        fields: r.fields.map(parseMetadataFieldState),
      };
    },
  });
  if (query.isPending) return <Skeleton label="正在读取字段来源" />;
  if (query.error)
    return (
      <ErrorNotice
        message={errorMessage(query.error)}
        onRetry={() => query.refetch().then(() => {})}
      />
    );
  const data = query.data!;
  const save = async (field: MetadataField, unlock = false) => {
    setFailure("");
    try {
      const value = unlock ? null : parseValue(field, draft, data.metadata);
      if (!unlock)
        parseLiteratureMetadata({ ...data.metadata, [field]: value });
      await action.mutateAsync({
        name: "metadata-edit",
        request: {
          literature_id: id,
          expected_revision: data.revision,
          set: unlock ? [] : [{ field, value }],
          unlock: unlock ? [field] : [],
        },
      });
      setEditing(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };
  const source = (state: MetadataFieldState | undefined) =>
    state?.evidence.source === "proofread"
      ? "已校对的全文"
      : state?.evidence.source === "manual"
        ? "人工编辑"
        : state
          ? "元数据来源"
          : "尚无记录";
  return (
    <section aria-label="元数据字段与来源" className="archive-fields">
      <h3>{archiveStrings.metadata}</h3>
      <p className="ui-description">
        编辑会锁定字段，自动生成全文时保留你的修改；解锁后允许重新提议。
      </p>
      {failure || action.error ? (
        <ErrorNotice message={failure || errorMessage(action.error)} />
      ) : null}
      {METADATA_FIELDS.map((field) => {
        const state = data.fields.find((s) => s.field === field),
          options =
            field === "publication_form"
              ? PUBLICATION_FORM_LABELS
              : field === "article_kind"
                ? ARTICLE_KIND_LABELS
                : null;
        return (
          <div className="archive-field" key={field}>
            <div>
              <strong>{names[field]}</strong>
              <span className="ui-description">
                {source(state)}
                {state?.locked ? " · 已锁定" : ""}
              </span>
            </div>
            {editing === field ? (
              <>
                {options ? (
                  <Select
                    label={names[field]}
                    value={draft}
                    onChange={setDraft}
                    options={[
                      { value: "", label: "未指定" },
                      ...Object.entries(options).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ]}
                  />
                ) : (
                  <TextArea
                    label={names[field]}
                    value={draft}
                    onChange={setDraft}
                    description={
                      field === "authors" || field === "keywords"
                        ? "每行一个；已有作者的其它信息会保留。"
                        : field === "identifiers"
                          ? "每行格式：doi: 10.…"
                          : ""
                    }
                  />
                )}
                <div className="form-actions">
                  <Button onPress={() => setEditing(null)}>取消</Button>
                  <Button
                    isPending={action.isPending}
                    onPress={() => void save(field)}
                  >
                    保存并锁定
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {options && data.metadata[field]
                    ? (options[
                        String(data.metadata[field]) as keyof typeof options
                      ] ?? text(field, data.metadata[field]))
                    : text(field, data.metadata[field]) || "未提供"}
                </p>
                <Button
                  variant="text"
                  size="compact"
                  onPress={() => {
                    setEditing(field);
                    setDraft(text(field, data.metadata[field]));
                  }}
                >
                  编辑{names[field]}
                </Button>
                {state?.locked ? (
                  <Button
                    variant="text"
                    size="compact"
                    isDisabled={action.isPending}
                    onPress={() => void save(field, true)}
                  >
                    解锁{names[field]}
                  </Button>
                ) : null}
              </>
            )}
            {state?.conflict ? (
              <Disclosure title={`查看${names[field]}的冲突候选`}>
                {state.conflicts.map((c, i) => (
                  <p key={i}>
                    {text(field, c.value)} ·{" "}
                    {c.evidence.source === "proofread"
                      ? "已校对的全文"
                      : "元数据来源"}
                  </p>
                ))}
              </Disclosure>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
