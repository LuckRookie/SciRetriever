import {
  ContractValidationError,
  parseIdentifier,
  parseLiteratureId,
  type Identifier,
  type LiteratureId,
} from "./index.js";
import { tagRecord } from "./tags.js";
/** A bounded public literature read: no body, authors, assets or derived state. */
export interface LiteratureBibliographySummary {
  readonly literature_id: LiteratureId;
  readonly identifiers: readonly Identifier[];
  readonly title: string | null;
  readonly year: number | null;
}
export function parseLiteratureBibliographySummary(
  value: unknown,
): LiteratureBibliographySummary {
  const r = tagRecord(value, ["literature_id", "identifiers", "title", "year"]);
  if (
    !Array.isArray(r.identifiers) ||
    (r.title !== null && typeof r.title !== "string") ||
    (r.year !== null &&
      (typeof r.year !== "number" ||
        !Number.isInteger(r.year) ||
        r.year < 1 ||
        r.year > 9999))
  )
    throw new ContractValidationError();
  return {
    literature_id: parseLiteratureId(r.literature_id),
    identifiers: r.identifiers.map((item) => parseIdentifier(item)),
    title: r.title as string | null,
    year: r.year as number | null,
  };
}
