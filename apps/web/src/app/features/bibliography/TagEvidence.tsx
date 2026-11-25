import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  parseDocumentReadResult,
  parseTagAssignmentDetail,
  type LiteratureSearchItem,
  type TagAssignmentDetailItem,
} from "@sciretriever/contracts";
import { Button, ErrorNotice, Skeleton } from "../../components/index.js";
import { archiveQuery } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";

type Tag = NonNullable<LiteratureSearchItem["tags"]>[number];
/**
 * Who put a tag there, in the page's words. “人工” covers a tag a person
 * added and one a person kept while editing or locking: the data does not
 * tell the two apart.
 */
const ORIGINS: Record<NonNullable<Tag["origin"]>, string> = {
  auto: "AI 按全文标注",
  backfill: "AI 按题名与摘要补标",
  manual: "人工",
};

/**
 * The paper's tags, who put them there, and on request the reason and the
 * passage each one rests on.
 */
export function BibliographyTags({ item }: { item: LiteratureSearchItem }) {
  const [open, setOpen] = useState(false);
  const tags = item.tags ?? [];
  const origins = [
    ...new Set(tags.flatMap((tag) => (tag.origin ? [tag.origin] : []))),
  ];
  return (
    <>
      <div className="bibliography-tags" role="group" aria-label="标签">
        <span>标签</span>
        {tags.map((tag) => (
          <span
            key={tag.tag_id}
            className={tag.rank === 1 ? "paper-tag primary" : "paper-tag"}
            title={tag.origin ? ORIGINS[tag.origin] : undefined}
          >
            {tag.name}
          </span>
        ))}
        {origins.length ? (
          <span className="bibliography-tag-origin">
            {origins.map((origin) => ORIGINS[origin]).join("、")}
            <Button
              variant="text"
              size="compact"
              aria-expanded={open}
              onPress={() => setOpen(!open)}
            >
              依据
            </Button>
          </span>
        ) : null}
      </div>
      {open ? <TagReasons item={item} /> : null}
    </>
  );
}

function TagReasons({ item }: { item: LiteratureSearchItem }) {
  const api = useApi(),
    id = item.literature.literature_id;
  const detail = useQuery({
    queryKey: ["tags", "assignment-detail", id],
    queryFn: async ({ signal }) =>
      parseTagAssignmentDetail(
        await archiveQuery(
          api,
          "tags",
          { operation: "assignment-detail", request: { literature_id: id } },
          signal,
        ),
      ),
  });
  const names = new Map((item.tags ?? []).map((t) => [t.tag_id, t.name]));
  if (detail.error) return <ErrorNotice message={errorMessage(detail.error)} />;
  if (!detail.data) return <Skeleton label="正在读取标签依据" rows={2} />;
  if (!detail.data.items.length)
    return <p className="bibliography-note">这篇文献没有标签依据。</p>;
  return (
    <ul className="bibliography-tag-reasons" aria-label="标签依据">
      {detail.data.items.map((tag) => (
        <li key={tag.tag_id}>
          <p>
            <b>{names.get(tag.tag_id) ?? tag.tag_id}</b>
            <span className="bibliography-note">
              {ORIGINS[tag.origin]}
              {tag.locked ? " · 已锁定" : ""}
            </span>
          </p>
          {tag.reason ? <p>{tag.reason}</p> : null}
          <TagPassage tag={tag} />
        </li>
      ))}
    </ul>
  );
}

/** The first passage a tag cites, read from the full text it points to. */
function TagPassage({ tag }: { tag: TagAssignmentDetailItem }) {
  const api = useApi();
  const first = tag.evidence[0],
    segment = first?.segment_ids[0];
  const count = tag.evidence.reduce((n, e) => n + e.segment_ids.length, 0);
  const excerpt = useQuery({
    queryKey: ["document", "tag-excerpt", first?.document_version_id, segment],
    enabled: !!first && !!segment,
    retry: false,
    queryFn: async ({ signal }) => {
      const request = {
        document_version_id: first!.document_version_id,
        selector: { kind: "segment" as const, segment_id: segment! },
        max_bytes: 1024,
        continuation: null,
      };
      return parseDocumentReadResult(
        "slice",
        (await api.query("document-slice", request, signal)).result,
        request,
      );
    },
  });
  if (!first || !segment) return null;
  return (
    <>
      {excerpt.data ? (
        <blockquote>
          {excerpt.data.text}
          {excerpt.data.truncated ? "…" : ""}
        </blockquote>
      ) : excerpt.error ? (
        <p className="bibliography-note">依据的原文片段读不到。</p>
      ) : null}
      <p className="bibliography-note">
        {count > 1 ? `共引用 ${count} 处原文，这里是第一处。` : ""}
        {tag.evidence_stale ? "依据来自较早的全文版本。" : ""}
      </p>
    </>
  );
}
