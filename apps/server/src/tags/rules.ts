import {
  normalizedTagName,
  type Tag,
  type TagAssignmentItem,
  type TagDraft,
} from "@sciretriever/contracts";

export class TagError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, details: Readonly<Record<string, unknown>> = {}) {
    super("tag operation refused");
    this.code = code;
    this.details = details;
    this.name = "TagError";
  }
}
export function tagNames(
  tag: Pick<TagDraft, "name_zh" | "name_en" | "aliases">,
): readonly string[] {
  return [
    ...new Set(
      [tag.name_zh, tag.name_en, ...tag.aliases]
        .filter(Boolean)
        .map(normalizedTagName),
    ),
  ];
}
export function validateCompoundName(
  tag: TagDraft,
  titleAndAbstract?: string,
): void {
  if (tag.kind !== "compound") return;
  const main = [tag.name_zh, tag.name_en].filter(Boolean);
  if (
    main.some(
      (n) =>
        /^(?:compound|化合物)\s*[\dA-Za-z-]+$/iu.test(n) ||
        /^[A-Z][A-Z\d]*(?:-?[A-Z\d]+)*$/u.test(n),
    )
  )
    throw new TagError("tag-compound-name-invalid");
  if (titleAndAbstract !== undefined) {
    const text = normalizedTagName(titleAndAbstract);
    if (!tagNames(tag).some((n) => text.includes(n)))
      throw new TagError("tag-compound-evidence-missing");
  }
}
export function validateTagParent(
  tag: Tag,
  parent: Tag | null,
  hasChildren: boolean,
): void {
  if (tag.parent_id === null) return;
  if (
    !parent ||
    parent.status !== "active" ||
    parent.parent_id !== null ||
    parent.tag_id === tag.tag_id ||
    hasChildren
  )
    throw new TagError("tag-hierarchy-invalid");
}
export function orderedTagItems(
  proposed: readonly TagAssignmentItem[],
  previous: readonly TagAssignmentItem[],
  tags: ReadonlyMap<string, Tag>,
  max: number,
  actor: "auto" | "manual" | "backfill",
): readonly TagAssignmentItem[] {
  if (!proposed.length) throw new TagError("tags-empty");
  if (!Number.isSafeInteger(max) || max < 1 || proposed.length > max)
    throw new TagError("tags-invalid");
  if (
    new Set(proposed.map((i) => i.tag_id)).size !== proposed.length ||
    proposed.some((i, index) => i.rank !== index + 1)
  )
    throw new TagError("tags-invalid");
  for (const item of proposed)
    if (tags.get(item.tag_id)?.status !== "active")
      throw new TagError("tag-unavailable");
  const children = new Set(
    proposed.map((i) => tags.get(i.tag_id)?.parent_id).filter(Boolean),
  );
  const selected = proposed.filter((i) => !children.has(i.tag_id));
  if (actor !== "manual") {
    for (const item of previous.filter((i) => i.locked)) {
      const candidate = selected.findIndex((i) => i.tag_id === item.tag_id);
      if (candidate < 0 || candidate + 1 !== item.rank)
        throw new TagError("tag-assignment-locked");
    }
  }
  return selected.map((item, index) => {
    const old = previous.find((i) => i.tag_id === item.tag_id);
    return actor !== "manual" && old?.locked
      ? old
      : { ...item, rank: index + 1 };
  });
}
export function mergeTagItems(
  items: readonly TagAssignmentItem[],
  source: string,
  target: string,
): readonly TagAssignmentItem[] {
  const result: TagAssignmentItem[] = [];
  for (const item of items) {
    const id = item.tag_id === source ? target : item.tag_id;
    const previous = result.find((i) => i.tag_id === id);
    if (previous) {
      // Preserve all evidence and a lock if the target already occurs later in the ranking.
      const unique = new Map(
        [...previous.evidence, ...item.evidence].map((e) => [
          JSON.stringify(e),
          e,
        ]),
      );
      const index = result.indexOf(previous);
      result[index] = {
        ...previous,
        locked: previous.locked || item.locked,
        evidence: [...unique.values()],
      };
    } else result.push({ ...item, tag_id: id, rank: result.length + 1 });
  }
  return result;
}
