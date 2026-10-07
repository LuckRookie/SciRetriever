import {
  candidate,
  invalid,
  type SourceCandidate,
} from "../../acquisition/sources/locators.js";
import { services } from "./definition.js";
export function arxivPdf(
  identifier: string,
  version?: string,
): SourceCandidate {
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/iu.test(identifier))
    invalid();
  const normalizedVersion =
    version === undefined
      ? null
      : /^v\d+$/u.test(version)
        ? version
        : invalid();
  const value = identifier.replace(/v\d+$/u, "");
  return candidate(
    "arxiv",
    `${services["arxiv-pdf"].endpoint}/pdf/${value}${normalizedVersion ?? ""}.pdf`,
    "pdf",
    normalizedVersion,
    ["arxiv-identifier"],
  );
}
