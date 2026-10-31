import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  parseTag,
  parseTagListItem,
  parseTagAssignment,
  parseDocumentReadResult,
  type TagAssignmentItem,
} from "@sciretriever/contracts";
import {
  Button,
  ErrorNotice,
  Select,
  Skeleton,
  TextField,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import { errorMessage } from "../../strings.js";
export function Assignment({ id }: { id: string }) {
  const api = useApi(),
    action = useArchiveAction(),
    [search, setSearch] = useState(""),
    [tag, setTag] = useState(""),
    [segment, setSegment] = useState(""),
    [reason, setReason] = useState("");
  const assignment = useQuery({
    queryKey: ["tags", "assignment", id],
    queryFn: async ({ signal }) => {
      const a = await archiveQuery(
        api,
        "tags",
        { operation: "assignment", request: { literature_id: id } },
        signal,
      );
      return a ? parseTagAssignment(a) : null;
    },
  });
  const state = useQuery({
    queryKey: ["tags", "state"],
    queryFn: async ({ signal }) =>
      record(
        await archiveQuery(
          api,
          "tags",
          { operation: "state", request: {} },
          signal,
        ),
        "vocabulary state",
      ),
  });
  const vocabulary = useQuery({
    queryKey: ["tags", "assignment-options", search],
    queryFn: async ({ signal }) =>
      rows(
        await archiveQuery(
          api,
          "tags",
          {
            operation: "list",
            request: { query: search, limit: 100, status: "active" },
          },
          signal,
        ),
      ).map(parseTagListItem),
  });
  const docs = useQuery({
    queryKey: ["document", "tag-source", id],
    queryFn: async ({ signal }) => {
      const state = record(
          await archiveQuery(
            api,
            "archive",
            { operation: "status", request: { literature_id: id } },
            signal,
          ),
          "archive",
        ),
        part = rows(state, "parts").find((p) => p.part === "main");
      if (!part?.document_version_id) return null;
      const request = {
        document_version_id: String(part.document_version_id),
        section_id: null,
        cursor: null,
        limit: 100,
      };
      return parseDocumentReadResult(
        "segments",
        (await api.query("document-segments", request, signal)).result,
        request,
      );
    },
  });
  const excerpt = useQuery({
    queryKey: [
      "document",
      "tag-excerpt",
      docs.data?.document.document_version_id,
      segment,
    ],
    enabled: !!segment && !!docs.data,
    queryFn: async ({ signal }) => {
      const request = {
        document_version_id: docs.data!.document.document_version_id,
        selector: { kind: "segment" as const, segment_id: segment },
        max_bytes: 4096,
        continuation: null,
      };
      return parseDocumentReadResult(
        "slice",
        (await api.query("document-slice", request, signal)).result,
        request,
      );
    },
  });
  const items = assignment.data?.items ?? [],
    max = Number(state.data?.max_per_literature ?? 6),
    names = new Map(
      vocabulary.data?.map((t) => [t.tag_id, t.name_zh || t.name_en]),
    );
  const selectedNames = useQuery({
    queryKey: ["tags", "assignment-names", items.map((i) => i.tag_id)],
    queryFn: async ({ signal }) =>
      new Map(
        await Promise.all(
          items.map(async (item) => {
            const t = record(
              await archiveQuery(
                api,
                "tags",
                { operation: "show", request: { tag_id: item.tag_id } },
                signal,
              ),
              "tag",
            );
            const tag = parseTag(t.tag);
            return [tag.tag_id, tag.name_zh || tag.name_en] as const;
          }),
        ),
      ),
  });
  const save = (values: readonly TagAssignmentItem[]) =>
    action.mutate({
      name: "tags",
      request: {
        operation: "assign",
        request: {
          literature_id: id,
          items: values.map((item, index) => ({
            ...item,
            rank: index + 1,
            origin: "manual",
            locked: true,
          })),
          expected_revision: assignment.data?.revision ?? 0,
          expected_version: state.data?.version,
          reason: reason.trim() || "人工调整文献标签",
          model: null,
        },
      },
    });
  if (assignment.isPending) return <Skeleton label="正在读取文献标签" />;
  return (
    <section aria-label="文献标签编辑">
      <h3>文献标签</h3>
      <p className="ui-description">
        第一个是主标签，最多 {max} 个；人工修改后锁定。自动处理不会覆盖。
      </p>
      {action.error || assignment.error || docs.error || vocabulary.error ? (
        <ErrorNotice
          message={errorMessage(
            action.error ?? assignment.error ?? docs.error ?? vocabulary.error,
          )}
        />
      ) : null}
      <ol>
        {items.map((item, index) => (
          <li key={item.tag_id}>
            {selectedNames.data?.get(item.tag_id) ??
              names.get(item.tag_id) ??
              "正在读取标签…"}
            {index === 0 ? " · 主标签" : ""}
            {item.locked ? " · 已锁定" : ""}
            <div className="form-actions">
              <Button
                variant="text"
                size="compact"
                isDisabled={index === 0 || action.isPending}
                onPress={() => {
                  const next = [...items];
                  [next[index - 1], next[index]] = [
                    next[index]!,
                    next[index - 1]!,
                  ];
                  save(next);
                }}
              >
                上移
              </Button>
              <Button
                variant="text"
                size="compact"
                isDisabled={index === items.length - 1 || action.isPending}
                onPress={() => {
                  const next = [...items];
                  [next[index], next[index + 1]] = [
                    next[index + 1]!,
                    next[index]!,
                  ];
                  save(next);
                }}
              >
                下移
              </Button>
              <Button
                variant="text"
                size="compact"
                isDisabled={action.isPending}
                onPress={() => save(items.filter((i) => i !== item))}
              >
                移除
              </Button>
              <Button
                variant="text"
                size="compact"
                isDisabled={action.isPending}
                onPress={() =>
                  action.mutate({
                    name: "tags",
                    request: {
                      operation: "lock",
                      request: {
                        literature_id: id,
                        tag_id: item.tag_id,
                        locked: !item.locked,
                        expected_revision: assignment.data?.revision,
                      },
                    },
                  })
                }
              >
                {item.locked ? "解锁" : "锁定"}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <TextField label="搜索已有标签" value={search} onChange={setSearch} />
      <Select
        label="要添加的标签"
        value={tag}
        onChange={setTag}
        options={[
          { value: "", label: "选择标签" },
          ...(vocabulary.data ?? [])
            .filter((t) => !items.some((i) => i.tag_id === t.tag_id))
            .map((t) => ({ value: t.tag_id, label: t.name_zh || t.name_en })),
        ]}
      />
      <Select
        label="支持该标签的原文片段"
        value={segment}
        onChange={setSegment}
        options={[
          { value: "", label: "先选择并核对原文证据" },
          ...(docs.data?.segments ?? []).map((s, index) => ({
            value: s.segment_id,
            label: `片段 ${index + 1}${s.page ? ` · 第 ${s.page} 页` : ""}`,
          })),
        ]}
      />
      {excerpt.data ? (
        <blockquote>
          {excerpt.data.text}
          {excerpt.data.truncated ? "…" : ""}
        </blockquote>
      ) : null}
      {excerpt.error ? (
        <ErrorNotice message={errorMessage(excerpt.error)} />
      ) : null}
      <TextField
        label="标签理由"
        width="long"
        value={reason}
        onChange={setReason}
      />
      <Button
        isDisabled={
          !tag ||
          !segment ||
          !reason.trim() ||
          !excerpt.data ||
          items.length >= max ||
          action.isPending
        }
        onPress={() =>
          save([
            ...items,
            {
              tag_id: tag,
              rank: items.length + 1,
              reason,
              evidence: [
                {
                  document_version_id: docs.data!.document.document_version_id,
                  segment_ids: [segment],
                },
              ],
              origin: "manual",
              locked: true,
            },
          ])
        }
      >
        添加并锁定
      </Button>
      {!docs.data ? <p>需要已有校订稿才能选择标签的支持证据。</p> : null}
      <Button
        variant="text"
        onPress={() => navigate({ view: "tags", literature: null })}
      >
        到词表创建有定义的新标签
      </Button>
    </section>
  );
}
