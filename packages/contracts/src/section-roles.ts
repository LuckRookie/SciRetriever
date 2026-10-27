import {
  ARCHIVE_SECTION_ROLES,
  type ArchiveSectionRole,
  ContractValidationError,
} from "./index.js";
export const MAIN_SECTION_ROLES = [
  "front-matter",
  "abstract",
  "keywords",
  "introduction",
  "methods",
  "results",
  "discussion",
  "results-discussion",
  "conclusion",
  "acknowledgements",
  "references",
  "appendix",
  "body",
] as const;
export const SUPPLEMENTARY_SECTION_ROLES = [
  "si-methods",
  "si-characterization",
  "si-computation",
  "si-tables",
  "si-figures",
  "si-references",
  "body",
] as const;
export type MainSectionRole = (typeof MAIN_SECTION_ROLES)[number];
export type SupplementarySectionRole =
  (typeof SUPPLEMENTARY_SECTION_ROLES)[number];
export type SectionRole =
  | MainSectionRole
  | SupplementarySectionRole
  | ArchiveSectionRole;
export type DocumentPartRole = "main" | "supplementary";
export function parseSectionRole(
  value: unknown,
  part?: DocumentPartRole,
): SectionRole {
  const values: readonly string[] =
    part === "main"
      ? MAIN_SECTION_ROLES
      : part === "supplementary"
        ? SUPPLEMENTARY_SECTION_ROLES
        : [
            ...MAIN_SECTION_ROLES,
            ...SUPPLEMENTARY_SECTION_ROLES,
            ...ARCHIVE_SECTION_ROLES,
          ];
  if (typeof value !== "string" || !values.includes(value))
    throw new ContractValidationError();
  return value as SectionRole;
}
