import {
  candidate,
  invalid,
  type SourceCandidate,
} from "../../acquisition/sources/locators.js";
import { services } from "./definition.js";
export function europePmcPdf(identifier: string): SourceCandidate {
  if (!/^PMC\d+$/iu.test(identifier)) invalid();
  return candidate(
    "europe-pmc",
    `${services["europe-pmc-pdf"].endpoint}/articles/${identifier.toUpperCase()}?pdf=render`,
    "pdf",
    null,
    ["europe-pmc-identifier"],
  );
}
