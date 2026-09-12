import type { LiteratureSearchItem } from "@sciretriever/contracts";
import {
  exportBibliographyBatch,
  type BibliographyFormat,
} from "../literature/bibliography.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { selectLiteratures, type LiteratureSelector } from "./selectors.js";

export type BibliographyExportSelector = Extract<
  LiteratureSelector,
  | { readonly kind: "discovery-run" }
  | { readonly kind: "query" }
  | { readonly kind: "meta-literatures" }
  | { readonly kind: "literatures" }
>;

export interface PreparedBibliographyExport {
  readonly format: BibliographyFormat;
  readonly selected_literature_ids: readonly string[];
  readonly bytes: Uint8Array;
}

export class BibliographyExportError extends Error {
  readonly code = "bibliography-export" as const;
  constructor() {
    super("bibliography export failed");
    this.name = "BibliographyExportError";
  }
}

const ROLE_ORDER = new Map([
  ["published", 0],
  ["accepted-manuscript", 1],
  ["preprint", 2],
  ["other", 3],
] as const);

function compareRepresentatives(
  left: LiteratureSearchItem,
  right: LiteratureSearchItem,
): number {
  return (
    ROLE_ORDER.get(left.literature.version_role)! -
      ROLE_ORDER.get(right.literature.version_role)! ||
    (left.literature.literature_id < right.literature.literature_id
      ? -1
      : left.literature.literature_id > right.literature.literature_id
        ? 1
        : 0)
  );
}

function representatives(
  items: readonly LiteratureSearchItem[],
): readonly LiteratureSearchItem[] {
  const groups = new Map<string, LiteratureSearchItem[]>();
  for (const item of items) {
    const metaId = item.literature.meta_literature_id;
    const group = groups.get(metaId);
    if (group) group.push(item);
    else groups.set(metaId, [item]);
  }
  return [...groups.values()].map(
    (group) => [...group].sort(compareRepresentatives)[0]!,
  );
}

/** Read and encode one complete SQLite snapshot; query/meta scopes emit one representative per work. */
export async function prepareBibliographyExport(
  library: Pick<LiteratureQueryService, "search">,
  selector: BibliographyExportSelector,
  format: BibliographyFormat,
): Promise<PreparedBibliographyExport> {
  const page = await selectLiteratures(library, selector);
  if (page.items.length === 0) throw new BibliographyExportError();
  const selected =
    selector.kind === "literatures" ? page.items : representatives(page.items);
  const bytes = exportBibliographyBatch(selected, format);
  return Object.freeze({
    format,
    selected_literature_ids: Object.freeze(
      selected.map((item) => item.literature.literature_id),
    ),
    bytes,
  });
}
