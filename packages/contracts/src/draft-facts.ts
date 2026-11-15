import { parseAssetId } from "./index.js";
import { parseTextLevel, type TextLevel } from "./draft-document.js";
import { tagRecord, tagInteger } from "./tags.js";
import { ContractValidationError } from "./index.js";

export interface DraftFacts {
  readonly differs_segments: number;
  readonly differences: number;
  readonly image_only_pages: number;
  readonly citing_results: number;
  readonly unfound_citations: number;
}
export interface LiteratureDefaultText {
  readonly document_version_id: string;
  readonly text_level: TextLevel;
  readonly draft_facts: DraftFacts | null;
}
export const DRAFT_FACT_SORT_FIELDS = {
  "draft-differences-desc": ["differs_segments", "differences"],
  "image-only-pages-desc": ["image_only_pages"],
  "citing-results-desc": ["citing_results"],
  "unfound-citations-desc": ["unfound_citations"],
} as const satisfies Readonly<Record<string, readonly (keyof DraftFacts)[]>>;
export const DRAFT_FACT_SORTS = Object.keys(
  DRAFT_FACT_SORT_FIELDS,
) as (keyof typeof DRAFT_FACT_SORT_FIELDS)[];
export function draftSortFields(
  sort: string,
): readonly (keyof DraftFacts)[] | undefined {
  return Object.hasOwn(DRAFT_FACT_SORT_FIELDS, sort)
    ? DRAFT_FACT_SORT_FIELDS[sort as keyof typeof DRAFT_FACT_SORT_FIELDS]
    : undefined;
}
export function parseDraftFacts(value: unknown): DraftFacts {
  const r = tagRecord(value, [
    "differs_segments",
    "differences",
    "image_only_pages",
    "citing_results",
    "unfound_citations",
  ]);
  return {
    differs_segments: tagInteger(r.differs_segments),
    differences: tagInteger(r.differences),
    image_only_pages: tagInteger(r.image_only_pages),
    citing_results: tagInteger(r.citing_results),
    unfound_citations: tagInteger(r.unfound_citations),
  };
}
export function parseLiteratureDefaultText(
  value: unknown,
): LiteratureDefaultText {
  const r = tagRecord(value, [
      "document_version_id",
      "text_level",
      "draft_facts",
    ]),
    level = parseTextLevel(r.text_level);
  if ((level === "draft") !== (r.draft_facts !== null))
    throw new ContractValidationError();
  return {
    document_version_id: parseAssetId(r.document_version_id),
    text_level: level,
    draft_facts: r.draft_facts === null ? null : parseDraftFacts(r.draft_facts),
  };
}
