import { ContractValidationError } from "./index.js";
export interface DocumentUtf8Range {
  readonly start_utf8: number;
  readonly end_utf8: number;
}
/** Deterministic presentation metadata for ordinary Markdown; page and grid indices are zero based. */
export interface DocumentLayout {
  readonly schema_version: 1;
  readonly article_info: readonly DocumentUtf8Range[];
  readonly figure_groups: readonly {
    readonly group_id: string;
    readonly kind: "figure" | "scheme" | "table";
    readonly objects: readonly (DocumentUtf8Range & {
      readonly segment_id: string;
      readonly row: number;
      readonly column: number;
    })[];
    readonly captions: readonly (DocumentUtf8Range & {
      readonly segment_id: string;
    })[];
    /** Table notes set right below the table (ADR 0074 §2); absent when there are none. */
    readonly notes?: readonly (DocumentUtf8Range & {
      readonly segment_id: string;
    })[];
    readonly rows: readonly number[];
  }[];
  readonly footnotes: readonly (DocumentUtf8Range & {
    readonly segment_id: string;
    readonly page_index: number;
  })[];
}
export function parseDocumentLayout(
  value: unknown,
  maxBytes = 8 * 1024 * 1024,
  pageCount = 10000,
): DocumentLayout {
  const fail = (): never => {
    throw new ContractValidationError();
  };
  const obj = (v: unknown, keys: string[]) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).sort().join() !== keys.sort().join()
    )
      fail();
    return v as Record<string, unknown>;
  };
  const n = (v: unknown, min: number, max: number): number => {
    if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail();
    return Number(v);
  };
  const id = (v: unknown): string => {
    if (typeof v !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(v))
      fail();
    return v as string;
  };
  const list = <T>(v: unknown, f: (v: unknown) => T): T[] => {
    if (!Array.isArray(v) || v.length > 100000) fail();
    return (v as unknown[]).map(f);
  };
  const range = (r: Record<string, unknown>) => {
    const start_utf8 = n(r.start_utf8, 0, maxBytes - 1);
    return { start_utf8, end_utf8: n(r.end_utf8, start_utf8 + 1, maxBytes) };
  };
  const v = obj(value, [
    "schema_version",
    "article_info",
    "figure_groups",
    "footnotes",
  ]);
  if (v.schema_version !== 1) fail();
  const seen = new Set<string>(),
    groupIds = new Set<string>();
  const segment = (r: Record<string, unknown>) => {
    const segment_id = id(r.segment_id);
    if (seen.has(segment_id)) fail();
    seen.add(segment_id);
    return { segment_id, ...range(r) };
  };
  const article_info = list(v.article_info, (x) =>
    range(obj(x, ["start_utf8", "end_utf8"])),
  );
  if (
    article_info.some(
      (r, i) => i > 0 && r.start_utf8 < article_info[i - 1]!.end_utf8,
    )
  )
    fail();
  const figure_groups = list(
    v.figure_groups,
    (x): DocumentLayout["figure_groups"][number] => {
      const g = obj(x, [
          "group_id",
          "kind",
          "objects",
          "captions",
          "rows",
          ...(x && typeof x === "object" && "notes" in x ? ["notes"] : []),
        ]),
        group_id = id(g.group_id);
      if (
        groupIds.has(group_id) ||
        !["figure", "scheme", "table"].includes(String(g.kind))
      )
        fail();
      groupIds.add(group_id);
      const rows = list(g.rows, (x) => n(x, 1, 100000));
      const slots = new Set<string>();
      const objects = list(g.objects, (x) => {
        const r = obj(x, [
          "segment_id",
          "start_utf8",
          "end_utf8",
          "row",
          "column",
        ]);
        const row = n(r.row, 0, rows.length - 1),
          column = n(r.column, 0, rows[row]! - 1),
          key = `${row}:${column}`;
        if (slots.has(key)) fail();
        slots.add(key);
        return { ...segment(r), row, column };
      });
      if (!objects.length || rows.reduce((a, b) => a + b, 0) !== objects.length)
        fail();
      const captions = list(g.captions, (x) =>
        segment(obj(x, ["segment_id", "start_utf8", "end_utf8"])),
      );
      // Only a table has notes, and a present list is never empty.
      const notes =
        g.notes === undefined
          ? undefined
          : list(g.notes, (x) =>
              segment(obj(x, ["segment_id", "start_utf8", "end_utf8"])),
            );
      if (notes && (!notes.length || g.kind !== "table")) fail();
      return {
        group_id,
        kind: g.kind as "figure" | "scheme" | "table",
        objects,
        captions,
        ...(notes ? { notes } : {}),
        rows,
      };
    },
  );
  const footnotes = list(v.footnotes, (x) => {
    const r = obj(x, ["segment_id", "start_utf8", "end_utf8", "page_index"]);
    return { ...segment(r), page_index: n(r.page_index, 0, pageCount - 1) };
  });
  return { schema_version: 1, article_info, figure_groups, footnotes };
}
