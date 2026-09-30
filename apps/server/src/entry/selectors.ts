import type {
  LibraryQuery,
  LibrarySearchPage,
  LiteratureId,
  MetaLiteratureId,
} from "@sciretriever/contracts";
import { parseDiscoveryRunId } from "@sciretriever/contracts";
import type { LiteratureQueryService } from "../literature/query.js";
import { LiteratureNotFoundError } from "../literature/query.js";

export type LiteratureSelector =
  | { readonly kind: "all-pending" }
  | { readonly kind: "discovery-run"; readonly discovery_run_id: string }
  | { readonly kind: "query"; readonly query: LibraryQuery }
  | {
      readonly kind: "meta-literatures";
      readonly meta_literature_ids: readonly MetaLiteratureId[];
    }
  | {
      readonly kind: "literatures";
      readonly literature_ids: readonly LiteratureId[];
    }
  | {
      readonly kind: "import-report";
      readonly meta_literature_ids: readonly MetaLiteratureId[];
    };

const emptyQuery = (): LibraryQuery => ({
  text: null,
  title: null,
  author: null,
  author_orcids: [],
  identifiers: [],
  publication_year_from: null,
  publication_year_to: null,
  venue: null,
  publisher: null,
  document_types: [],
  languages: [],
  keywords: [],
  version_roles: [],
  statuses: [],
  missing_steps: [],
  needs_manual_pdf: null,
  discovery_run_ids: [],
});

function uniqueNonEmpty<T>(values: readonly T[], name: string): readonly T[] {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
  const result = [...new Set(values)];
  if (!result.length) throw new TypeError(`${name} must be non-empty`);
  return result;
}

async function searchAll(
  service: Pick<LiteratureQueryService, "search">,
  query: LibraryQuery,
): Promise<LibrarySearchPage> {
  const page = await service.search({
    query,
    sort: query.text !== null ? "relevance" : "publication-year-desc",
    limit: Number.MAX_SAFE_INTEGER,
    cursor: null,
  });
  if (page.next_cursor !== null || page.items.length !== page.total_count)
    throw new Error("selector snapshot is incomplete");
  return page;
}

type SelectionService = Pick<LiteratureQueryService, "search"> &
  Partial<Pick<LiteratureQueryService, "targetedSnapshot">>;

/**
 * The targets an Entry may treat as an explicit retry that clears the automatic acquisition
 * exhaustion fact before a PDF-requiring goal: only a selector naming concrete Literatures counts.
 * Wide selectors (all-pending/query/discovery-run/meta-literatures/import-report) never clear a
 * fact, not even for the targets they still select (design.md §8, technical/entry.md §5).
 */
export function explicitRetryLiteratureIds(
  selector: LiteratureSelector,
): readonly LiteratureId[] {
  if (!selector || typeof selector !== "object")
    throw new TypeError("selector is invalid");
  if (selector.kind !== "literatures") return Object.freeze([]);
  return Object.freeze([
    ...uniqueNonEmpty(selector.literature_ids, "literature_ids"),
  ]);
}

function selectorQuery(selector: LiteratureSelector): LibraryQuery | null {
  if (!selector || typeof selector !== "object")
    throw new TypeError("selector is invalid");
  if (selector.kind === "all-pending") {
    return {
      ...emptyQuery(),
      statuses: ["UNREVIEWED", "ASSET_READY"],
      // The default database-completion scope skips a Literature that already carries the
      // automatic acquisition exhaustion fact; false matches "no such fact" and never promises
      // that an automatic route can still deliver (technical/model.md §2.5).
      needs_manual_pdf: false,
    };
  }
  if (selector.kind === "discovery-run") {
    if (!selector.discovery_run_id.trim())
      throw new TypeError("discovery run is invalid");
    return {
      ...emptyQuery(),
      discovery_run_ids: [parseDiscoveryRunId(selector.discovery_run_id)],
    };
  }
  if (selector.kind === "query") {
    return selector.query;
  }
  return null;
}

/** Expand concrete Literature selections for query/export without adding sibling versions. */
export async function selectLiteratures(
  service: SelectionService,
  selector: LiteratureSelector,
): Promise<LibrarySearchPage> {
  const query = selectorQuery(selector);
  if (query !== null) return searchAll(service, query);
  if (selector.kind === "literatures") {
    const ids = uniqueNonEmpty(selector.literature_ids, "literature_ids");
    const snapshot = service.targetedSnapshot
      ? await service.targetedSnapshot({ literature_ids: ids })
      : await searchAll(service, emptyQuery());
    const byId = new Map(
      snapshot.items.map((item) => [item.literature.literature_id, item]),
    );
    const items = ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new LiteratureNotFoundError();
      return item;
    });
    return {
      items,
      total_count: items.length,
      next_cursor: null,
    } as LibrarySearchPage;
  }
  if (
    selector.kind === "meta-literatures" ||
    selector.kind === "import-report"
  ) {
    const ids = uniqueNonEmpty(
      selector.meta_literature_ids,
      "meta_literature_ids",
    );
    const all = service.targetedSnapshot
      ? await service.targetedSnapshot({ meta_literature_ids: ids })
      : await searchAll(service, emptyQuery());
    const byMeta = new Map<MetaLiteratureId, typeof all.items>();
    for (const id of ids) byMeta.set(id, []);
    for (const item of all.items) {
      const group = byMeta.get(item.literature.meta_literature_id);
      if (group)
        byMeta.set(item.literature.meta_literature_id, [...group, item]);
    }
    if ([...byMeta.values()].some((items) => items.length === 0))
      throw new Error("selector MetaLiterature was not found");
    const items = ids.flatMap((id) => byMeta.get(id)!);
    return { items, total_count: items.length, next_cursor: null };
  }
  throw new TypeError("selector kind is unsupported");
}

/** Completion scopes select Metas; their full version membership must share the matching snapshot. */
export async function selectCompletionLiteratures(
  service: Pick<LiteratureQueryService, "search" | "selectionSnapshot"> &
    Partial<Pick<LiteratureQueryService, "targetedSnapshot">>,
  selector: LiteratureSelector,
): Promise<LibrarySearchPage> {
  const query = selectorQuery(selector);
  if (query === null) return selectLiteratures(service, selector);
  const snapshot = await service.selectionSnapshot(query);
  const groups = new Map<
    MetaLiteratureId,
    (typeof snapshot.members)[number][]
  >();
  for (const item of snapshot.matches) {
    const meta = item.literature.meta_literature_id;
    if (!groups.has(meta)) groups.set(meta, []);
  }
  for (const item of snapshot.members)
    groups.get(item.literature.meta_literature_id)?.push(item);
  const items = Object.freeze([...groups.values()].flat());
  return Object.freeze({ items, total_count: items.length, next_cursor: null });
}
