import { useQuery } from "@tanstack/react-query";
import {
  MAIN_SECTION_ROLES,
  SUPPLEMENTARY_SECTION_ROLES,
  parseStructureAnnotation,
  parseDocumentReadResult,
} from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Select,
  Skeleton,
} from "../../components/index.js";
import { archiveQuery, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import { errorMessage, sectionRoleNames as roles } from "../../strings.js";
export function StructurePanel({
  id,
  document,
}: {
  id: string;
  document: string;
}) {
  const api = useApi(),
    action = useArchiveAction();
  const query = useQuery({
    queryKey: ["document", "annotation", document],
    queryFn: async ({ signal }) => {
      let continuation: string | null = null,
        annotation_id: string | null = null,
        text = "";
      do {
        const r = record(
          await archiveQuery(
            api,
            "document-annotation",
            {
              document_version_id: document,
              annotation_id,
              field: "all",
              max_bytes: 65536,
              continuation,
            },
            signal,
          ),
          "annotation",
        );
        if (typeof r.text !== "string" || typeof r.annotation_id !== "string")
          throw new Error("章节注释回执无效");
        if (annotation_id && annotation_id !== r.annotation_id)
          throw new Error("章节版本变化");
        annotation_id = r.annotation_id;
        text += r.text;
        if (text.length > 16 * 1024 * 1024)
          throw new Error("章节数据过大，请通过 CLI 分页读取");
        continuation =
          typeof r.continuation === "string" ? r.continuation : null;
      } while (continuation);
      return parseStructureAnnotation(JSON.parse(text));
    },
  });
  const outline = useQuery({
    queryKey: ["document", "role-titles", document],
    queryFn: async ({ signal }) => {
      const request = {
        document_version_id: document,
        cursor: null,
        limit: 200,
      };
      return parseDocumentReadResult(
        "outline",
        (await api.query("document-outline", request, signal)).result,
        request,
      );
    },
  });
  if (query.isPending) return <Skeleton label="正在读取章节角色" />;
  if (query.error)
    return (
      <ErrorNotice
        message={errorMessage(query.error)}
        onRetry={() => query.refetch().then(() => {})}
      />
    );
  const a = query.data!,
    titles = new Map(
      outline.data?.sections.map((s) => [s.section_id, s.title]),
    );
  return (
    <section aria-label="章节、图表与参考文献">
      <h3>章节角色</h3>
      {action.error ? (
        <ErrorNotice message={errorMessage(action.error)} />
      ) : null}
      <p className="ui-description">
        修正角色会锁定该章节，并将读取此部分的既有结果标为过时。
      </p>
      {a.sections.map((section, index) => (
        <div className="archive-field" key={section.section_id}>
          <Select
            label={titles.get(section.section_id) ?? `章节 ${index + 1}`}
            value={section.role}
            onChange={(role) =>
              action.mutate({
                name: "document-role",
                request: {
                  document_version_id: document,
                  section_id: section.section_id,
                  role,
                  expected_manual_revision: a.manual_revision,
                  actor: api.actor,
                },
              })
            }
            options={(a.part === "main"
              ? MAIN_SECTION_ROLES
              : SUPPLEMENTARY_SECTION_ROLES
            ).map((value) => ({ value, label: roles[value] ?? value }))}
          />
          {section.locked ? (
            <Button
              variant="text"
              size="compact"
              onPress={() =>
                action.mutate({
                  name: "document-role",
                  request: {
                    document_version_id: document,
                    section_id: section.section_id,
                    role: null,
                    expected_manual_revision: a.manual_revision,
                    actor: api.actor,
                  },
                })
              }
            >
              解除角色锁定
            </Button>
          ) : null}
        </div>
      ))}
      <Disclosure title={`图表 · ${a.figures.length}`}>
        {a.figures.map((f, index) => (
          <p key={f.object_segment_id}>
            {f.label ?? `${f.kind} ${index + 1}`} · 第 {f.page + 1} 页
            <Button
              variant="text"
              size="compact"
              onPress={() =>
                navigate({
                  view: "lib",
                  literature: id,
                  reader: "pdf",
                  page: String(f.page + 1),
                })
              }
            >
              定位 PDF
            </Button>
          </p>
        ))}
      </Disclosure>
      <Disclosure title={`原文参考文献 · ${a.references.length}`}>
        {a.references.map((r) => (
          <p key={r.reference_index}>
            {r.reference_index + 1}. {r.text}
            {r.doi ? (
              <Button
                variant="text"
                size="compact"
                onPress={() =>
                  navigate({
                    view: "lib",
                    literature: null,
                    query: JSON.stringify({
                      identifiers: [{ namespace: "doi", value: r.doi }],
                    }),
                  })
                }
              >
                在库中查找
              </Button>
            ) : null}
          </p>
        ))}
      </Disclosure>
    </section>
  );
}
