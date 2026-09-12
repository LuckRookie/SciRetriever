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

/** Expand the six legacy selectors without truncating or changing explicit order. */
export async function selectLiteratures(
  service: Pick<LiteratureQueryService, "search">,
  selector: LiteratureSelector,
): Promise<LibrarySearchPage> {
  if (!selector || typeof selector !== "object")
    throw new TypeError("selector is invalid");
  if (selector.kind === "all-pending") {
    return searchAll(service, {
      ...emptyQuery(),
      statuses: ["UNREVIEWED", "ASSET_READY"],
    });
  }
  if (selector.kind === "discovery-run") {
    if (!selector.discovery_run_id.trim())
      throw new TypeError("discovery run is invalid");
    return searchAll(service, {
      ...emptyQuery(),
      discovery_run_ids: [parseDiscoveryRunId(selector.discovery_run_id)],
    });
  }
  if (selector.kind === "query") {
    return searchAll(service, selector.query);
  }
  if (selector.kind === "literatures") {
    const ids = uniqueNonEmpty(selector.literature_ids, "literature_ids");
    const snapshot = await searchAll(service, emptyQuery());
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
    const all = await searchAll(service, emptyQuery());
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
