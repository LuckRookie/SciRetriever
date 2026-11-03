import { articleInformationText } from "./preprocess.js";
import type {
  ArchiveTextBundleV2,
  ArchiveSectionRole,
} from "@sciretriever/contracts";
import { arrangementPreview } from "./arrangement.js";
type Node = ReturnType<typeof arrangementPreview>[number];
const noteMark = (s: string) =>
  /^\s*\$?\s*(?:\{\s*\})?\^\s*\{([^}]+)\}|^\s*([*†‡§¶¹²³⁴⁵⁶⁷⁸⁹⁰]+)/u.exec(s);
const key = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/\\dagger/gu, "†")
    .replace(/\\ddagger/gu, "‡")
    .replace(/[\s${}]/gu, "");
const cited = (text: string, mark: string) => {
  for (const m of text.matchAll(
    /\^\s*\{([^}]+)\}|\^([0-9*])|([†‡§¶¹²³⁴⁵⁶⁷⁸⁹⁰]+)/gu,
  ))
    if (
      key(m[1] ?? m[2] ?? m[3] ?? "")
        .split(",")
        .includes(mark)
    )
      return true;
  return false;
};
export function arrangeSourceLayout(bundle: ArchiveTextBundleV2) {
  const snapshot = bundle.arrangement!,
    rows = new Map(bundle.leaves.map((r) => [r.leaf.leaf_id, r]));
  const role = (id: string): ArchiveSectionRole => {
    const d = rows.get(id)!.destination;
    if (d.kind !== "assigned") throw Error("render-dropped");
    return d.target.role;
  };
  const nodes = [...arrangementPreview(snapshot)];
  const firstBody = snapshot.leaves.findIndex((l) =>
    [
      "abstract",
      "introduction",
      "methods",
      "results-discussion",
      "conclusion",
      "additional",
    ].includes(roleOrNull(l.leaf_id) ?? ""),
  );
  function roleOrNull(id: string) {
    return rows.get(id)?.destination.kind === "assigned" ? role(id) : null;
  }
  const authorNote = (id: string) => {
    const row = rows.get(id)!;
    if (row.leaf.type !== "footnote") return false;
    const match = noteMark(row.corrected_text),
      mark = match ? key(match[1] ?? match[2] ?? "") : "";
    if (!mark || mark.includes(",")) return false;
    const citesIn = (roles: readonly string[]) =>
      bundle.leaves.some(
        (r) =>
          r.destination.kind === "assigned" &&
          r.leaf.page_index === 0 &&
          roles.includes(r.destination.target.role) &&
          cited(r.corrected_text, mark),
      );
    return (
      citesIn(["title", "authors"]) &&
      !citesIn([
        "introduction",
        "methods",
        "results-discussion",
        "conclusion",
        "additional",
      ])
    );
  };
  const info = new Set(
    snapshot.leaves
      .filter((l, i) => {
        const text = rows.get(l.leaf_id)!.corrected_text;
        return (
          l.page_index === 0 &&
          roleOrNull(l.leaf_id) === "end-matter" &&
          !/^(?:[■*]\s*)?(?:acknowledg|associated content|conflicts?|data availability|references|funding|author contributions)/iu.test(
            text.trimStart(),
          ) &&
          ((i < firstBody && !["image", "table"].includes(l.type)) ||
            authorNote(l.leaf_id) ||
            articleInformationText(text))
        );
      })
      .map((l) => l.leaf_id),
  );
  const infoNodes = nodes.filter((n) => n.leaf_ids.every((id) => info.has(id)));
  let ordered = nodes.filter((n) => !infoNodes.includes(n));
  let author = -1,
    title = -1;
  ordered.forEach((n, i) => {
    if (role(n.leaf_ids[0]!) === "authors") author = i;
    if (role(n.leaf_ids[0]!) === "title") title = i;
  });
  ordered.splice(Math.max(author, title) + 1, 0, ...infoNodes);
  // A note moves only when an explicit marker is cited on its own page.
  const after = new Map<Node, Node[]>(),
    moved = new Set<Node>();
  for (const note of ordered) {
    const row = rows.get(note.leaf_ids[0]!)!;
    if (row.leaf.type !== "footnote" || info.has(row.leaf.leaf_id)) continue;
    const match = noteMark(row.corrected_text);
    if (!match) continue;
    const mark = key(match[1] ?? match[2] ?? "");
    if (!mark || mark.includes(",")) continue;
    const anchor = ordered.find((n) =>
      n.leaf_ids.some((id) => {
        const r = rows.get(id)!;
        return (
          r.leaf.page_index === row.leaf.page_index &&
          ["text", "list", "reference"].includes(r.leaf.type) &&
          cited(r.corrected_text, mark)
        );
      }),
    );
    if (anchor) {
      const xs = after.get(anchor) ?? [];
      xs.push(note);
      after.set(anchor, xs);
      moved.add(note);
    }
  }
  ordered = ordered
    .filter((n) => !moved.has(n))
    .flatMap((n) => [n, ...(after.get(n) ?? [])]);
  type Group = {
    kind: "figure" | "table" | "scheme";
    objects: string[];
    captions: string[];
    rows: number[];
    positions: Map<string, { row: number; column: number }>;
  };
  const groups: Group[] = [],
    owner = new Map<string, Group>();
  const captionOps = snapshot.operations.filter((o) => o.kind === "caption");
  const objectCaption = new Map(captionOps.map((o) => [o.object_leaf_id, o]));
  for (const op of captionOps) {
    let group = groups.find(
      (g) =>
        g.kind === op.object_kind &&
        g.captions.join() === op.caption_leaf_ids.join(),
    );
    if (!group) {
      group = {
        kind: op.object_kind,
        objects: [],
        captions: [...op.caption_leaf_ids],
        rows: [],
        positions: new Map(),
      };
      groups.push(group);
    }
    group.objects.push(op.object_leaf_id);
    owner.set(op.object_leaf_id, group);
  }
  const objects = snapshot.leaves.filter(
    (l) =>
      roleOrNull(l.leaf_id) !== null && ["image", "table"].includes(l.type),
  );
  const index = new Map(snapshot.leaves.map((l, i) => [l.leaf_id, i]));
  const noTextBetween = (a: string, b: string) =>
    snapshot.leaves
      .slice(
        Math.min(index.get(a)!, index.get(b)!) + 1,
        Math.max(index.get(a)!, index.get(b)!),
      )
      .every(
        (l) =>
          roleOrNull(l.leaf_id) === null ||
          ["image", "table", "caption"].includes(l.type),
      );
  for (const l of objects) {
    if (owner.has(l.leaf_id)) continue;
    const candidates = groups.filter((g) =>
      g.objects.some((id) => {
        const a = rows.get(id)!.leaf,
          ab = a.region,
          bb = l.region;
        if (!ab || !bb || a.type !== l.type || !noTextBetween(id, l.leaf_id))
          return false;
        if (l.type === "table")
          return (
            a.page_index <= l.page_index &&
            l.page_index <= a.page_index + 1 &&
            Math.abs(ab[2] - ab[0] - (bb[2] - bb[0])) <=
              Math.max(ab[2] - ab[0], bb[2] - bb[0]) * 0.12 &&
            Math.abs(ab[0] - bb[0]) < 30 &&
            (a.page_index !== l.page_index ||
              (bb[1] - ab[3] <= 80 && bb[1] >= ab[1]))
          );
        return (
          a.page_index === l.page_index &&
          Math.max(0, ab[0] - bb[2], bb[0] - ab[2]) <= 80 &&
          Math.max(0, ab[1] - bb[3], bb[1] - ab[3]) <= 80
        );
      }),
    );
    if (candidates.length === 1 && !objectCaption.has(l.leaf_id)) {
      candidates[0]!.objects.push(l.leaf_id);
      owner.set(l.leaf_id, candidates[0]!);
    }
  }
  for (const g of groups) {
    g.objects.sort((a, b) => {
      const x = rows.get(a)!.leaf,
        y = rows.get(b)!.leaf;
      return (
        x.page_index - y.page_index ||
        (x.region?.[1] ?? 0) - (y.region?.[1] ?? 0) ||
        (x.region?.[0] ?? 0) - (y.region?.[0] ?? 0)
      );
    });
    const grid: { ids: string[]; page: number; top: number; bottom: number }[] =
      [];
    for (const id of g.objects) {
      const l = rows.get(id)!.leaf,
        b = l.region;
      const r =
        g.kind !== "table" && b
          ? grid.find(
              (r) =>
                r.page === l.page_index &&
                Math.min(r.bottom, b[3]) - Math.max(r.top, b[1]) >=
                  Math.min(r.bottom - r.top, b[3] - b[1]) * 0.5,
            )
          : undefined;
      if (r) r.ids.push(id);
      else
        grid.push({
          ids: [id],
          page: l.page_index,
          top: b?.[1] ?? 0,
          bottom: b?.[3] ?? 0,
        });
    }
    g.objects = [];
    grid.forEach((r, row) => {
      r.ids.sort(
        (a, b) =>
          (rows.get(a)!.leaf.region?.[0] ?? 0) -
          (rows.get(b)!.leaf.region?.[0] ?? 0),
      );
      g.rows.push(r.ids.length);
      r.ids.forEach((id, column) => {
        g.positions.set(id, { row, column });
        g.objects.push(id);
      });
    });
  }
  // Emit shared-caption panels once, then their caption. Markdown stays standard.
  const byId = new Map(
      ordered.flatMap((n) => n.leaf_ids.map((id) => [id, n] as const)),
    ),
    claimed = new Set<Node>(),
    grouped: Node[] = [];
  for (const n of ordered) {
    if (claimed.has(n)) continue;
    const g = n.leaf_ids
      .map((id) => owner.get(id) ?? groups.find((g) => g.captions.includes(id)))
      .find(Boolean);
    if (g) {
      for (const id of [...g.objects, ...g.captions]) {
        const item = byId.get(id);
        if (item && !claimed.has(item)) {
          grouped.push(item);
          claimed.add(item);
        }
      }
    } else {
      grouped.push(n);
      claimed.add(n);
    }
  }
  return { nodes: grouped, article_info: info, groups };
}
/** Numbering wins; recurring PDF styles are used only with consistent nesting. */
export function headingLevels(bundle: ArchiveTextBundleV2) {
  const roots = new Map(bundle.source_blocks.map((b) => [b.root_block_id, b]));
  const headings = bundle.leaves.filter(
    (r) =>
      r.destination.kind === "assigned" &&
      (r.destination.presentation.kind !== "content" ||
        (r.destination.target.role === "title" && r.leaf.type === "title")),
  );
  const levels = new Map<string, number>();
  const body = headings.filter(
    (r) =>
      r.destination.kind === "assigned" &&
      !["title", "authors", "end-matter", "references"].includes(
        r.destination.target.role,
      ),
  );
  const styles = new Map<
    string,
    { size: number; count: number; first: number }
  >();
  const style = (r: (typeof headings)[number]) => {
    const p = roots.get(r.leaf.source.root_block_id)?.pdf_geometry;
    return p
      ? {
          key: `${Math.round(p.font_size * 2) / 2}:${p.font}`,
          size: Math.round(p.font_size * 2) / 2,
        }
      : null;
  };
  body.forEach((r, i) => {
    const st = style(r);
    if (st) {
      const old = styles.get(st.key);
      styles.set(st.key, {
        size: st.size,
        count: (old?.count ?? 0) + 1,
        first: old?.first ?? i,
      });
    }
  });
  const recurring = [...styles]
    .filter(([, s]) => s.count >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[1].first - b[1].first)
    .slice(0, 5);
  const guessed = body.map((r) => {
    const st = style(r);
    if (!st) return 2;
    let rank = recurring.findIndex(([k]) => k === st.key);
    if (rank < 0) rank = recurring.findIndex(([, s]) => s.size <= st.size);
    return 2 + Math.max(0, rank);
  });
  let deeper = 0,
    nested = 0;
  const stack: number[] = [];
  for (const level of guessed) {
    while (stack.length && stack.at(-1)! >= level) stack.pop();
    if (level > 2) {
      deeper++;
      if (stack.at(-1) === level - 1) nested++;
    }
    stack.push(level);
  }
  const reliable =
    body.length >= 3 &&
    body.filter((r) => style(r)).length / body.length >= 0.9 &&
    recurring.length >= 2 &&
    guessed[0] === 2 &&
    deeper > 0 &&
    nested / deeper >= 0.9;
  for (const r of headings) {
    const d = r.destination;
    if (d.kind !== "assigned") continue;
    const numbered = /^\s*(\d+(?:\.\d+)*)(?:\.?\s+|[)．]\s*)\p{L}/u.exec(
      r.corrected_text.replace(/^#{1,6}\s+/u, ""),
    );
    const level =
      d.target.role === "title"
        ? 1
        : ["end-matter", "references"].includes(d.target.role)
          ? 2
          : numbered
            ? Math.min(6, numbered[1]!.split(".").length + 1)
            : reliable
              ? (guessed[body.indexOf(r)] ?? 2)
              : d.presentation.kind === "subheading"
                ? d.presentation.level
                : 2;
    levels.set(r.leaf.leaf_id, level);
  }
  return levels;
}
